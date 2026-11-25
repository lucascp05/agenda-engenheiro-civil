import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { iniciarApi, requisicoes } from './ambiente.mjs';
import senhaApi from '../dist/senha.js';

const senha = 'Credencial fictícia de integração';
const nomeCompleto = 'Profissional preexistente fictício';
const registro = {nomeCompleto, titulo:'Engenheiro civil fictício', creaUf:'RN', registro:'TESTE-123'};

test('migração preserva dados e o convite libera somente o titular', {timeout:45000}, async t => {
  const schema = 'teste_prof_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  const dono = randomUUID(), cliente = randomUUID(), outro = randomUUID(), admin = randomUUID();
  const pedido = randomUUID(), visita = randomUUID();
  const horario = new Date('2031-02-03T15:00:00Z');
  const email = 'dono@example.test';
  const env = {...process.env, DATABASE_URL:url.href, AGENDA_OWNER_ID:dono, AGENDA_OWNER_EMAIL:email, AGENDA_PUBLICACAO:'0'};
  const db = new PrismaClient({datasourceUrl:url.href});
  const anterior = mkdtempSync(join(tmpdir(), 'agenda-prisma-anterior-'));
  t.after(async () => {
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await db.$disconnect();
    rmSync(anterior,{recursive:true,force:true});
  });

  function migrar(schemaPrisma) {
    const resultado = spawnSync(process.execPath, ['node_modules/prisma/build/index.js','migrate','deploy','--schema',schemaPrisma], {env,encoding:'utf8'});
    assert.equal(resultado.status, 0, resultado.stderr);
  }

  const migracoes = 'prisma/migrations';
  mkdirSync(join(anterior, 'migrations'));
  copyFileSync('prisma/schema.prisma', join(anterior, 'schema.prisma'));
  copyFileSync(join(migracoes, 'migration_lock.toml'), join(anterior, 'migrations', 'migration_lock.toml'));
  for (const nome of ['20261124000000_inicial','20261124010000_sessoes','20261124020000_verificacao_profissional']) {
    cpSync(join(migracoes, nome), join(anterior, 'migrations', nome), {recursive:true});
  }
  migrar(join(anterior, 'schema.prisma'));

  const hash = await senhaApi.gerarHash(senha);
  await db.$executeRaw`INSERT INTO "Conta" (id,nome,celular,hash,papel) VALUES
    (${dono},${nomeCompleto},'84900000001',${hash},'ENGENHEIRO'),
    (${cliente},'Cliente anterior fictício','84900000002',${hash},'CLIENTE'),
    (${outro},'Outro profissional fictício','84900000003',${hash},'ENGENHEIRO'),
    (${admin},'Administrador anterior fictício','84900000004',${hash},'ADMIN')`;
  await db.$executeRaw`INSERT INTO "PerfilProfissional"
    ("contaId","nomeCompleto",titulo,"creaUf",registro,situacao,"revisorId","revisadoEm","fonteOficial","metodoIdentidade")
    VALUES (${outro},'Outro profissional fictício','Engenheiro civil','RN','TESTE-OUTRO','APROVADO',
      ${admin},CURRENT_TIMESTAMP,'CONFEA','VERIFICACAO_PRESENCIAL')`;
  await db.$executeRaw`INSERT INTO "Pedido" (id,"clienteId",servico,municipio,local,descricao,situacao)
    VALUES (${pedido},${cliente},'Topografia','Mossoró','Referência fictícia','Pedido registrado antes da migração','MARCADO')`;
  await db.$executeRaw`INSERT INTO "Visita" (id,"pedidoId",horario) VALUES (${visita},${pedido},${horario})`;

  migrar('prisma/schema.prisma');
  const caixa = await iniciarApi(t, env);
  const req = requisicoes(caixa.base);
  const entrar = celular => req('/auth/login', {body:{celular,senha}});
  const sessaoDono = await entrar('84900000001');
  const sessaoCliente = await entrar('84900000002');
  const sessaoOutro = await entrar('84900000003');
  const sessaoAdmin = await entrar('84900000004');
  assert.equal(sessaoDono.conta.id, dono);
  assert.equal(sessaoDono.conta.profissional, true);
  const preservado = await req('/pedidos/' + pedido, {token:sessaoCliente.token});
  assert.equal(preservado.clienteId, cliente);
  assert.equal(preservado.visita.id, visita);
  assert.equal(preservado.visita.horario, horario.toISOString());

  await req('/auth/cadastro-profissional', {body:{nome:nomeCompleto,celular:'84900000005',senha},status:404});
  await req('/profissionais/revisao', {token:sessaoAdmin.token,status:404});
  for (const sessao of [sessaoOutro,sessaoAdmin]) {
    assert.equal(sessao.conta.profissional, false);
    await req('/pedidos', {token:sessao.token,status:403});
    await req('/pedidos/' + pedido, {token:sessao.token,status:403});
  }
  for (const sessao of [sessaoOutro,sessaoAdmin,sessaoCliente]) {
    await req('/visitas', {token:sessao.token,status:403});
    await req('/profissionais/meu-perfil', {token:sessao.token,status:403});
  }

  assert.deepEqual(await req('/profissionais/publico'),{perfil:null});
  const salvar = autorizaPublicacao => req('/profissionais/meu-perfil', {
    token:sessaoDono.token,body:{...registro,autorizaPublicacao},
  });
  await salvar(true);
  assert.deepEqual((await req('/profissionais/publico')).perfil, registro);
  await salvar(false);
  assert.deepEqual(await req('/profissionais/publico'),{perfil:null});
  assert.equal((await req('/visitas', {token:sessaoDono.token}))[0].id, visita);

  const novaSenha = 'Nova senha do dono fictício';
  assert.equal((await req('/auth/recursos')).conviteProfissionalDisponivel, true);
  const outroEmail = 'outro@example.test';
  const respostaOutro = await req('/auth/convite-profissional', {body:{email:outroEmail},status:202});
  assert.throws(() => caixa.token(outroEmail, 'PROPRIETARIO'));
  await req('/auth/cadastro', {body:{email,nome:'Cadastro reservado'},status:202});
  assert.throws(() => caixa.token(email, 'CADASTRO'));
  await promisify(execFile)(process.execPath, ['dist/convidar.js'], {
    env: {...env, EMAIL_TEST_URL:caixa.emailUrl, AGENDA_OWNER_EMAIL:email},
  });
  const tokenManual = caixa.token(email,'PROPRIETARIO');
  assert.deepEqual(await req('/auth/convite-profissional', {body:{email:email.toUpperCase()},status:202}), respostaOutro);
  const token = caixa.token(email,'PROPRIETARIO');
  assert.notEqual(token, tokenManual);
  await req('/auth/ativar-profissional', {body:{token,senha:novaSenha},status:204});
  await req('/auth/ativar-profissional', {body:{token,senha:novaSenha},status:400});
  await req('/visitas', {token:sessaoDono.token,status:401});
  const novoAcesso = await req('/auth/login', {body:{email,senha:novaSenha}});
  assert.equal(novoAcesso.conta.id, dono);
  assert.equal((await req('/pedidos', {token:novoAcesso.token}))[0].id, pedido);
  assert.equal((await req('/visitas', {token:novoAcesso.token}))[0].id, visita);
});

