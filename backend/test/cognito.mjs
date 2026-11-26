import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { AdminDeleteUserCommand, AdminInitiateAuthCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { PrismaClient } from '@prisma/client';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoJwtInvalidClientIdError, CognitoJwtInvalidTokenUseError, JwtInvalidSignatureError, ParameterValidationError } from 'aws-jwt-verify/error';
import { requisicoes } from './ambiente.mjs';
import senhaLocal from '../dist/senha.js';

const { COGNITO_USER_POOL_ID: pool, COGNITO_CLIENT_ID: cliente, COGNITO_CLIENTE_ALTERNATIVO: alternativo, COGNITO_PREVIA_URL: url, AGENDA_OWNER_ID: titularId } = process.env;
assert.ok(pool && cliente && alternativo && cliente !== alternativo && url && titularId);
assert.equal(new URL(url).hostname, '127.0.0.1');

test('Cognito real, migração, recuperação, logout e autorização na prévia', async t => {
  const db = new PrismaClient();
  const aws = new CognitoIdentityProviderClient({ region: pool.split('_')[0] });
  const contas = [titularId];
  t.after(async () => {
    try {
      const registros = await db.conta.findMany({ where: { id: { in: contas } } });
      for (const conta of registros) {
        if (conta.cognitoUsuario) await aws.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: conta.cognitoUsuario }));
      }
    } finally {
      await db.$disconnect();
      aws.destroy();
    }
  });
  const req = requisicoes(url);
  const senha = 'Senha fictícia da prévia ' + randomUUID();
  const hash = await senhaLocal.gerarHash(senha);
  const legado = await db.conta.create({ data: { nome: 'Cliente anterior', email: 'legado@example.test', hash } });
  const titular = await db.conta.create({ data: { id: titularId, papel: 'ENGENHEIRO', nome: 'Titular fictício', celular: '84991110000', hash, trocarSenha: true } });
  const outroProfissional = await db.conta.create({ data: { papel: 'ENGENHEIRO', nome: 'Outro profissional', email: 'outro@example.test', hash } });
  contas.push(legado.id, outroProfissional.id);
  const pedido = await db.pedido.create({ data: { clienteId: legado.id, servico: 'Topografia', municipio: 'Mossoró', local: 'Sítio de teste', descricao: 'Pedido anterior à primeira autenticação.' } });

  await req('/auth/login', { body: { email: legado.email, senha: 'Senha incorreta' }, status: 401 });
  assert.equal((await db.conta.findUniqueOrThrow({ where: { id: legado.id } })).cognitoSub, null);
  await req('/auth/contas', { body: { nome: 'Duplicata', email: legado.email, senha }, status: 409 });
  const sessao = await req('/auth/login', { body: { email: legado.email, senha } });
  assert.equal(sessao.conta.id, legado.id);
  const vinculo = await db.conta.findUniqueOrThrow({ where: { id: legado.id } });
  const verificador = CognitoJwtVerifier.create({ userPoolId: pool, clientId: cliente, tokenUse: 'access' });
  const claims = await verificador.verify(sessao.token);
  assert.equal(claims.iss, `https://cognito-idp.${pool.split('_')[0]}.amazonaws.com/${pool}`);
  assert.equal(claims.sub, vinculo.cognitoSub);
  assert.equal(claims.username, vinculo.cognitoUsuario);
  assert.equal(claims.client_id, cliente);
  assert.equal(claims.token_use, 'access');
  assert.equal((await req('/pedidos/' + pedido.id, { token: sessao.token })).cliente.id, legado.id);

  const [cabecalho, corpo, assinatura] = sessao.token.split('.');
  const corrompido = [cabecalho, corpo, (assinatura.startsWith('A') ? 'B' : 'A') + assinatura.slice(1)].join('.');
  await assert.rejects(verificador.verify(corrompido), JwtInvalidSignatureError);
  await req('/pedidos', { token: corrompido, status: 401 });
  const emissorErrado = [cabecalho, Buffer.from(JSON.stringify({ ...claims, iss: 'https://example.test' })).toString('base64url'), assinatura].join('.');
  await assert.rejects(verificador.verify(emissorErrado), ParameterValidationError);
  await req('/pedidos', { token: emissorErrado, status: 401 });
  const params = { USERNAME: vinculo.cognitoUsuario, PASSWORD: createHash('sha256').update(vinculo.cognitoUsuario).update('\0').update(senha).digest('hex') };
  const autenticar = ClientId => aws.send(new AdminInitiateAuthCommand({ UserPoolId: pool, ClientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: params }));
  const { AuthenticationResult: direto } = await autenticar(cliente);
  const { AuthenticationResult: outro } = await autenticar(alternativo);
  await assert.rejects(verificador.verify(direto.IdToken), CognitoJwtInvalidTokenUseError);
  await assert.rejects(verificador.verify(outro.AccessToken), CognitoJwtInvalidClientIdError);
  await req('/pedidos', { token: direto.IdToken, status: 401 });
  await req('/pedidos', { token: outro.AccessToken, status: 401 });
  await t.diagnostic(`Token AWS verificado. iss=${claims.iss} token_use=${claims.token_use} client_id=${claims.client_id}. Assinatura adulterada, emissor alterado, ID token e access token de outro cliente rejeitados.`);

  for (const identificador of [{ email: 'novo@example.test' }, { celular: '84991110001' }]) {
    const nova = await req('/auth/contas', { body: { ...identificador, nome: 'Cliente fictício', senha } });
    contas.push(nova.conta.id);
    assert.equal(nova.conta.papel, 'CLIENTE');
    const acesso = await req('/auth/login', { body: { ...identificador, senha } });
    assert.equal(acesso.conta.id, nova.conta.id);
    assert.deepEqual(await req('/pedidos', { token: acesso.token }), []);
    await req('/pedidos/' + pedido.id, { token: acesso.token, status: 404 });
    await req('/visitas', { token: acesso.token, status: 403 });
    const novaSenha = senha + ' recuperada';
    await req('/auth/recuperacao-codigo', { body: { ...identificador, codigo: 'A'.repeat(32), senha: novaSenha }, status: 401 });
    const recuperada = await req('/auth/recuperacao-codigo', { body: { ...identificador, codigo: nova.codigo, senha: novaSenha }, status: 200 });
    assert.notEqual(nova.codigo, recuperada.codigo);
    await req('/auth/recuperacao-codigo', { body: { ...identificador, codigo: nova.codigo, senha }, status: 401 });
    await req('/pedidos', { token: acesso.token, status: 401 });
    await req('/auth/login', { body: { ...identificador, senha }, status: 401 });
    const novoAcesso = await req('/auth/login', { body: { ...identificador, senha: novaSenha } });
    assert.equal(novoAcesso.conta.id, nova.conta.id);
    await req('/auth/sair', { token: novoAcesso.token, body: {}, status: 204 });
    await req('/pedidos', { token: novoAcesso.token, status: 401 });
  }

  const indevido = await req('/auth/login', { body: { email: outroProfissional.email, senha } });
  assert.equal(indevido.conta.profissional, false);
  await req('/pedidos', { token: indevido.token, status: 403 });
  await req('/visitas', { token: indevido.token, status: 403 });
  const inicial = await req('/auth/login', { body: { celular: titular.celular, senha } });
  assert.equal(inicial.conta.trocarSenha, true);
  await req('/visitas', { token: inicial.token, status: 403 });
  const senhaTitular = senha + ' do titular';
  await req('/auth/trocar-senha', { token: inicial.token, body: { senhaAtual: senha, senha: senhaTitular }, status: 204 });
  await req('/visitas', { token: inicial.token, status: 401 });
  const acessoTitular = await req('/auth/login', { body: { celular: titular.celular, senha: senhaTitular } });
  assert.equal(acessoTitular.conta.id, titularId);
  assert.equal(acessoTitular.conta.profissional, true);
  const dia = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const visita = await req('/visitas', { token: acessoTitular.token, body: { pedidoId: pedido.id, dia, hora: '08:00' } });
  assert.equal(visita.id, pedido.id);
  assert.equal((await req('/pedidos/' + pedido.id, { token: sessao.token })).visita.id, visita.visita.id);
  await t.diagnostic('UUID e pedido legado preservados. Cadastro, login, recuperação e logout pelos dois identificadores. Isolamento entre clientes, titular exclusivo e visita confirmada.');
});
