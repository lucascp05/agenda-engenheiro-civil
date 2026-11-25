# Operação na AWS

## DNS e tráfego

Os dois registros A do Route 53 apontam para o IPv4 público da EC2 em `us-east-1`. O TTL registrado na verificação de 24/11/2026 era de 60 segundos. Caddy recebe HTTP e HTTPS na EC2, termina TLS e escolhe o serviço pelo nome do domínio.

| Domínio | Destino na rede Compose |
| --- | --- |
| [Site UFERSA](https://lucas.grupo-04.sd.ufersa.dev.br/) | `web:8080`. Nginx serve o bundle React. |
| [API UFERSA](https://api.lucas.grupo-04.sd.ufersa.dev.br/saude) | `api:3000`. NestJS atende a API HTTP. |

O navegador chama o domínio da API compilado em `VITE_API_URL`. Em publicação, `CORS_ORIGINS` contém a origem HTTPS do site. A API acessa `db:5432` pela rede interna. O PostgreSQL usa o volume persistente `pgdata`. As portas 8080 e 3000 também estão disponíveis no loopback da EC2 para diagnóstico. [Compose base](../compose.yaml) · [Configuração de publicação](../compose.publicacao.yaml) · [Caddyfile](../deploy/Caddyfile).

## Publicação de uma revisão

O procedimento verificado em 24/11/2026 usou AWS Systems Manager para operar a EC2 e o projeto Compose `agenda`. Frontend e API foram compilados na EC2 a partir do mesmo arquivo-fonte do GitHub, baixado pelo SHA completo e extraído em um diretório de release próprio. O banco, o proxy e a conta profissional de demonstração foram preservados.

1. Confirme a revisão de origem com `git fetch origin main` e `git rev-parse origin/main` no checkout administrativo. Confira a instância em `us-east-1` e a sessão do Learner Lab. Antes da mudança, use um comando de leitura via SSM, como `hostname` e `docker ps`.
2. Na EC2, inspecione as imagens ativas e os arquivos Compose registrados nos contêineres. Guarde a referência anterior e faça o [backup do banco](#backup). Baixe o arquivo-fonte da revisão completa do GitHub em um diretório separado.
3. Na raiz do release extraído, compile as duas imagens. Use o SHA real em `REVISAO` e o domínio existente da API em `VITE_API_URL`. Os valores abaixo são marcadores fictícios.

   ```sh
   REVISAO=sha-completo-da-revisao
   VITE_API_URL=https://api.example.test
   docker build --label "org.opencontainers.image.revision=$REVISAO" -t "agenda-academica-api:$REVISAO" backend
   docker build --label "org.opencontainers.image.revision=$REVISAO" \
     --build-arg "VITE_API_URL=$VITE_API_URL" -t "agenda-academica-web:$REVISAO" frontend
   ```

4. No release, prepare `imagens.yaml` com `services.api.image` e `services.web.image` iguais às tags compiladas. Preserve a seleção profissional durante a validação das imagens. Use o arquivo de ambiente privado da publicação. No host verificado, ele fica em `/opt/agenda/.env`.

   ```sh
   compose_release() {
     docker compose --env-file /opt/agenda/.env -p agenda \
       -f compose.yaml -f compose.publicacao.yaml -f imagens.yaml "$@"
   }

   compose_release config --quiet
   compose_release up -d --no-deps --no-build --wait api web
   ```

   Para uma revisão que muda a rede do banco, depois do backup e do ensaio isolado, execute também `compose_release up -d --no-deps --no-build --wait db` antes de atualizar a API. Use o mesmo projeto `agenda` para manter o volume `pgdata`. No retorno de uma mudança de rede, reaplique o banco e a API com a configuração anterior.

5. Compare as revisões dos contêineres com `origin/main`. Confira o frontend, a API e a demonstração antes de considerar a publicação concluída.

   ```sh
   docker inspect agenda-web-1 agenda-api-1 \
     --format '{{.Name}} {{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
   curl -fsS -o /dev/null -w 'Site HTTPS %{http_code}\n' https://lucas.grupo-04.sd.ufersa.dev.br/
   curl -fsS https://api.lucas.grupo-04.sd.ufersa.dev.br/saude
   curl -fsS https://api.lucas.grupo-04.sd.ufersa.dev.br/auth/recursos
   ```

Na verificação de 24/11/2026, ambos os contêineres reportaram `51d1c8960f786648369cc57ef0a3dd64b3311084`, os dois domínios responderam HTTP 200 e `/saude` retornou `{"ok":true}`. `/auth/recursos` retornou `{"emailDisponivel":false}`. A seta **Voltar** e o acesso da demonstração a **Pedidos** e **Agenda** foram verificados no site público.

Na publicação de 25/11/2026, ambos os contêineres reportaram `12adb921552d94543bb7adeca98b1d6e4be821e2`. O dump foi guardado na EC2 em diretório privado, com checksum SHA-256 conferido. A restauração isolada manteve 8 contas, 5 pedidos e 5 visitas, com os mesmos identificadores e vínculos antes e após a migração. O Chrome público confirmou o primeiro acesso do titular até **Trocar senha**. A API continuou sinalizando envio de e-mail indisponível após a publicação. [Evidências da API](api.md#captura-na-api-pública) · [PR #10](https://github.com/lucascp05/agenda-engenheiro-civil/pull/10).

### Diagnóstico e falha de publicação

- Se o SSM falhar, confirme o estado da EC2, a sessão do Learner Lab e a resposta de um comando de leitura. Uma identidade válida no STS pode continuar sem permissão para `ssm:SendCommand`. Registre a mensagem da AWS.
- Se a compilação falhar antes da troca, consulte `api-build.log` ou `web-build.log` no diretório do release. Se a troca falhar, confira o estado dos contêineres e os logs recentes com `docker ps` e `docker logs --tail 100 agenda-api-1`, `docker logs --tail 100 agenda-web-1` ou `docker logs --tail 100 agenda-proxy-1`.
- Se o domínio falhar, compare os registros A no Route 53 com o IP público da instância. Na EC2, consulte `http://127.0.0.1:3000/saude` e `http://127.0.0.1:8080/` para distinguir falhas nos serviços de falhas no caminho HTTPS. Preserve o volume do PostgreSQL durante o diagnóstico.

## Backup

Na EC2, foi verificado um dump em formato customizado com leitura do catálogo via `pg_restore -l`. Execute em diretório privado autorizado. A leitura do catálogo verifica a estrutura do arquivo. O ensaio de restauração é uma etapa própria.

```sh
umask 077
docker exec agenda-db-1 pg_dump -Fc -U agenda -d agenda > agenda-antes-do-deploy.dump
docker exec -i agenda-db-1 pg_restore -l < agenda-antes-do-deploy.dump
```

## Migração

O [Dockerfile da API](../backend/Dockerfile) executa `prisma migrate deploy` antes de iniciar o NestJS. Restaure o dump em um banco isolado e aplique as migrações com a nova imagem. Consulte `_prisma_migrations` e compare as contagens e os vínculos de contas, pedidos e visitas. As [migrações](../backend/prisma/migrations) incluem a coluna `Conta.trocarSenha`, cujo padrão é `false` para as contas existentes.

A publicação anterior de 24/11/2026 registrou backup e comparação de contagens após migração. A suíte local [profissionais.mjs](../backend/test/profissionais.mjs) confirmou a atualização a partir das três primeiras migrações com dados fictícios. Uma cópia da base foi restaurada na prévia isolada. O PR #8 não acrescentou migração.

## Retorno

A publicação de `51d1c89` manteve as imagens e os arquivos Compose anteriores como referência de retorno. Se houver falha após a troca, recupere a configuração anterior dos contêineres, confirme a compatibilidade do schema e reaplique o projeto `agenda` com as tags anteriores dos serviços `api` e `web`. Repita as checagens de HTTPS, saúde e login. O retorno foi previsto no procedimento de publicação. Não há registro de execução de um rollback ou de restauração sobre o banco de produção. Se uma migração exigir restauração, ensaie antes no banco isolado e preserve os pedidos recebidos após o backup.

## Contas acadêmicas

Em uma sessão administrativa privada, consulte `DEMO_CLIENTE_A_SENHA` e `DEMO_CLIENTE_B_SENHA` em `/opt/agenda/.demonstracao.env`. Se for necessário reprovisionar os dois clientes, carregue o arquivo privado e execute o [seed acadêmico](../backend/src/demonstracao.ts). Ele cria somente as contas fictícias de cliente. Desde a transição de 25/11/2026, a apresentação usa a conta do titular para administrar a agenda.

```sh
set -a
. /opt/agenda/.demonstracao.env
set +a
docker exec -e DEMO_CLIENTE_A_SENHA -e DEMO_CLIENTE_B_SENHA agenda-api-1 npm run seed:demonstracao
```

## Provisionar o titular

Confirme o identificador da conta profissional existente e ensaie o provisionamento e a troca de senha na prévia isolada. O [comando administrativo](../backend/src/titular.ts) usa `AGENDA_OWNER_ID`, `AGENDA_OWNER_EMAIL`, `AGENDA_OWNER_NAME` e `AGENDA_OWNER_PHONE`. Ele atualiza a conta pelo mesmo identificador, revoga suas sessões e exige a troca no próximo login. Uma conta já vinculada com outra credencial exige investigação prévia.

Na sessão administrativa privada, com a migração aplicada e as variáveis do titular definidas, forneça a senha inicial pela entrada padrão de `npm run provisionar:titular`. Leia o valor com entrada sem eco ou por um canal privado que faça o pipe diretamente. Mantenha a senha fora de argumentos, variáveis de ambiente, arquivos de configuração e logs. Em produção, confira o login até **Trocar senha** e deixe a alteração para o titular. Coordene a mudança com a apresentação se a demonstração usar o mesmo identificador.

No Bash, a função abaixo usa o `compose_release` definido no procedimento de publicação. Defina `AGENDA_OWNER_NAME` e `AGENDA_OWNER_PHONE` na sessão administrativa. O comando usa a seleção de titular e o e-mail da API em execução.

```bash
provisionar_titular() (
  set +x
  IFS= read -r -s -p 'Senha inicial do titular: ' senha_titular || exit 1
  printf '\n' >&2
  printf '%s' "$senha_titular" | compose_release exec -T \
    -e AGENDA_OWNER_NAME="$AGENDA_OWNER_NAME" \
    -e AGENDA_OWNER_PHONE="$AGENDA_OWNER_PHONE" \
    api npm run provisionar:titular
)
provisionar_titular
```

Compare o UUID da conta e os vínculos dos pedidos e visitas antes e depois do comando na cópia isolada. Se a conta já estiver vinculada, verifique primeiro o login pela **Área do profissional**. O provisionamento aceita repetir a mesma configuração enquanto a senha inicial continuar ativa.

## Validar envio de e-mail

Para o teste acadêmico com `onboarding@resend.dev`, defina `EMAIL_ACADEMIC_RECIPIENT` com a caixa da própria conta Resend e use uma chave restrita a envio. A API mantém `emailDisponivel: false` e anuncia `cadastroAcademicoDisponivel: true` quando o teste está configurado. Somente a caixa autorizada pode solicitar cadastro e confirmar a conta nesse modo. Para habilitar o cadastro geral, configure o remetente de um domínio verificado e remova `EMAIL_ACADEMIC_RECIPIENT`.

Configure `EMAIL_FROM` com o remetente de um domínio verificado no Resend e `RESEND_API_KEY` com acesso de envio no arquivo privado da publicação. Depois da troca da API, confira `/auth/recursos` e percorra cadastro e recuperação com uma caixa de teste autorizada. Confirme a chegada das mensagens e a abertura de cada link no domínio público. [Variáveis do projeto](../.env.example) · [API de envio do Resend](https://resend.com/docs/api-reference/emails/send-email).

Na checagem pública de 25/11/2026, as duas variáveis estavam ausentes no contêiner da API. `GET /auth/recursos` anunciou `emailDisponivel: false`, e uma solicitação válida de cadastro recebeu HTTP 503. No Chrome, tanto a 390 px quanto a 1280 px, a capa, o WhatsApp, Voltar e Avançar, o logo e o formulário profissional responderam. A entrega de confirmação, o reenvio e a recuperação precisam de uma caixa real autorizada para a validação pública.

## Uso contínuo após o AWS Academy

Para uso comercial, planeje a transferência para uma conta de infraestrutura durável, com domínio e DNS sob controle do titular, remetente verificado, renovação de certificados, monitoramento de disponibilidade e backups com restauração testada. Antes da transição, confirme que o titular abre **Pedidos** e **Agenda** com a própria senha e combine com ele e com a equipe da apresentação a data de encerramento do acesso de demonstração.
