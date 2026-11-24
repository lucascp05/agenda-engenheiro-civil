import { HttpException, Injectable } from '@nestjs/common';

export type RespostaComCabecalho = { setHeader(nome: string, valor: string): void };
const janela = 15 * 60_000;
const maximoChaves = 10_000;

@Injectable()
export class LimiteAcesso {
  private readonly tentativas = new Map<string, { total: number; ate: number }>();
  private proximaLimpeza = 0;

  consumir(chave: string, maximo: number, res: RespostaComCabecalho) {
    const agora = Date.now();
    if (agora >= this.proximaLimpeza) {
      for (const [identificador, registro] of this.tentativas) {
        if (registro.ate <= agora) this.tentativas.delete(identificador);
      }
      this.proximaLimpeza = agora + 60_000;
    }
    const anterior = this.tentativas.get(chave);
    const registro = anterior && anterior.ate > agora ? anterior : { total: 0, ate: agora + janela };
    if (registro.total >= maximo || (!anterior && this.tentativas.size >= maximoChaves)) {
      res.setHeader('Retry-After', String(Math.ceil((registro.ate - agora) / 1000)));
      throw new HttpException('Muitas tentativas. Aguarde alguns minutos e tente novamente.', 429);
    }
    registro.total++;
    this.tentativas.set(chave, registro);
  }
}
