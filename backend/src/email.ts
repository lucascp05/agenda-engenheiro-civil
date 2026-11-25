import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { FinalidadeEmail, Prisma } from '@prisma/client';
import { Db } from './db';

const resumir = (token: string) => createHash('sha256').update(token).digest('hex');
const invalido = () => new BadRequestException('Link inválido ou vencido. Solicite um novo e-mail.');
const assuntos: Record<FinalidadeEmail, string> = {
  CADASTRO: 'Confirme seu e-mail e crie sua conta',
  VINCULO: 'Confirme o e-mail da sua conta',
  RECUPERACAO: 'Redefina sua senha',
  PROPRIETARIO: 'Defina a senha da área do profissional',
};

@Injectable()
export class Email {
  constructor(private db: Db) {}

  private configurado() {
    return Boolean((process.env.AGENDA_PUBLICACAO !== '1' && process.env.EMAIL_TEST_URL) ||
      (process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim()));
  }

  private get destinatarioAcademico() {
    return process.env.EMAIL_ACADEMIC_RECIPIENT?.trim().toLowerCase();
  }

  private get modoAcademico() {
    return Boolean(this.destinatarioAcademico) || /(?:@|\b)resend\.dev(?:>|$)/i.test(process.env.EMAIL_FROM?.trim() ?? '');
  }

  disponivel() {
    return !this.modoAcademico && this.configurado();
  }

  cadastroAcademicoDisponivel() {
    return this.modoAcademico && Boolean(this.destinatarioAcademico) && this.configurado();
  }

  exigirDisponibilidade(emailCadastro?: string) {
    if (!this.disponivel() && !(this.cadastroAcademicoDisponivel() && emailCadastro === this.destinatarioAcademico)) {
      throw new ServiceUnavailableException('Cadastro e recuperação por e-mail estão indisponíveis nesta versão. Entre com uma conta existente.');
    }
  }

  exigirConfirmacaoPermitida(email: string) {
    if (this.modoAcademico && email !== this.destinatarioAcademico) throw invalido();
  }

  async enviar(dados: Omit<Prisma.TokenEmailUncheckedCreateInput, 'hash' | 'expiraEm'>) {
    this.exigirDisponibilidade(dados.finalidade === 'CADASTRO' ? dados.email : undefined);
    const publico = process.env.AGENDA_PUBLICACAO === '1';
    const teste = publico ? undefined : process.env.EMAIL_TEST_URL;
    const chave = process.env.RESEND_API_KEY?.trim();
    const remetente = process.env.EMAIL_FROM?.trim();
    const agora = new Date();
    const token = randomBytes(32).toString('hex');
    const hash = resumir(token);
    const expiraEm = new Date(agora.getTime() + 20 * 60 * 1000);
    const site = publico ? 'https://' + process.env.SITE_DOMAIN : process.env.EMAIL_SITE_URL || 'http://localhost:8080';
    const link = new URL(site);
    link.hash = new URLSearchParams({ acao: dados.finalidade, token }).toString();
    await this.db.$transaction([
      this.db.tokenEmail.deleteMany({ where: { expiraEm: { lte: agora } } }),
      this.db.tokenEmail.create({ data: { ...dados, hash, expiraEm } }),
    ]);
    try {
      const resposta = await fetch(teste || 'https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(!teste && { Authorization: 'Bearer ' + chave }) },
        body: JSON.stringify({
          from: remetente || 'agenda@example.test', to: [dados.email], subject: assuntos[dados.finalidade],
          text: assuntos[dados.finalidade] + ' na Agenda da Tatico Assis. O link é válido por 20 minutos.\n\n' + link.href,
        }),
        signal: AbortSignal.timeout(8000),
      });
      await resposta.body?.cancel();
      if (!resposta.ok) throw new Error();
    } catch {
      await this.db.tokenEmail.deleteMany({ where: { hash } });
      throw new ServiceUnavailableException('Não foi possível enviar o e-mail. Você pode tentar novamente com os mesmos dados.');
    }
  }

  async consumir(tx: Prisma.TransactionClient, token: string, finalidade: FinalidadeEmail, contaId?: string) {
    const where = { hash: resumir(token), finalidade, contaId, expiraEm: { gt: new Date() } };
    const registro = await tx.tokenEmail.findFirst({ where });
    if (!registro || !(await tx.tokenEmail.deleteMany({ where })).count) throw invalido();
    return registro;
  }
}
