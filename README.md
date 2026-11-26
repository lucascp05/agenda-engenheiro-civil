# Agenda da Tatico Assis

A Agenda reúne pedidos de atendimento para topografia, CAR, serviços relacionados ao INCRA e projetos. O cliente descreve a necessidade e informa como chegar ao imóvel. A conta profissional autorizada analisa os pedidos, pede informações quando necessário e agenda a visita. O cliente acompanha o andamento e consulta a confirmação em **Meus pedidos**.

Projeto individual de Sistemas Distribuídos da UFERSA, de **Lucas Assis da Costa Pereira**, com apresentação em **27/11/2026**.

- [Site público](https://lucas.grupo-04.sd.ufersa.dev.br/)
- [API pública, verificação de saúde](https://api.lucas.grupo-04.sd.ufersa.dev.br/saude)

## Documentação

- [Guia de uso](docs/guia-de-uso.md) para abrir e acompanhar pedidos e operar a agenda.
- [Arquitetura](docs/arquitetura.md) para seguir os dados entre as três camadas.
- [Referência da API](docs/api.md) para consultar rotas, permissões e exemplos HTTP.
- [Operação na AWS](docs/operacao-aws.md) para publicar, verificar revisões e diagnosticar falhas.
- [Roteiro da apresentação](docs/apresentacao.md) com o caminho do pedido à visita, os requisitos e perguntas para revisão.

O cadastro público aceita nome, senha e e-mail ou celular com DDD. A conta pode ser usada imediatamente e o cliente recebe um código privado para recuperar o acesso. O Resend é necessário apenas para os fluxos opcionais que enviam links por e-mail.

## Executar localmente

Use Docker com Compose v2 e o motor do Docker em execução. Os comandos a seguir usam um shell compatível com Bash, como Git Bash no Windows. As portas locais 8080 e 3000 precisam estar livres. As imagens compilam a aplicação com Node.js 22.

1. Na raiz do repositório, execute `cp .env.example .env`.
2. Preencha `POSTGRES_PASSWORD` com caracteres seguros em URL e `JWT_SECRET` com pelo menos 32 caracteres. Para criar um profissional de teste, preencha `ENGINEER_NAME`, `ENGINEER_PHONE` e `ENGINEER_PASSWORD` com dados fictícios. O seed exige celular com DDD e 11 dígitos, com 9 após o DDD, e senha de 8 a 128 caracteres.
3. Suba os serviços e crie a conta profissional local.

   ```sh
   docker compose up -d --build --wait
   docker compose exec api npm run seed
   ```

4. Copie o `AGENDA_OWNER_ID` exibido para o `.env` e aplique a configuração da API.

   ```sh
   docker compose up -d --wait api
   curl -fsS http://localhost:3000/saude
   ```

5. Abra o [site local](http://localhost:8080). Entre na **Área do profissional** com as credenciais de teste ou use **Criar conta** com um e-mail ou celular fictício. Para testar somente os fluxos opcionais de envio de links, configure um receptor HTTP de teste em `EMAIL_TEST_URL`.

### Executar as suítes

Execute os comandos apenas em um banco descartável. As suítes iniciam instâncias isoladas da API e já incluem um receptor de e-mail simulado. A suíte profissional cria um schema separado, aplica as três migrações anteriores, insere dados fictícios e testa a atualização.

```sh
docker compose exec api npm test
docker compose exec api npm run test:seguranca
docker compose exec api npm run test:profissionais
```

Na validação local registrada para o fluxo do [PR #8](https://github.com/lucascp05/agenda-engenheiro-civil/pull/8), os três scripts npm passaram com PostgreSQL descartável e e-mail simulado. A execução dos mesmos scripts via Compose depende do motor Docker local. Veja as [suítes de integração](backend/test).

A suíte de atendimento verifica que o cliente consulta o pedido após sair e entrar novamente. A suíte de profissionais verifica a troca inicial de senha e o acesso a Pedidos e Agenda em uma conta fictícia, com o envio de e-mail desativado. A validação da entrega real requer um remetente verificado, a chave de envio e uma caixa de teste autorizada. [Procedimento de operação](docs/operacao-aws.md#validar-envio-de-e-mail).

## Apresentação de 27/11/2026

Prepare dois perfis de navegador para os clientes fictícios A e B e um terceiro para a conta do titular. Combine com o titular a troca inicial de senha antes da apresentação. Consulte [como entrar nas contas acadêmicas](docs/guia-de-uso.md#contas-de-demonstração) antes de compartilhar a tela. No painel **Rede**, mostre método, status e apenas os trechos necessários de requisição e resposta. Oculte senhas e cabeçalhos de autenticação.

| Tempo | Requisito do professor | Onde está implementado | Como demonstrar |
| --- | --- | --- | --- |
| 0:00–0:40 | DNS | Route 53 e [Caddyfile](deploy/Caddyfile) | Abra os dois domínios HTTPS e mostre `GET /saude` com **200**. Mostre os registros A no Route 53 se houver acesso ao console. |
| 0:40–1:25 | Três camadas | [React](frontend/src/main.tsx), [NestJS](backend/src/main.ts) e [Prisma/PostgreSQL](backend/prisma/schema.prisma) | Envie um pedido de **Topografia** pela interface. Use “Porteira depois do galpão” como referência. Siga o formulário, o serviço da API e o modelo `Pedido`. |
| 1:25–2:20 | API HTTP | [Controllers de pedidos e visitas](backend/src/main.ts) | Mostre o **201** de `POST /pedidos` no painel Rede. Marque uma visita futura com a conta profissional, mostre o **201** de `POST /visitas` e confira a confirmação no cliente em **Meus pedidos**. |
| 2:20–3:00 | Autenticação e autorização | [Guard e filtros por conta](backend/src/main.ts), [teste de integração](backend/test/e2e.mjs) | Mostre `GET /pedidos` sem sessão (**401**), `POST /visitas` com a sessão do cliente A e corpo válido (**403**) e `GET /pedidos/:id` com o cliente B e o UUID do pedido de A (**404**). |

### Evidências registradas

- **Produção em 25/11/2026, revisão `12adb921552d94543bb7adeca98b1d6e4be821e2` nos dois serviços.** Os dois domínios resolveram para o mesmo IPv4 e responderam em HTTPS. `GET /saude` retornou **200** com `{"ok":true}`. A API pública registrou um pedido e uma visita com contas acadêmicas, confirmou a remarcação após novo login do cliente e devolveu **401**, **403** e **404** nos cenários de autorização. O Chrome abriu **Trocar senha** no primeiro acesso do titular. Na mesma verificação, `GET /auth/recursos` retornou `{"emailDisponivel":false}`. [Respostas HTTP da publicação](docs/api.md#captura-na-api-pública) · [PR #10](https://github.com/lucascp05/agenda-engenheiro-civil/pull/10).
- **Validação local em 25/11/2026.** Os builds e as três suítes passaram com PostgreSQL descartável. O Chrome, em desktop e viewport de celular, percorreu cadastro com caixa simulada, reenvio, recuperação, login, pedido, confirmação da visita, remarcação, consulta e conclusão. O teste isolado de primeiro acesso verificou a troca obrigatória e a revogação das sessões anteriores. [Respostas HTTP capturadas](docs/api.md#captura-local-no-chrome).
- **Produção em 24/11/2026, revisão `51d1c8960f786648369cc57ef0a3dd64b3311084` nos dois serviços.** O site e a API responderam em HTTPS, `/saude` retornou `{"ok":true}`, e **Entrar → Voltar** retornou à capa em desktop e em viewport de celular. O profissional de demonstração entrou e abriu **Pedidos** e **Agenda**. A ativação, o cadastro e a recuperação por e-mail estavam desabilitados na publicação acadêmica.
- **Produção em 24/11/2026, verificação anterior na revisão `a48546ed28def5ef9761067ae9f529b22b17e05c`.** Um pedido fictício de topografia retornou **201** e foi conferido no PostgreSQL. A marcação retornou **201**, e o cliente viu a confirmação de **27/11/2026 às 13:00**, horário de Brasília. Os três cenários de autorização retornaram **401**, **403** e **404**, respectivamente. Essa evidência pertence à revisão anterior. O procedimento para repetir o fluxo está no [guia de uso](docs/guia-de-uso.md).