test('provisionamento por stdin e troca obrigatória sem serviço de e-mail', async t => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const celular = '849' + randomBytes(4).readUInt32BE().toString().padStart(8, '0').slice(-8);
  const email = randomUUID() + '@example.test';
  const dono = await db.conta.create({data:{nome:nomeCompleto, celular, papel:'ENGENHEIRO', hash:await senhaApi.gerarHash(senha)}});
  const env = {
    ...process.env, AGENDA_OWNER_ID:dono.id, AGENDA_OWNER_EMAIL:email, AGENDA_OWNER_NAME:nomeCompleto,
    AGENDA_OWNER_PHONE:celular, RESEND_API_KEY:'', EMAIL_FROM:'', EMAIL_TEST_URL:'',
  };
  const {base} = await iniciarApi(t, env);
  const req = requisicoes(base);
  const anterior = await req('/auth/login', {body:{celular,senha}});
  const temporaria = 'Senha fictícia inicial';
  function provisionar() {
    return spawnSync(process.execPath, ['dist/titular.js'], {env, input:temporaria, encoding:'utf8'}).status;
  }
  assert.equal(provisionar(), 0);
  assert.equal(provisionar(), 0);
  await req('/visitas', {token:anterior.token,status:401});
  await req('/auth/login', {body:{celular,senha},status:401});
  const entrar = (senha, status = 201) => req('/auth/login', {body:{email,senha},status});
  const primeiro = await entrar(temporaria);
  const outro = await entrar(temporaria);
  assert.equal(primeiro.conta.id, dono.id);
  assert.equal(primeiro.conta.profissional, true);
  assert.equal(primeiro.conta.trocarSenha, true);
  await req('/pedidos', {token:primeiro.token,status:403});
  await req('/visitas', {token:primeiro.token,status:403});
  const nova = 'Nova senha definitiva fictícia';
  const trocar = (senhaAtual, senha, status) =>
    req('/auth/trocar-senha', {token:primeiro.token,body:{senhaAtual,senha},status});
  await trocar(senha, nova, 400);
  await trocar(temporaria, temporaria, 400);
  await trocar(temporaria, nova, 204);
  for (const sessao of [primeiro, outro]) await req('/visitas', {token:sessao.token,status:401});
  await entrar(temporaria, 401);
  const renovado = await entrar(nova);
  assert.equal(renovado.conta.trocarSenha, undefined);
  await req('/pedidos', {token:renovado.token});
  await req('/visitas', {token:renovado.token});
  assert.equal(provisionar(), 1);
});
