# Apresentação da Agenda Tatico Assis

Use uma base de exemplo para criar pedidos, mensagens e visitas em sala. No [site público](https://lucas.grupo-04.sd.ufersa.dev.br/), mostre a capa, a separação entre cliente e profissional e, se necessário, consulte o pedido existente na conta de apresentação. A [API pública](https://api.lucas.grupo-04.sd.ufersa.dev.br/saude) tem endereço próprio.

## Os quatro requisitos

| Requisito | Como o projeto atende | Evidência | Como mostrar em sala |
| --- | --- | --- | --- |
| Três camadas | React apresenta formulários e pedidos. NestJS valida chamadas e aplica as regras. PostgreSQL guarda os registros. O Prisma é usado pela API para consultas, transações e migrações. | Código em [frontend/src/main.tsx](../frontend/src/main.tsx), [backend/src/main.ts](../backend/src/main.ts), [backend/src/db.ts](../backend/src/db.ts) e [schema.prisma](../backend/prisma/schema.prisma). | Abra o formulário, siga a requisição no navegador e mostre o relacionamento no schema. |
| API orientada a recursos | O cliente cria e consulta pedidos. O titular solicita informações e cria ou remarca visitas associadas aos pedidos. | Código dos controladores em [main.ts](../backend/src/main.ts), [rotas e respostas](api.md) e [teste isolado de atendimento](../backend/test/e2e.mjs). | Veja `POST /pedidos`, `POST /visitas` e `GET /pedidos/:id` no exemplo abaixo. |
| DNS separado | Dois registros A no Route 53, cada um com TTL de 60 s, apontam para o mesmo IP elástico da EC2. Caddy termina HTTPS e encaminha pelo nome do domínio. | Verificação AWS e pública em 25/11/2026. Configuração em [Caddyfile](../deploy/Caddyfile) e [compose.publicacao.yaml](../compose.publicacao.yaml). | Mostre os dois registros no Route 53, a página pública e `/saude` aberto no domínio da API. |
| Autenticação e autorização | O JWT identifica a conta e a sessão. A API verifica a sessão no banco e aplica o papel, o UUID do titular e a propriedade do pedido. | Código em [main.ts](../backend/src/main.ts), [testes isolados de segurança](../backend/test/seguranca.mjs) e [de profissionais](../backend/test/profissionais.mjs). Uma leitura pública de `/pedidos` sem sessão recebe 401. | Na base isolada, compare o próprio pedido, o pedido de outro cliente (404) e a agenda chamada por cliente (403). Mostre o titular autorizado na agenda. |

## Do pedido à visita

Exemplo fictício em uma base descartável. Ana escolhe **Pedir atendimento**, cria uma conta com e-mail e senha, guarda o código privado e continua no formulário. Seleciona **Topografia** e preenche município, endereço fictício, referência de acesso e descrição.

| Tela e ação | Chamada e permissão | Regra, gravação e resposta |
| --- | --- | --- |
| Cliente envia o formulário | `POST /pedidos`, sessão de cliente | NestJS valida os campos. O serviço grava `Pedido` com `clienteId` extraído da sessão e situação `RECEBIDO`. O HTTP 201 devolve o pedido, e o React abre **Meus pedidos**. |
| Titular abre **Pedidos** | `GET /pedidos`, sessão do titular | A API valida papel `ENGENHEIRO` e UUID configurado. A lista pode ser filtrada por município ou comunidade. |
| Titular pergunta e Ana responde | `POST /pedidos/:id/informacoes` para o titular. `POST /pedidos/:id/respostas` para a dona do pedido. | O serviço valida a situação e grava a mensagem e a nova situação na mesma transação. |
| Titular marca uma visita | `POST /visitas`, sessão do titular | A API exige horário futuro no fuso de Brasília. Em uma transação, cria a visita e marca o pedido como `MARCADO`. Retorna HTTP 201. Se outra visita ocupar o horário, devolve 409 e a transação é desfeita. |
| Ana volta a **Meus pedidos** | `GET /pedidos` ou `GET /pedidos/:id`, sessão de cliente | O filtro `clienteId` limita o resultado à conta de Ana. A resposta inclui visita e mensagens. O React mostra o horário de Brasília no cartão. |

Em cada chamada privada, o frontend envia `Authorization: Bearer …`. A API verifica assinatura, validade e a linha de sessão no banco. Se a senha inicial precisar ser trocada, o painel fica bloqueado até a troca. Ao sair, a sessão é revogada.

## Banco e infraestrutura

- `Conta.id` é o UUID usado em `Pedido.clienteId`. Uma conta pode ter vários pedidos e sessões em `SessaoAcesso.contaId`.
- `Mensagem.pedidoId` liga várias mensagens ao pedido, com autor, texto e data.
- `Visita.pedidoId` é único, garantindo no máximo uma visita por pedido. `Visita.horario` também é único. O PostgreSQL arbitra duas reservas simultâneas e a API traduz o conflito em HTTP 409.
- `PerfilProfissional.contaId` liga o perfil à conta. `TokenEmail` guarda o resumo do token e a validade de 20 minutos. O consumo e a alteração correspondente ocorrem na mesma transação.
- Route 53 resolve os nomes. O IP elástico mantém o endereço da EC2 estável. A EC2 executa os contêineres, e Caddy trata HTTPS e escolhe entre o Nginx que serve React e o NestJS. Docker Compose descreve os serviços, as redes e o volume persistente do PostgreSQL. API e banco compartilham uma rede interna dedicada.

Consulta somente de leitura para uma base fictícia, usando os nomes reais do schema. Uma visita às 13h de Brasília em 3 de fevereiro de 2031 aparece como `2031-02-03 13:00` na coluna final.

```sql
SELECT p.id, p.servico, p.situacao,
       v.horario AT TIME ZONE 'America/Sao_Paulo' AS visita_brasilia
FROM "Pedido" p
JOIN "Conta" c ON c.id = p."clienteId"
LEFT JOIN "Visita" v ON v."pedidoId" = p.id
WHERE c.email = 'ana@example.test'
ORDER BY p."criadoEm" DESC;
```

## Roteiro falado de três minutos

**0:00–1:00.** “A Agenda organiza pedidos e visitas técnicas. O React mostra a capa, o formulário e os cartões. Vou entrar como cliente na base de exemplo e pedir Topografia. No navegador, o formulário vira um POST para a API em outro domínio. O Route 53 aponta os dois nomes para o mesmo IP elástico. Na EC2, Caddy recebe HTTPS e distingue qual serviço deve responder.”

**1:00–2:00.** “A API NestJS verifica o JWT e a sessão no PostgreSQL. Ela usa o UUID da sessão para gravar quem é o dono do pedido. O Prisma executa a gravação e devolve o pedido ao React. Um cliente diferente não encontra esse pedido nem pela API. O titular tem um UUID configurado e consegue listar e tratar os pedidos.”

**2:00–3:00.** “No painel, vou marcar uma visita futura. A API converte a hora de Brasília e grava a visita e a situação do pedido juntas. O banco exige horário único. Se duas reservas concorrerem, uma recebe conflito. Voltando à conta da cliente, a consulta traz a visita no cartão. Aqui estão as três camadas, os recursos da API, o DNS separado e o controle de acesso.”

## Cinco perguntas prováveis

1. **O que impede um cliente de abrir o pedido de outra pessoa?** A API restringe a consulta pelo UUID do pedido e pelo `clienteId` da sessão. Um cliente diferente recebe 404, mesmo chamando a API diretamente.
2. **Por que dois domínios se o IP é o mesmo?** Cada nome representa um serviço. Caddy usa o domínio da requisição para encaminhar ao contêiner correto.
3. **O que acontece se duas reservas escolherem a mesma hora?** O índice único do PostgreSQL aceita uma. A outra transação é revertida e a API devolve 409.
4. **Por que verificar a sessão depois de validar o JWT?** A consulta permite revogar imediatamente o acesso no logout ou na troca de senha enquanto o JWT ainda estaria dentro da validade.
5. **Onde o Prisma entra?** Na camada da API. O schema define os modelos e as migrações, e o cliente Prisma executa as consultas e transações no PostgreSQL.

## Uso comercial

O envio acadêmico usa `onboarding@resend.dev` e restringe os links por e-mail à caixa autorizada. O cadastro direto de cliente funciona independentemente desse envio. Para oferecer os links de e-mail a outros destinatários, configure no Resend um remetente de domínio verificado e retire a restrição acadêmica. Para operação contínua, planeje hospedagem fora do AWS Academy, backups e monitoramento. Consulte [o guia de operação](operacao-aws.md).
