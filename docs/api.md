# Referência da API

Base pública da API em [api.lucas.grupo-04.sd.ufersa.dev.br](https://api.lucas.grupo-04.sd.ufersa.dev.br/saude). Em execução local, use `http://localhost:3000`. Os caminhos a seguir são relativos à base.

## Sessão

`POST /auth/login` aceita `senha` e exatamente um identificador, `email` ou `celular`. Em caso de sucesso devolve `conta`, `token` e `expiraEm`. O frontend guarda a resposta em `sessionStorage` e envia o JWT nas chamadas protegidas. Exemplo de cabeçalho com um marcador fictício:

```http
Authorization: Bearer <JWT_DA_SESSAO>
Content-Type: application/json
```

O token dos links de e-mail é enviado no JSON das operações de confirmação. O navegador lê o fragmento do link e o remove da barra de endereço. A API consome o token em transação e verifica a finalidade e a validade de 20 minutos. [Cliente HTTP e leitura dos links](../frontend/src/main.tsx) · [Guard da API](../backend/src/main.ts) · [Tokens de e-mail](../backend/src/email.ts).

## Saúde e autenticação

| Método e caminho | Quem pode chamar | Respostas relevantes |
| --- | --- | --- |
| `GET /saude` | Público | **200** com `{"ok":true}` após testar a conexão com o PostgreSQL. |
| `GET /auth/recursos` | Público | **200** com `emailDisponivel`. Quando há envio e titular configurados, inclui `conviteProfissionalDisponivel: true`. |
| `POST /auth/cadastro` | Público | **202** com mensagem genérica. Recebe `nome` e `email`. **503** sem envio configurado. |
| `POST /auth/confirmar-email` | Público com token de cadastro | **201** com a sessão de cliente. **400** para token inválido, expirado ou usado. **409** se houver conflito com conta ou endereço reservado. |
| `POST /auth/login` | Público | **201** com sessão. **400** para identificadores ausentes ou incompatíveis. **401** para credenciais incorretas. **429** ao exceder tentativas. |
| `POST /auth/sair` | Conta com sessão válida | **204** após revogar a sessão. **401** para sessão ausente ou inválida. |
| `POST /auth/vincular-email` | Cliente ou profissional autorizado com sessão | **202** após enviar o link. **409** se a conta já tiver e-mail. **503** se o envio estiver indisponível. |
| `POST /auth/confirmar-vinculo` | Conta que solicitou o vínculo, com sessão ativa e token | **201** com `conta`. **400** se o token for inválido ou de outra conta. **409** para conflito de vínculo. |
| `POST /auth/recuperacao` | Público | **202** com a mesma mensagem para endereços existentes e desconhecidos. **503** sem envio configurado. |
| `POST /auth/redefinir-senha` | Público com token de recuperação | **204** após salvar a senha e revogar sessões. **400** para token inválido, expirado ou usado. |
| `POST /auth/convite-profissional` | Público | **202** com mensagem genérica. Só envia ao endereço autorizado quando o titular selecionado está sem e-mail vinculado e o envio está disponível. Pode devolver **429** por limite de IP. |
| `POST /auth/ativar-profissional` | Público com convite do titular selecionado | **204** após vincular o e-mail, salvar a senha e revogar as sessões da conta. **400** para convite inválido, **403** sem titular e **409** se o e-mail pertencer a outra conta. |

As confirmações de cadastro, recuperação e ativação recebem `token` e `senha` de 15 a 128 caracteres. A confirmação de vínculo recebe apenas `token`. Consulte as [validações de entrada](../backend/src/dto.ts) e os [testes de autenticação](../backend/test/seguranca.mjs).

## Perfil profissional

| Método e caminho | Quem pode chamar | Respostas relevantes |
| --- | --- | --- |
| `GET /profissionais/publico` | Público | **200** com o perfil autorizado para a capa ou `{"perfil":null}`. |
| `GET /profissionais/meu-perfil` | Profissional autorizado | **200** com o perfil associado à conta ou `{"perfil":null}`. |
| `POST /profissionais/meu-perfil` | Profissional autorizado | **201** com o perfil salvo. **400** para campos inválidos. |

## Pedidos e visitas

| Método e caminho | Quem pode chamar | Respostas relevantes |
| --- | --- | --- |
| `GET /pedidos` | Cliente para os próprios pedidos, profissional autorizado para todos | **200** com lista, aceita filtros `municipio` e `comunidade`. |
| `GET /pedidos/:id` | Dono do pedido ou profissional autorizado | **200** com pedido, mensagens e visita. **404** para pedido inexistente ou de outro cliente. |
| `POST /pedidos` | Cliente | **201** com o pedido em `RECEBIDO`. **400** para dados inválidos. |
| `POST /pedidos/:id/informacoes` | Profissional autorizado | **201** com pedido em `INFORMACOES`. Recebe `texto`. |
| `POST /pedidos/:id/respostas` | Cliente dono do pedido em `INFORMACOES` | **201** com pedido em `RECEBIDO`. Recebe `texto`. **404** se o pedido for de outro cliente. |
| `POST /pedidos/:id/conclusao` | Profissional autorizado | **201** com pedido em `CONCLUIDO`. **409** se já estiver concluído. |
| `POST /visitas` | Profissional autorizado | **201** com pedido em `MARCADO`. **400** para data ou hora inválida. **409** para horário ocupado ou estado incompatível. |
| `POST /visitas/remarcacao` | Profissional autorizado | **201** com pedido e visita atualizados. Recebe também `horarioAnterior` em ISO 8601. **409** para horário ocupado, visita alterada ou estado incompatível. |
| `GET /visitas` | Profissional autorizado | **200** com visitas de pedidos em `MARCADO`, ordenadas por horário. |

Rotas protegidas devolvem **401** sem sessão válida. Com sessão válida, um cliente que envie um corpo válido a `POST /visitas` recebe **403**. Ao tentar consultar o UUID de outro cliente, recebe **404**, assim como para um pedido inexistente. Os três casos são cobertos pelo [teste de integração](../backend/test/e2e.mjs). Operações sobre um pedido existente também podem devolver **409** quando o estado mudou desde a leitura.

## Exemplo de solicitação e agendamento

Com a sessão do cliente, envie `POST /pedidos` com o seguinte JSON.

```json
{
  "servico": "Topografia",
  "municipio": "Mossoró",
  "comunidade": "Sítio fictício",
  "local": "Porteira depois do galpão",
  "descricao": "Levantamento de terreno"
}
```

Recorte da resposta **201**. A API também devolve os demais campos do pedido e os dados da conta cliente associados a ele.

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "servico": "Topografia",
  "situacao": "RECEBIDO",
  "mensagens": [],
  "visita": null
}
```

Com a sessão do profissional autorizado, envie `POST /visitas`. Substitua o UUID pelo retornado pela API e selecione uma data futura e uma hora livre de Brasília.

```json
{
  "pedidoId": "11111111-1111-4111-8111-111111111111",
  "dia": "2031-02-03",
  "hora": "13:00"
}
```

Recorte da resposta **201**. O horário `16:00Z` corresponde a `13:00` em Brasília no exemplo. O dono do pedido recebe a mesma situação e visita ao consultar `GET /pedidos/:id`.

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "situacao": "MARCADO",
  "visita": {
    "id": "22222222-2222-4222-8222-222222222222",
    "pedidoId": "11111111-1111-4111-8111-111111111111",
    "horario": "2031-02-03T16:00:00.000Z"
  }
}
```
