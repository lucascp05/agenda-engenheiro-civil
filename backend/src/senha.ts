import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derivar = promisify(scrypt);

export async function gerarHash(senha: string) {
  const sal = randomBytes(16).toString('hex');
  const chave = await derivar(senha, sal, 64) as Buffer;
  return sal + ':' + chave.toString('hex');
}

export async function verificarSenha(senha: string, hash: string) {
  const [sal, hex] = hash.split(':');
  const esperada = Buffer.from(hex, 'hex');
  const chave = await derivar(senha, sal, 64) as Buffer;
  return timingSafeEqual(chave, esperada);
}
