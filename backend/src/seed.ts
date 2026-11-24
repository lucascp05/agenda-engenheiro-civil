import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { normalizarCelular } from './dto';
import { gerarHash } from './senha';

const db = new PrismaClient();

async function provisionarConta() {
  const admin = process.argv.includes('--admin');
  const prefixo = admin ? 'ADMIN' : 'ENGINEER';
  const papel = admin ? 'ADMIN' : 'ENGENHEIRO';
  const nome = process.env[prefixo + '_NAME']?.trim();
  const celular = normalizarCelular(process.env[prefixo + '_PHONE']);
  const senha = process.env[prefixo + '_PASSWORD'];
  const tamanhoMinimo = admin || process.env.AGENDA_PUBLICACAO === '1' ? 15 : 8;
  if (!nome || nome.length < 2 || nome.length > 80 || typeof celular !== 'string' || !/^[1-9][0-9]9[0-9]{8}$/.test(celular) || !senha || senha.length < tamanhoMinimo || senha.length > 128) {
    throw new Error('Variáveis da conta incompletas ou inválidas.');
  }
  const existente = await db.conta.findUnique({ where: { celular } });
  if (existente && existente.papel !== papel) throw new Error('O celular pertence a uma conta de outro perfil.');
  const hash = await gerarHash(senha);
  if (existente) await db.$transaction([
    db.conta.update({ where: { id: existente.id }, data: { nome, hash, versaoSessao: { increment: 1 } } }),
    db.sessaoAcesso.deleteMany({ where: { contaId: existente.id } }),
  ]);
  else await db.conta.create({ data: { nome, celular, hash, papel } });
  console.log(admin ? 'Conta de administração configurada.' : 'Conta profissional configurada. A verificação é feita pela administração.');
}

void provisionarConta().catch(() => {
  console.error('Falha ao configurar a conta. Confira as variáveis e se o celular pertence a outro perfil.');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
