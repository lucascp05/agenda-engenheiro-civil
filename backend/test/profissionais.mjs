import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';

const senha = 'Credencial fictícia de integração';
const celular = () => '849' + randomInt(10000000, 99999999);
const registro = {titulo:'Engenheiro civil fictício', creaUf:'RN', registro:'TESTE-123', autorizaPublicacao:false};
const revisao = {
  decisao:'APROVADO', dadosConferidos:true, titularConfirmado:true,
  fonteOficial:'CONFEA', metodoIdentidade:'VERIFICACAO_PRESENCIAL',
};

test('cadastro, revisão independente e acesso à agenda', {timeout:45000}, async () => {
  const schema = 'teste_prof_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  const reserva = createServer();
  await new Promise(resolve => reserva.listen(0, '127.0.0.1', resolve));
  const {port} = reserva.address();
  await new Promise(resolve => reserva.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const adminPhone = celular();
  const legacyPhone = celular();
  const env = {...process.env, DATABASE_URL:url.href, PORT:String(port), AGENDA_PUBLICACAO:'0',
    ADMIN_NAME:'Revisor fictício', ADMIN_PHONE:adminPhone, ADMIN_PASSWORD:senha,
    ENGINEER_NAME:'Conta profissional preexistente', ENGINEER_PHONE:legacyPhone, ENGINEER_PASSWORD:senha};
  const db = new PrismaClient();
  const anterior = mkdtempSync(join(tmpdir(), 'agenda-prisma-anterior-'));
  let filho;
  function executar(...args) {
    const resultado = spawnSync(process.execPath, args, {env, stdio:'ignore'});
    assert.equal(resultado.status, 0, args.join(' '));
  }
  async function chamar(rota, status, {token, body} = {}) {
    const res = await fetch(base + rota, {
      method:body ? 'POST' : 'GET',
      headers:{...(body && {'Content-Type':'application/json'}), ...(token && {Authorization:'Bearer ' + token})},
      body:body && JSON.stringify(body),
    });
    assert.equal(res.status,status,rota);
    return res.json();
  }

  try {
    const migracoes = 'prisma/migrations';
    mkdirSync(join(anterior, 'migrations'));
    copyFileSync('prisma/schema.prisma', join(anterior, 'schema.prisma'));
    copyFileSync(join(migracoes, 'migration_lock.toml'), join(anterior, 'migrations', 'migration_lock.toml'));
    for (const nome of ['20261124000000_inicial', '20261124010000_sessoes']) {
      cpSync(join(migracoes, nome), join(anterior, 'migrations', nome), {recursive:true});
    }
    executar('node_modules/prisma/build/index.js','migrate','deploy','--schema',join(anterior,'schema.prisma'));
    executar('dist/seed.js');
    const dbAnterior = new PrismaClient({datasourceUrl:url.href});
    let preservados;
    try {
      const contaLegada = await dbAnterior.conta.findUniqueOrThrow({where:{celular:legacyPhone}});
      const clienteLegado = await dbAnterior.conta.create({data:{nome:'Cliente anterior fictício',celular:celular(),hash:'fixture-sem-login'}});
      const pedidoLegado = await dbAnterior.pedido.create({data:{
        clienteId:clienteLegado.id, servico:'Topografia', municipio:'Mossoró', local:'Local anterior fictício',
        descricao:'Pedido existente antes da migração', situacao:'MARCADO',
        visita:{create:{horario:new Date('2031-02-03T15:00:00Z')}},
      }, include:{visita:true}});
      preservados = {contaLegada, pedidoLegado};
    } finally {
      await dbAnterior.$disconnect();
    }
    executar('node_modules/prisma/build/index.js','migrate','deploy');
    executar('dist/seed.js','--admin');
    filho = spawn(process.execPath,['dist/main.js'],{env,stdio:'ignore'});
    let pronto = false;
    for (let i=0; i<60; i++) {
      if ((await fetch(base+'/saude').catch(() => null))?.ok) { pronto=true; break; }
      await esperar(100);
    }
    assert.ok(pronto, 'API isolada não iniciou.');
    const cliente = await chamar('/auth/cadastro',201,{body:{nome:'Cliente fictício',celular:celular(),senha}});
    const pedido = await chamar('/pedidos',201,{token:cliente.token,body:{
      servico:'Topografia',municipio:'Mossoró',local:'Local fictício',descricao:'Visita fictícia de integração.',
    }});
    const admin = await chamar('/auth/login',201,{body:{celular:adminPhone,senha}});
    const legada = await chamar('/auth/login',201,{body:{celular:legacyPhone,senha}});
    assert.equal(legada.conta.id,preservados.contaLegada.id);
    assert.equal(admin.conta.papel,'ADMIN');
    assert.deepEqual(await chamar('/profissionais/meu-perfil',200,{token:legada.token}),{perfil:null});
    await chamar('/pedidos',403,{token:legada.token});
    await chamar('/profissionais/meu-perfil',201,{token:legada.token,body:{...registro,nomeCompleto:'Profissional preexistente fictício'}});

    const telefone = celular();
    const dados = {nome:'Profissional fictício',celular:telefone,senha,registro};
    await chamar('/auth/cadastro-profissional',400,{body:{...dados,registro:{...registro,situacao:'APROVADO'}}});
    const solicitacao = await chamar('/auth/cadastro-profissional',201,{body:dados});
    const profissional = await chamar('/auth/login',201,{body:{celular:telefone,senha}});
    assert.equal(solicitacao.conta.id,profissional.conta.id);
    assert.equal((await chamar('/profissionais/meu-perfil',200,{token:profissional.token})).perfil.situacao,'EM_ANALISE');
    assert.deepEqual(await chamar('/profissionais/publico',200),{perfil:null});
    await chamar('/pedidos',403,{token:profissional.token});
    await chamar('/pedidos/'+pedido.id,403,{token:profissional.token});
    await chamar('/visitas',403,{token:profissional.token});
    await chamar('/pedidos',403,{token:admin.token});
    await chamar('/profissionais/meu-perfil',403,{token:cliente.token,body:{...registro,nomeCompleto:'Cliente fictício'}});
    const alvo = '/profissionais/revisao/'+legada.conta.id;
    await chamar('/profissionais/revisao/'+profissional.conta.id,403,{token:profissional.token,body:revisao});
    await chamar(alvo,403,{token:profissional.token,body:revisao});
    await chamar(alvo,403,{token:cliente.token,body:revisao});
    await chamar(alvo,400,{token:admin.token,body:{...revisao,titularConfirmado:false}});
    await chamar(alvo,201,{token:admin.token,body:revisao});
    const pedidoAnterior = await chamar('/pedidos/'+preservados.pedidoLegado.id,200,{token:legada.token});
    assert.equal(pedidoAnterior.visita.id,preservados.pedidoLegado.visita.id);
    assert.equal(pedidoAnterior.visita.horario,preservados.pedidoLegado.visita.horario.toISOString());
    await chamar('/profissionais/revisao/'+profissional.conta.id,409,{token:admin.token,body:revisao});
    await chamar('/profissionais/revisao/'+profissional.conta.id,201,{token:admin.token,body:{
      decisao:'REJEITADO',dadosConferidos:false,titularConfirmado:false,
    }});
    await chamar('/pedidos',403,{token:profissional.token});
    const auditoria = (await chamar('/profissionais/revisao',200,{token:admin.token})).find(p=>p.contaId===legada.conta.id);
    assert.equal(auditoria.revisor.nome,'Revisor fictício');
    assert.equal(auditoria.metodoIdentidade,'VERIFICACAO_PRESENCIAL');
    assert.ok(Date.parse(auditoria.revisadoEm));
    assert.deepEqual(await chamar('/profissionais/publico',200),{perfil:null});
    const consentir = autorizaPublicacao => chamar('/profissionais/meu-perfil/publicacao',201,{
      token:legada.token,body:{autorizaPublicacao},
    });
    await consentir(true);
    const publico = (await chamar('/profissionais/publico',200)).perfil;
    assert.deepEqual(Object.keys(publico).sort(),['creaUf','nomeCompleto','registro','revisadoEm','titulo']);
    assert.equal(publico.nomeCompleto,'Profissional preexistente fictício');
    await consentir(false);
    assert.deepEqual(await chamar('/profissionais/publico',200),{perfil:null});
    const dia = new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    const marcada = await chamar('/visitas',201,{token:legada.token,body:{pedidoId:pedido.id,dia,hora:'10:00'}});
    const visto = await chamar('/pedidos/'+pedido.id,200,{token:cliente.token});
    assert.equal(visto.situacao,'MARCADO');
    assert.equal(visto.visita.horario,marcada.visita.horario);
  } finally {
    filho?.kill();
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await db.$disconnect();
    rmSync(anterior,{recursive:true,force:true});
  }
});
