import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const prefixo = 'scrypt-v2:';
const opcoes = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const hashReserva = prefixo + '00'.repeat(16) + ':' + '00'.repeat(64);

function derivar(senha: string, sal: string, legado = false) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(senha, sal, 64, legado ? {} : opcoes, (erro, chave) => {
      if (erro) reject(erro);
      else resolve(chave);
    });
  });
}

export function hashLegado(hash: string) {
  return !hash.startsWith(prefixo);
}

export async function gerarHash(senha: string) {
  const sal = randomBytes(16).toString('hex');
  const chave = await derivar(senha, sal);
  return prefixo + sal + ':' + chave.toString('hex');
}

export async function verificarSenha(senha: string, hash: string) {
  const legado = hashLegado(hash);
  const [sal, hex, restante] = (legado ? hash : hash.slice(prefixo.length)).split(':');
  if (!/^[a-f0-9]{32}$/.test(sal) || !/^[a-f0-9]{128}$/.test(hex ?? '') || restante !== undefined) return false;
  const chave = await derivar(senha, sal, legado);
  return timingSafeEqual(chave, Buffer.from(hex, 'hex'));
}
