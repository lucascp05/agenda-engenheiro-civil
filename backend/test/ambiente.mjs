import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as esperar } from 'node:timers/promises';

async function abrir(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

export async function iniciarApi(t, env = {}) {
  const mensagens = [];
  const caixa = createServer(async (req, res) => {
    let corpo = '';
    for await (const parte of req) corpo += parte;
    mensagens.push(JSON.parse(corpo));
    res.writeHead(200).end();
  });
  const portaEmail = await abrir(caixa);
  const emailUrl = 'http://127.0.0.1:' + portaEmail;
  t.after(() => new Promise(resolve => caixa.close(resolve)));
  const reserva = createServer();
  const portaApi = await abrir(reserva);
  await new Promise(resolve => reserva.close(resolve));
  const base = 'http://127.0.0.1:' + portaApi;
  const processo = spawn(process.execPath, ['dist/main.js'], {
    env: {
      ...process.env, ...env, PORT: String(portaApi), AGENDA_PUBLICACAO: '0',
      EMAIL_TEST_URL: env.EMAIL_TEST_URL ?? emailUrl,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (processo.exitCode !== null || processo.signalCode !== null) return;
    const saiu = once(processo, 'exit');
    processo.kill();
    await saiu;
  });
  let pronto = false;
  for (let i = 0; i < 60; i++) {
    if ((await fetch(base + '/saude').catch(() => null))?.ok) { pronto = true; break; }
    await esperar(100);
  }
  assert.ok(pronto, 'API isolada não iniciou.');

  function token(email, finalidade) {
    const mensagem = mensagens.findLast(item => item.to.includes(email) && item.text.includes('acao=' + finalidade + '&'));
    assert.ok(mensagem, 'Mensagem esperada na caixa simulada.');
    const link = new URL(mensagem.text.split('\n').at(-1));
    return new URLSearchParams(link.hash.slice(1)).get('token');
  }
  return { base, token, emailUrl };
}

export function requisicoes(base) {
  return async function req(path, {token, body, status = body ? 201 : 200, headers = {}} = {}) {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return status === 204 ? undefined : res.json();
  };
}
