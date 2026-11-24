import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { gerarHash, verificarSenha } from './senha';

const db = new PrismaClient();
const clientes = [
  { nome: 'Cliente de demonstração A', celular: '11900000001', senha: process.env.DEMO_CLIENTE_A_SENHA },
  { nome: 'Cliente de demonstração B', celular: '11900000002', senha: process.env.DEMO_CLIENTE_B_SENHA },
];

async function criar() {
  const [a, b] = clientes;
  if (clientes.some(({ senha }) => !senha || senha.length < 15 || senha.length > 128) || a.senha === b.senha) {
    throw new Error();
  }
  await db.$transaction(async tx => {
    for (const { nome, celular, senha } of clientes) {
      const existente = await tx.conta.findUnique({ where: { celular } });
      if (existente) {
        if (existente.papel !== 'CLIENTE' || existente.nome !== nome || existente.email ||
            !await verificarSenha(senha!, existente.hash)) throw new Error();
      } else {
        await tx.conta.create({ data: { nome, celular, papel: 'CLIENTE', hash: await gerarHash(senha!) } });
      }
    }
  });
  console.log('Duas contas fictícias disponíveis para a demonstração.');
}

void criar().catch(() => {
  console.error('Contas de demonstração indisponíveis. Confira as variáveis privadas e os números reservados.');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
