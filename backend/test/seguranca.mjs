import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { iniciarApi, requisicoes } from './ambiente.mjs';

const resumir = token => createHash('sha256').update(token).digest('hex');

test('sessão, senhas, CORS, limites e verificação por e-mail', { timeout: 30000 }, async t => {
  const origem = 'http://localhost:8080';
  const caixa = await iniciarApi(t, { CORS_ORIGINS: origem });
  const req = requisicoes(caixa.base);
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const celular = '849' + randomInt(10000000,99999999);
  const inexistente = '869' + randomInt(10000000,99999999);
  const mascarar = valor => valor.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  const senha = 'Frase fictícia para teste local';
  const novaSenha = 'Nova frase fictícia para teste';
  const email = randomUUID() + '@example.test';
  const dados = { nome: 'Cliente fictício de segurança', email };

  for (const valor of [origem, 'https://exemplo.invalid']) {
    const res = await fetch(caixa.base + '/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: valor, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), valor === origem ? origem : null);
  }

  await req('/auth/cadastro', {body: {...dados, papel:'ENGENHEIRO'}, status:400});
  const respostaCadastro = await req('/auth/cadastro', {body:dados, status:202});
  const primeiroToken = caixa.token(email, 'CADASTRO');
  assert.equal(await db.tokenEmail.count({where:{hash:primeiroToken}}), 0);
  await db.tokenEmail.update({where:{hash:resumir(primeiroToken)}, data:{expiraEm:new Date(0)}});
  await req('/auth/confirmar-email', {body:{token:primeiroToken,senha}, status:400});
  await req('/auth/cadastro', {body:dados, status:202});
  const token = caixa.token(email, 'CADASTRO');
  assert.notEqual(token, primeiroToken);
  await req('/auth/confirmar-email', {body:{token, senha:'curta-demais'}, status:400});
  await req('/auth/confirmar-email', {body:{token, senha:'a'.repeat(129)}, status:400});
  const primeira = await req('/auth/confirmar-email', {body:{token, senha}});
  assert.equal(primeira.conta.papel,'CLIENTE');
  assert.deepEqual(Object.keys(primeira.conta).sort(),['celular','email','id','nome','papel','profissional']);
  const conta = await db.conta.findUniqueOrThrow({where:{email}});
  assert.ok(conta.hash.startsWith('scrypt-v2:') && !conta.hash.includes(senha));
  await req('/auth/confirmar-email', {body:{token, senha}, status:400});
  assert.deepEqual(await req('/auth/cadastro', {body:dados, status:202}), respostaCadastro);

  const segunda = await req('/auth/login', {body:{email, senha}});
  assert.ok(Date.parse(segunda.expiraEm) > Date.now());
  await req('/auth/sair', {token:primeira.token,body:{},status:204});
  await req('/pedidos', {token:primeira.token,status:401});
  await req('/pedidos', {token:segunda.token});
  await db.sessaoAcesso.updateMany({where:{contaId:conta.id},data:{expiraEm:new Date(0)}});
  await req('/pedidos', {token:segunda.token,status:401});
  const terceira = await req('/auth/login', {body:{email, senha}});

  const semConta = await req('/auth/recuperacao', {body:{email:'inexistente@example.test'},status:202});
  assert.deepEqual(await req('/auth/recuperacao', {body:{email},status:202}), semConta);
  const reset = caixa.token(email,'RECUPERACAO');
  assert.equal(await db.tokenEmail.count({where:{hash:reset}}), 0);
  await req('/auth/redefinir-senha', {body:{token:reset,senha:novaSenha},status:204});
  await req('/auth/redefinir-senha', {body:{token:reset,senha:novaSenha},status:400});
  await req('/pedidos', {token:terceira.token,status:401});
  await req('/auth/login', {body:{email,senha},status:401});
  await req('/auth/login', {body:{email,senha:novaSenha}});

  const sal = randomBytes(16).toString('hex');
  const senhaLegada = 'frase antiga';
  const hash = sal + ':' + scryptSync(senhaLegada,sal,64).toString('hex');
  const legada = await db.conta.create({data:{nome:'Conta fictícia legada',celular,hash}});
  const acesso = await req('/auth/login', {body:{celular:mascarar(celular),senha:senhaLegada}});
  assert.match((await db.conta.findUniqueOrThrow({where:{celular}})).hash,/^scrypt-v2:/);
  const emailLegado = randomUUID() + '@example.test';
  await req('/auth/vincular-email', {token:acesso.token,body:{email:emailLegado},status:202});
  const vinculo = caixa.token(emailLegado,'VINCULO');
  await req('/auth/confirmar-vinculo', {token:terceira.token,body:{token:vinculo},status:401});
  const outraConta = await req('/auth/login', {body:{email,senha:novaSenha}});
  await req('/auth/confirmar-vinculo', {token:outraConta.token,body:{token:vinculo},status:400});
  const vinculada = await req('/auth/confirmar-vinculo', {token:acesso.token,body:{token:vinculo}});
  assert.equal(vinculada.conta.id, legada.id);
  assert.equal((await req('/auth/login', {body:{email:emailLegado,senha:senhaLegada}})).conta.id, legada.id);

  for (let i=0; i<8; i++) await req('/auth/login', {body:{celular:inexistente,senha},status:401});
  await req('/auth/login', {body:{celular:mascarar(inexistente),senha},status:429});
  for (let i=0; i<2; i++) await req('/auth/cadastro', {body:dados,status:202});
  await req('/auth/cadastro', {body:dados,status:429});
  const candidatosIp = [];
  for (let i=0; i<30; i++) {
    const res = await fetch(caixa.base + '/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    candidatosIp.push(res.status);
    if (res.status === 429) {
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      break;
    }
  }
  assert.equal(candidatosIp.at(-1), 429);
  await req('/auth/login', {body:{},status:429,headers:{'X-Forwarded-For':'203.0.113.9'}});
});