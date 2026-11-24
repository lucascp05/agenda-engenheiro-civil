import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomInt, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as esperar } from 'node:timers/promises';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';

test('sessão, senhas, CORS e limites de acesso', { timeout: 30000 }, async () => {
  const reserva = createServer();
  await new Promise(resolve => reserva.listen(0, '127.0.0.1', resolve));
  const { port } = reserva.address();
  await new Promise(resolve => reserva.close(resolve));
  const origem = 'http://localhost:8080';
  const base = 'http://127.0.0.1:' + port;
  const filho = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PORT: String(port), CORS_ORIGINS: origem, AGENDA_PUBLICACAO: '0' },
    stdio: 'ignore',
  });
  const db = new PrismaClient();
  const celular = '849' + randomInt(10000000,99999999);
  const outro = '859' + randomInt(10000000,99999999);
  const inexistente = '869' + randomInt(10000000,99999999);
  const mascarar = valor => valor.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  const senha = 'Frase fictícia para teste local';
  const dados = { nome: 'Cliente fictício de segurança', celular, senha };

  async function chamar(path, status, { body, token, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(token && { Authorization: 'Bearer ' + token }),
        ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return { dados: res.status === 204 ? undefined : await res.json(), res };
  }

  try {
    let pronto = false;
    for (let tentativa = 0; tentativa < 50; tentativa++) {
      if ((await fetch(base + '/saude').catch(() => null))?.ok) { pronto = true; break; }
      await esperar(100);
    }
    assert.ok(pronto, 'API isolada não iniciou.');
    for (const valor of [origem,'https://exemplo.invalid']) {
      const res = await fetch(base + '/auth/login', {
        method:'OPTIONS',
        headers:{ Origin:valor, 'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'content-type' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), valor === origem ? origem : null);
    }

    await chamar('/auth/cadastro',400,{body:{...dados, papel:'ENGENHEIRO'}});
    await chamar('/auth/cadastro',400,{body:{...dados, senha:'curta-demais'}});
    await chamar('/auth/cadastro',400,{body:{...dados, senha:'a'.repeat(129)}});
    const {dados: primeira} = await chamar('/auth/cadastro',201,{body:dados});
    assert.equal(primeira.conta.papel,'CLIENTE');
    assert.deepEqual(Object.keys(primeira.conta).sort(),['celular','id','nome','papel']);
    const conta = await db.conta.findUniqueOrThrow({where:{celular}});
    assert.ok(conta.hash.startsWith('scrypt-v2:') && !conta.hash.includes(senha));
    const duplicata = await chamar('/auth/cadastro',409,{body:{...dados, celular:mascarar(celular)}});
    assert.ok(duplicata.dados.campos.celular);
    assert.ok(!JSON.stringify(duplicata.dados).includes(celular));

    const {dados: segunda} = await chamar('/auth/login',201,{body:{celular,senha}});
    assert.ok(Date.parse(segunda.expiraEm) > Date.now());
    await chamar('/auth/sair',204,{token:primeira.token,body:{}});
    await chamar('/pedidos',401,{token:primeira.token});
    await chamar('/pedidos',200,{token:segunda.token});
    await db.sessaoAcesso.updateMany({where:{contaId:conta.id},data:{expiraEm:new Date(0)}});
    await chamar('/pedidos',401,{token:segunda.token});

    const sal = randomBytes(16).toString('hex');
    const senhaLegada = 'frase antiga';
    const hash = sal + ':' + scryptSync(senhaLegada,sal,64).toString('hex');
    await db.conta.create({data:{nome:'Conta fictícia legada',celular:outro,hash}});
    await chamar('/auth/login',201,{body:{celular:outro,senha:senhaLegada}});
    assert.match((await db.conta.findUniqueOrThrow({where:{celular:outro}})).hash,/^scrypt-v2:/);

    for (let i=0; i<8; i++) await chamar('/auth/login',401,{body:{celular:inexistente,senha}});
    const excedeu = await chamar('/auth/login',429,{body:{celular:mascarar(inexistente),senha}});
    assert.ok(Number(excedeu.res.headers.get('retry-after')) > 0);
    for (let i=0; i<3; i++) await chamar('/auth/cadastro',409,{body:dados});
    await chamar('/auth/cadastro',429,{body:dados});

    // As tentativas inválidas também usam a cota por IP. Cabeçalhos do cliente não a alteram.
    for (let i=11; i<30; i++) await chamar('/auth/login',400,{body:{}});
    await chamar('/auth/login',429,{body:{celular,senha},headers:{'X-Forwarded-For':'203.0.113.9'}});
    for (let i=9; i<12; i++) await chamar('/auth/cadastro',400,{body:{}});
    await chamar('/auth/cadastro',429,{body:dados,headers:{'X-Forwarded-For':'203.0.113.9'}});
  } finally {
    filho.kill();
    await db.conta.deleteMany({where:{celular:{in:[celular,outro]}}});
    await db.$disconnect();
  }
});
