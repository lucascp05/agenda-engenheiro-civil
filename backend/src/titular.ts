import 'dotenv/config';
import { isEmail, isUUID } from 'class-validator';
import { Db } from './db';
import { gerarHash, verificarSenha } from './senha';

const db = new Db();

async function provisionar() {
  const id = process.env.AGENDA_OWNER_ID?.trim() ?? '';
  const email = process.env.AGENDA_OWNER_EMAIL?.trim().toLowerCase() ?? '';
  const nome = process.env.AGENDA_OWNER_NAME?.trim() ?? '';
  const celular = process.env.AGENDA_OWNER_PHONE?.replace(/\D/g, '') ?? '';
  if (!isUUID(id) || !isEmail(email) || email.length > 254 || nome.length < 2 ||
      nome.length > 80 || !/^\d{2}9\d{8}$/.test(celular) || process.stdin.isTTY) throw new Error();

  const partes: Buffer[] = [];
  let bytes = 0;
  for await (const parte of process.stdin) {
    bytes += parte.length;
    if (bytes > 514) throw new Error();
    partes.push(parte);
  }
  const senha = Buffer.concat(partes).toString('utf8').replace(/\r?\n$/, '');
  if (senha.length < 8 || senha.length > 128 || /[\r\n]/.test(senha)) throw new Error();

  const conta = await db.conta.findUnique({ where: { id } });
  if (conta?.papel !== 'ENGENHEIRO') throw new Error();
  if (conta.email) {
    if (conta.email === email && conta.nome === nome && conta.celular === celular &&
        conta.trocarSenha && await verificarSenha(senha, conta.hash)) return;
    throw new Error();
  }
  const hash = await gerarHash(senha);
  await db.$transaction(async tx => {
    const alteradas = await tx.conta.updateMany({
      where: { id, papel: 'ENGENHEIRO', email: null, versaoSessao: conta.versaoSessao },
      data: { nome, email, celular, hash, trocarSenha: true, versaoSessao: { increment: 1 } },
    });
    if (!alteradas.count) throw new Error();
    await tx.sessaoAcesso.deleteMany({ where: { contaId: id } });
    await tx.tokenEmail.deleteMany({ where: { OR: [{ contaId: id }, { email }] } });
  });
}

void provisionar().then(() => console.log('Titular provisionado.')).catch(() => {
  console.error('Não foi possível provisionar o titular. Confira a conta existente e os dados de configuração.');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
