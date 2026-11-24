import 'dotenv/config';
import { isEmail } from 'class-validator';
import { Db } from './db';
import { Email } from './email';

const db = new Db();

async function convidar() {
  const id = process.env.AGENDA_OWNER_ID?.trim();
  const email = process.env.AGENDA_OWNER_EMAIL?.trim().toLowerCase();
  if (!id || !email || !isEmail(email) || email.length > 254) throw new Error();
  const conta = await db.conta.findUnique({ where: { id } });
  if (!conta || conta.papel !== 'ENGENHEIRO' || (conta.email && conta.email !== email)) throw new Error();
  if (await db.conta.count({ where: { email, id: { not: id } } })) throw new Error();
  await new Email(db).enviar({ finalidade: 'PROPRIETARIO', contaId: id, email, versao: conta.versaoSessao });
  console.log('Convite profissional enviado.');
}

void convidar().catch(() => {
  console.error('Convite indisponível. Confira a conta selecionada, o endereço e o serviço de envio.');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
