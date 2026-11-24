import assert from 'node:assert/strict';
import test from 'node:test';
import { randomInt } from 'node:crypto';

const base = process.env.TEST_API_URL || 'http://localhost:3000';
const senha = 'SenhaDemo2026';

async function req(path, {token, body, status = body ? 201 : 200} = {}) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  assert.equal(res.status, status, path);
  return res.json();
}

async function cliente(nome) {
  const numero = String(randomInt(10000000, 99999999));
  const celular = '849' + numero;
  const mascarado = '(84) 9' + numero.slice(0, 4) + '-' + numero.slice(4);
  const cadastro = await req('/auth/cadastro', {body: {nome, celular: mascarado, senha}});
  assert.equal(cadastro.conta.celular, celular);
  assert.equal(cadastro.conta.papel, 'CLIENTE');
  await req('/auth/cadastro', {body: {nome, celular, senha}, status: 409});
  return (await req('/auth/login', {body: {celular, senha}})).token;
}

test('fluxo real, permissões, filtros e agendamento concorrente', async () => {
  await req('/saude');
  await req('/pedidos', {status: 401});
  const engenheiro = (await req('/auth/login', {body: {
    celular: process.env.ENGINEER_PHONE || '84999000001',
    senha: process.env.ENGINEER_PASSWORD || 'VisitaDemo2026',
  }})).token;
  const primeiro = await cliente('Cliente Demo A');
  const segundo = await cliente('Cliente Demo B');
  const dados = {servico: 'Topografia', municipio: 'Mossoró', comunidade: 'Sítio Demo', local: 'Entrada da comunidade', descricao: 'Levantamento do terreno fictício'};
  const a = await req('/pedidos', {token: primeiro, body: dados});
  const b = await req('/pedidos', {token: segundo, body: {...dados, comunidade: 'Outro sítio'}});
  assert.equal(a.situacao, 'RECEBIDO');
  assert.equal((await req('/pedidos', {token: primeiro})).length, 1);
  await req('/pedidos/' + a.id, {token: segundo, status: 404});
  await req('/pedidos/' + a.id + '/informacoes', {token: primeiro, body: {texto: 'Mensagem'}, status: 403});
  await req('/pedidos/' + a.id + '/conclusao', {token: primeiro, body: {}, status: 403});
  const info = await req('/pedidos/' + a.id + '/informacoes', {token: engenheiro, body: {texto: 'Qual é o ponto de referência?'}});
  assert.equal(info.situacao, 'INFORMACOES');
  await req('/pedidos/' + a.id + '/respostas', {token: segundo, body: {texto: 'Tentativa indevida'}, status: 404});
  const resposta = await req('/pedidos/' + a.id + '/respostas', {token: primeiro, body: {texto: 'Ao lado do galpão fictício.'}});
  assert.equal(resposta.situacao, 'RECEBIDO');
  assert.deepEqual(resposta.mensagens.map(m => m.autor), ['ENGENHEIRO', 'CLIENTE']);
  const filtrados = await req('/pedidos?municipio=mossor&comunidade=S%C3%ADtio%20Demo', {token: engenheiro});
  assert.ok(filtrados.some(p => p.id === a.id));
  assert.ok(!filtrados.some(p => p.id === b.id));

  const ocupados = new Set((await req('/pedidos', {token: engenheiro}))
    .flatMap(p => p.visita ? [p.visita.horario] : []));
  const dias = Array.from({length: 365}, (_, i) =>
    new Date(Date.now() + (i + 2) * 86400000).toISOString().slice(0, 10));
  const dia = dias.find(data => ['06:00', '07:00', '09:00'].every(h =>
    !ocupados.has(new Date(data + 'T' + h + ':00-03:00').toISOString())));
  assert.ok(dia, 'Deve haver um dia com horários livres no banco de demonstração.');
  const hora = '09:00';
  const agendar = (pedidoId, token) => fetch(base + '/visitas', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({pedidoId, dia, hora}),
  });
  assert.equal((await agendar(a.id, primeiro)).status, 403);
  await req('/visitas', {token: primeiro, status: 403});
  await req('/visitas', {token: engenheiro, body: {pedidoId: a.id, dia, hora: '13:30'}, status: 400});

  const tentativas = await Promise.all([agendar(a.id, engenheiro), agendar(b.id, engenheiro)]);
  assert.deepEqual(tentativas.map(r => r.status).sort(), [201,409]);
  const [vencedor, perdedor] = tentativas[0].status === 201 ? [a,b] : [b,a];
  const tokenVencedor = vencedor.id === a.id ? primeiro : segundo;
  const salvo = await req('/pedidos/' + vencedor.id, {token: tokenVencedor});
  assert.equal(salvo.situacao, 'MARCADO');
  assert.equal(salvo.visita.horario, new Date(dia + 'T' + hora + ':00-03:00').toISOString());
  const intacto = await req('/pedidos/' + perdedor.id, {token: engenheiro});
  assert.equal(intacto.situacao, 'RECEBIDO');
  assert.equal(intacto.visita, null);
  const agenda = await req('/visitas', {token: engenheiro});
  assert.equal(agenda.filter(v => v.horario === salvo.visita.horario).length, 1);

  const horarios = ['06:00','07:00'].map(hora => fetch(base + '/visitas', {
    method: 'POST', headers: { Authorization: 'Bearer ' + engenheiro, 'Content-Type': 'application/json' },
    body: JSON.stringify({pedidoId: perdedor.id, dia, hora}),
  }));
  assert.deepEqual((await Promise.all(horarios)).map(r => r.status).sort(), [201,409]);
  await req('/pedidos/' + vencedor.id + '/conclusao', {token: engenheiro, body: {}});
  const concluido = await req('/pedidos/' + vencedor.id, {token: tokenVencedor});
  assert.equal(concluido.situacao, 'CONCLUIDO');
  assert.deepEqual(concluido.visita, salvo.visita);
  assert.ok(!(await req('/visitas', {token: engenheiro})).some(v => v.pedido.id === vencedor.id));
});
