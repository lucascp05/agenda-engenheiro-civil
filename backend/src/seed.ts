import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { normalizarCelular } from './dto';
import { gerarHash } from './senha';

const db = new PrismaClient();

async function cadastrarEngenheiro() {
  const nome = process.env.ENGINEER_NAME?.trim();
  const celular = normalizarCelular(process.env.ENGINEER_PHONE);
  const senha = process.env.ENGINEER_PASSWORD;
  const tamanhoMinimo = process.env.AGENDA_PUBLICACAO === '1' ? 15 : 8;
  if (!nome || nome.length < 2 || nome.length > 80 || typeof celular !== 'string' || !/^[1-9][0-9]9[0-9]{8}$/.test(celular) || !senha || senha.length < tamanhoMinimo || senha.length > 128) {
    throw new Error('Configure ENGINEER_NAME, ENGINEER_PHONE e ENGINEER_PASSWORD.');
  }
  const existente = await db.conta.findUnique({ where: { celular } });
  if (existente?.papel === 'CLIENTE') throw new Error('O celular já pertence a uma conta de cliente.');
  const hash = await gerarHash(senha);
  if (existente) await db.$transaction([
    db.conta.update({ where: { id: existente.id }, data: { nome, hash, versaoSessao: { increment: 1 } } }),
    db.sessaoAcesso.deleteMany({ where: { contaId: existente.id } }),
  ]);
  else await db.conta.create({ data: { nome, celular, hash, papel: 'ENGENHEIRO' } });
  console.log('Conta de engenheiro configurada.');
}

void cadastrarEngenheiro().catch(() => {
  console.error('Falha ao configurar a conta. Confira as variáveis e se o celular já pertence a um cliente.');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
