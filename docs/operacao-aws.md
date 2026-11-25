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

4. No release, prepare `imagens.yaml` com `services.api.image` e `services.web.image` iguais às tags compiladas. Na publicação acadêmica, mantenha `services.api.environment.AGENDA_OWNER_EMAIL` vazio e preserve a seleção da conta de demonstração em `AGENDA_OWNER_ID`. Use o arquivo de ambiente privado da publicação. No host verificado, ele fica em `/opt/agenda/.env`.

   ```sh
   compose_release() {
     docker compose --env-file /opt/agenda/.env -p agenda \
       -f compose.yaml -f compose.publicacao.yaml -f imagens.yaml "$@"
   }

   compose_release config --quiet
   compose_release up -d --no-deps --no-build --wait api web
   ```

5. Compare as revisões dos contêineres com `origin/main`. Confira o frontend, a API e a demonstração antes de considerar a publicação concluída.

   ```sh
   docker inspect agenda-web-1 agenda-api-1 \
     --format '{{.Name}} {{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
   curl -fsS -o /dev/null -w 'Site HTTPS %{http_code}\n' https://lucas.grupo-04.sd.ufersa.dev.br/
   curl -fsS https://api.lucas.grupo-04.sd.ufersa.dev.br/saude
   curl -fsS https://api.lucas.grupo-04.sd.ufersa.dev.br/auth/recursos
   ```

Na verificação de 24/11/2026, ambos os contêineres reportaram `51d1c8960f786648369cc57ef0a3dd64b3311084`, os dois domínios responderam HTTP 200 e `/saude` retornou `{"ok":true}`. `/auth/recursos` retornou `{"emailDisponivel":false}`. A seta **Voltar** e o acesso da demonstração a **Pedidos** e **Agenda** foram verificados no site público.

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

O [Dockerfile da API](../backend/Dockerfile) executa `prisma migrate deploy` antes de iniciar o NestJS. Em um banco isolado, pode-se restaurar o dump e aplicar as migrações com a nova imagem. Consulte `_prisma_migrations` e compare as contagens e os vínculos de contas, pedidos e visitas. As [quatro migrações](../backend/prisma/migrations) criam a estrutura inicial, adicionam sessões, registram o perfil profissional e acrescentam contas por e-mail e tokens.

A publicação anterior de 24/11/2026 registrou backup e comparação de contagens após migração. A suíte local [profissionais.mjs](../backend/test/profissionais.mjs) confirmou a atualização a partir das três primeiras migrações com dados fictícios. Uma cópia da base foi restaurada na prévia isolada. O PR #8 não acrescentou migração.

## Retorno

A publicação de `51d1c89` manteve as imagens e os arquivos Compose anteriores como referência de retorno. Se houver falha após a troca, recupere a configuração anterior dos contêineres, confirme a compatibilidade do schema e reaplique o projeto `agenda` com as tags anteriores dos serviços `api` e `web`. Repita as checagens de HTTPS, saúde e login. O retorno foi previsto no procedimento de publicação. Não há registro de execução de um rollback ou de restauração sobre o banco de produção. Se uma migração exigir restauração, ensaie antes no banco isolado e preserve os pedidos recebidos após o backup.

## Contas acadêmicas

Em uma sessão administrativa privada, consulte `DEMO_CLIENTE_A_SENHA` e `DEMO_CLIENTE_B_SENHA` em `/opt/agenda/.demonstracao.env`, e `DEMO_PROF_SENHA` em `/opt/agenda/.profissional-demonstracao.env`. Se for necessário reprovisionar os dois clientes, carregue o arquivo privado e execute o [seed acadêmico](../backend/src/demonstracao.ts). Ele cria somente as contas fictícias de cliente.

```sh
set -a
. /opt/agenda/.demonstracao.env
set +a
docker exec -e DEMO_CLIENTE_A_SENHA -e DEMO_CLIENTE_B_SENHA agenda-api-1 npm run seed:demonstracao
```

A ativação definitiva depende de um remetente verificado em `EMAIL_FROM`, acesso de envio via `RESEND_API_KEY` e teste de entrega real em uma caixa autorizada. Depois disso, configure na prévia `AGENDA_OWNER_ID` com a conta preservada e `AGENDA_OWNER_EMAIL` com o endereço do titular. Confirme com ele o acesso a **Pedidos** e **Agenda** antes de trocar o titular em produção. A demonstração usa a configuração confirmada de 24/11/2026 enquanto essa validação estiver pendente. [Variáveis do projeto](../.env.example) · [API de envio do Resend](https://resend.com/docs/api-reference/emails/send-email).
