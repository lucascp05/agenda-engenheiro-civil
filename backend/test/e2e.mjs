import assert from 'node:assert/strict';
import test from 'node:test';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { iniciarApi, requisicoes } from './ambiente.mjs';
import senhaApi from '../dist/senha.js';

const senha = 'Senha fictícia suíte de integração';

test('fluxo real, permissões, filtros e agendamento concorrente', async t => {
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  const celular = '849' + randomInt(10000000, 99999999);
  const dono = await db.conta.create({ data: {
    celular, nome: 'Profissional fictício', hash: await senhaApi.gerarHash(senha), papel: 'ENGENHEIRO',
  } });
  const caixa = await iniciarApi(t, { AGENDA_OWNER_ID: dono.id });
  const { base } = caixa;
  const req = requisicoes(base);

  async function cliente(nome) {
    const email = randomUUID() + '@example.test';
    await req('/auth/cadastro', {body: {nome, email: email.toUpperCase()}, status: 202});
    await req('/auth/login', {body: {email, senha}, status: 401});
    const cadastro = await req('/auth/confirmar-email', {body: {token: caixa.token(email, 'CADASTRO'), senha}});
    assert.equal(cadastro.conta.email, email);
    assert.equal(cadastro.conta.celular, null);
    assert.equal(cadastro.conta.papel, 'CLIENTE');
    assert.equal(cadastro.conta.profissional, false);
    return { email, token: (await req('/auth/login', {body: {email, senha}})).token };
  }

  await req('/saude');
  await req('/pedidos', {status: 401});
  const acessoEngenheiro = await req('/auth/login', {body: {celular, senha}});
  assert.equal(acessoEngenheiro.conta.profissional, true);
  const engenheiro = acessoEngenheiro.token;
  const { email: emailPrimeiro, token: sessaoInicial } = await cliente('Cliente Demo A');
  const { token: segundo } = await cliente('Cliente Demo B');
  const dados = {servico: 'Topografia', celular: '(84) 90000-1234', link: 'https://example.test/local', municipio: 'Mossoró', comunidade: 'Sítio Demo', local: 'Entrada da comunidade', descricao: 'Levantamento do terreno fictício'};
  const a = await req('/pedidos', {token: sessaoInicial, body: dados});
  await req('/auth/sair', {token: sessaoInicial, body: {}, status: 204});
  await req('/pedidos/' + a.id, {token: sessaoInicial, status: 401});
  const primeiro = (await req('/auth/login', {body: {email: emailPrimeiro, senha}})).token;
  assert.equal((await req('/pedidos/' + a.id, {token: primeiro})).id, a.id);
  const b = await req('/pedidos', {token: segundo, body: {...dados, comunidade: 'Outro sítio'}});
  assert.equal(a.situacao, 'RECEBIDO');
  assert.equal(a.celular, '84900001234');
  assert.equal(a.link, dados.link);
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
  const dia = dias.find(data => ['06:00', '07:00', '09:00', '10:00', '11:00'].every(h =>
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
  const ocupado = await req('/pedidos/' + perdedor.id, {token: engenheiro});
  const remarcacao = {pedidoId: vencedor.id, dia, horarioAnterior: salvo.visita.horario};
  const remarcar = (hora, token = engenheiro, status = 201) =>
    req('/visitas/remarcacao', {token, body: {...remarcacao, hora}, status});
  await remarcar('10:00', tokenVencedor, 403);
  await remarcar(ocupado.visita.horario.slice(11, 16) === '09:00' ? '06:00' : '07:00', engenheiro, 409);
  const remarcado = await remarcar('10:00');
  assert.equal(remarcado.visita.id, salvo.visita.id);
  await remarcar('11:00', engenheiro, 409);
  assert.equal((await req('/pedidos/' + vencedor.id, {token: tokenVencedor})).visita.horario,
    new Date(dia + 'T10:00:00-03:00').toISOString());
  await req('/pedidos/' + vencedor.id + '/conclusao', {token: engenheiro, body: {}});
  const concluido = await req('/pedidos/' + vencedor.id, {token: tokenVencedor});
  assert.equal(concluido.situacao, 'CONCLUIDO');
  assert.deepEqual(concluido.visita, remarcado.visita);
  assert.ok(!(await req('/visitas', {token: engenheiro})).some(v => v.pedido.id === vencedor.id));
});
