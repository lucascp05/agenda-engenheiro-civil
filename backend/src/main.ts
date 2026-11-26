import 'dotenv/config';
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, createParamDecorator,
  ExecutionContext, ForbiddenException, Get, HttpCode, HttpException, Injectable, Module, NotFoundException, Param,
  ParseUUIDPipe, Post, Query, Res, SetMetadata, UnauthorizedException, UseGuards, ValidationPipe, type ValidationError,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Papel, Prisma, Situacao } from '@prisma/client';
import helmet from 'helmet';
import { Db } from './db';
import { Email } from './email';
import { CadastroDiretoDto, CadastroDto, EmailDto, FiltrosDto, LoginDto, MensagemDto, PedidoDto, PerfilProfissionalDto, RecuperacaoCodigoDto, SenhaEmailDto, TokenEmailDto, TrocaSenhaDto, RemarcacaoDto, VisitaDto } from './dto';
import { gerarHash, hashLegado, hashReserva, verificarSenha } from './senha';
import { LimiteAcesso, type RespostaComCabecalho } from './limite-acesso';

type Sessao = { sub: string; papel: Papel; id: string; ver: number; profissionalAutorizado: boolean };
const PermitirSenhaInicial = () => SetMetadata('permitirSenhaInicial', true);
type TokenSessao = { sub: string; jti: string; ver: number };
const Usuario = createParamDecorator((_, contexto: ExecutionContext) =>
  contexto.switchToHttp().getRequest().usuario as Sessao);
const contaPublica = { id: true, nome: true, celular: true, email: true, papel: true };
const contaAutenticada = { ...contaPublica, emailVerificado: true } satisfies Prisma.ContaSelect;
const novoCodigo = () => randomBytes(24).toString('base64url');
const resumirCodigo = (codigo: string) => createHash('sha256').update(codigo).digest('hex');

function identificadorConta(dados: Pick<LoginDto, 'email' | 'celular'>) {
  if (Boolean(dados.email) === Boolean(dados.celular)) throw new BadRequestException('Informe um e-mail ou celular.');
  return dados.email ? { email: dados.email } : { celular: dados.celular! };
}
const dadosPedido = {
  cliente: { select: contaPublica },
  mensagens: { orderBy: { criadoEm: 'asc' } },
  visita: true,
} satisfies Prisma.PedidoInclude;

function erroUnico(erro: unknown) {
  return erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002';
}

function exigirPapel(usuario: Sessao, papel: Papel) {
  if (usuario.papel !== papel) throw new ForbiddenException('Sua conta não tem acesso a esta ação.');
}

function exigirProfissional(usuario: Sessao) {
  exigirPapel(usuario, 'ENGENHEIRO');
  if (!usuario.profissionalAutorizado) throw new ForbiddenException('Esta conta não administra a agenda.');
}

function exigirAcessoAosPedidos(usuario: Sessao) {
  if (usuario.papel !== 'CLIENTE') exigirProfissional(usuario);
}

const jwtSecret = process.env.JWT_SECRET;
const publicacao = process.env.AGENDA_PUBLICACAO === '1';
if (!jwtSecret || jwtSecret.length < 32) throw new Error('Configure JWT_SECRET com pelo menos 32 caracteres.');
if (publicacao && jwtSecret.startsWith('apenas-demo-local')) throw new Error('Configure um JWT_SECRET próprio para a publicação.');
if (publicacao && new URL(process.env.DATABASE_URL ?? '').password === 'apenas-demo-local') {
  throw new Error('Configure uma senha própria para o PostgreSQL.');
}
const proprietario = process.env.AGENDA_OWNER_ID?.trim();
const emailProprietario = process.env.AGENDA_OWNER_EMAIL?.trim().toLowerCase();
const ehProprietario = (id: string, papel: Papel) => papel === 'ENGENHEIRO' && id === proprietario;
const duracaoSessao = 8 * 60 * 60;

@Injectable()
class Autenticacao implements CanActivate {
  constructor(private jwt: JwtService, private db: Db, private reflector: Reflector) {}

  async canActivate(contexto: ExecutionContext) {
    const req = contexto.switchToHttp().getRequest();
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Entre na sua conta.');
    const invalida = () => new UnauthorizedException('Sua sessão terminou. Entre novamente.');
    const dados = await this.jwt.verifyAsync<TokenSessao>(token).catch(() => { throw invalida(); });
    if (typeof dados.jti !== 'string' || typeof dados.sub !== 'string' || !Number.isInteger(dados.ver)) throw invalida();
    const sessao = await this.db.sessaoAcesso.findUnique({
      where: { id: dados.jti },
      select: { contaId: true, expiraEm: true, conta: { select: {
        papel: true, versaoSessao: true, trocarSenha: true,
      } } },
    });
    if (!sessao || sessao.contaId !== dados.sub || sessao.expiraEm <= new Date() || sessao.conta.versaoSessao !== dados.ver) throw invalida();
    if (sessao.conta.trocarSenha && !this.reflector.get('permitirSenhaInicial', contexto.getHandler())) {
      throw new ForbiddenException('Troque a senha inicial para continuar.');
    }
    const usuario: Sessao = {
      id: dados.jti, sub: sessao.contaId, papel: sessao.conta.papel, ver: dados.ver,
      profissionalAutorizado: ehProprietario(sessao.contaId, sessao.conta.papel),
    };
    req.usuario = usuario;
    return true;
  }
}

@Injectable()
class LimitePorIp implements CanActivate {
  constructor(private limites: LimiteAcesso) {}

  canActivate(contexto: ExecutionContext) {
    const http = contexto.switchToHttp();
    const cadastro = contexto.getHandler().name.startsWith('cadastro');
    const ip = http.getRequest<{ ip?: string }>().ip ?? 'desconhecido';
    this.limites.consumir((cadastro ? 'cadastro-ip:' : 'login-ip:') + ip, cadastro ? 12 : 30, http.getResponse());
    return true;
  }
}

@Controller()
class Acesso {
  constructor(private db: Db, private jwt: JwtService, private limites: LimiteAcesso, private email: Email) {}

  @Get('saude')
  async saude() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true };
  }

  @Get('auth/recursos')
  recursos() {
    const emailDisponivel = this.email.disponivel();
    return {
      emailDisponivel,
      ...(this.email.cadastroAcademicoDisponivel() && { cadastroAcademicoDisponivel: true }),
      ...(emailDisponivel && proprietario && emailProprietario ? { conviteProfissionalDisponivel: true } : {}),
    };
  }

  @Post('auth/cadastro')
  @HttpCode(202)
  @UseGuards(LimitePorIp)
  async cadastro(@Body() dados: CadastroDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    this.email.exigirDisponibilidade(dados.email);
    this.limites.consumir('cadastro-email:' + dados.email, 5, res);
    if (dados.email !== emailProprietario && !await this.db.conta.count({ where: { email: dados.email } })) {
      await this.email.enviar({ finalidade: 'CADASTRO', ...dados });
    }
    return { mensagem: 'Se o endereço puder ser cadastrado, você receberá um link para criar sua conta.' };
  }

  @Post('auth/contas')
  @UseGuards(LimitePorIp)
  async cadastroDireto(@Body() dados: CadastroDiretoDto) {
    const identificador = identificadorConta(dados);
    const conflito = () => new ConflictException('Este identificador já está em uso. Entre na sua conta ou recupere o acesso.');
    if (dados.email && dados.email === emailProprietario) throw conflito();
    const codigo = novoCodigo();
    const hash = await gerarHash(dados.senha);
    try {
      const sessao = await this.db.$transaction(async tx => {
        const conta = await tx.conta.create({
          data: { ...identificador, nome: dados.nome, papel: 'CLIENTE', hash, recuperacaoHash: resumirCodigo(codigo) },
          select: contaAutenticada,
        });
        return this.sessao(conta, 0, false, tx);
      });
      return { ...sessao, codigo };
    } catch (erro) {
      if (erroUnico(erro)) throw conflito();
      throw erro;
    }
  }

  @Post('auth/recuperacao-codigo')
  @HttpCode(200)
  @UseGuards(LimitePorIp)
  async recuperarPorCodigo(@Body() dados: RecuperacaoCodigoDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    const identificador = identificadorConta(dados);
    this.limites.consumir('recuperacao-codigo:' + (dados.email ?? dados.celular), 8, res);
    const recuperacaoHash = resumirCodigo(dados.codigo);
    const invalido = () => new UnauthorizedException('Identificador ou código de recuperação inválido.');
    const conta = await this.db.conta.findFirst({
      where: { ...identificador, recuperacaoHash, papel: 'CLIENTE' },
      select: { id: true, versaoSessao: true },
    });
    if (!conta) throw invalido();
    const codigo = novoCodigo();
    const hash = await gerarHash(dados.senha);
    await this.db.$transaction(async tx => {
      const where = { id: conta.id, recuperacaoHash, versaoSessao: conta.versaoSessao };
      const data = { hash, recuperacaoHash: resumirCodigo(codigo), versaoSessao: { increment: 1 } };
      if (!(await tx.conta.updateMany({ where, data })).count) throw invalido();
      await tx.sessaoAcesso.deleteMany({ where: { contaId: conta.id } });
      await tx.tokenEmail.deleteMany({ where: { contaId: conta.id } });
    });
    return { codigo };
  }

  @Post('auth/confirmar-email')
  @UseGuards(LimitePorIp)
  async confirmarEmail(@Body() dados: SenhaEmailDto) {
    try {
      const conta = await this.db.$transaction(async tx => {
        const registro = await this.email.consumir(tx, dados.token, 'CADASTRO');
        this.email.exigirConfirmacaoPermitida(registro.email);
        if (registro.email === emailProprietario) throw new ConflictException('Este link já não pode ser usado.');
        return tx.conta.create({
          data: { email: registro.email, emailVerificado: true, nome: registro.nome!, hash: await gerarHash(dados.senha), papel: 'CLIENTE' },
          select: contaAutenticada,
        });
      });
      return this.sessao(conta, 0);
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException('Este link já não pode ser usado. Entre na sua conta.');
      throw erro;
    }
  }

  @Post('auth/login')
  @UseGuards(LimitePorIp)
  async login(@Body() dados: LoginDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    const identificador = identificadorConta(dados);
    this.limites.consumir('login-identificador:' + (dados.email ?? dados.celular), 8, res);
    const conta = await this.db.conta.findUnique({ where: identificador });
    const valida = await verificarSenha(dados.senha, conta?.hash ?? hashReserva);
    if (!conta || !valida) throw new UnauthorizedException('Dados de acesso incorretos.');
    const { id, nome, celular, email, papel, emailVerificado } = conta;
    if (hashLegado(conta.hash)) {
      await this.db.conta.updateMany({ where: { id, hash: conta.hash }, data: { hash: await gerarHash(dados.senha) } });
    }
    return this.sessao({ id, nome, celular, email, papel, emailVerificado }, conta.versaoSessao, conta.trocarSenha);
  }

  @Post('auth/vincular-email')
  @HttpCode(202)
  @UseGuards(Autenticacao, LimitePorIp)
  async vincularEmail(@Usuario() usuario: Sessao, @Body() dados: EmailDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    exigirAcessoAosPedidos(usuario);
    if (dados.email === emailProprietario) throw new ConflictException('Este e-mail está reservado.');
    this.limites.consumir('vinculo-conta:' + usuario.sub, 5, res);
    this.limites.consumir('vinculo-email:' + dados.email, 5, res);
    const conta = await this.db.conta.findUniqueOrThrow({ where: { id: usuario.sub } });
    if (conta.email) throw new ConflictException('Esta conta já tem um e-mail vinculado.');
    await this.email.enviar({ finalidade: 'VINCULO', email: dados.email, contaId: conta.id, versao: conta.versaoSessao });
    return { mensagem: 'Enviamos o link. Abra-o no navegador em que sua conta está aberta.' };
  }

  @Post('auth/confirmar-vinculo')
  @UseGuards(Autenticacao, LimitePorIp)
  async confirmarVinculo(@Usuario() usuario: Sessao, @Body() dados: TokenEmailDto) {
    exigirAcessoAosPedidos(usuario);
    try {
      const conta = await this.db.$transaction(async tx => {
        const registro = await this.email.consumir(tx, dados.token, 'VINCULO', usuario.sub);
        if (registro.email === emailProprietario) throw new ConflictException('Este e-mail está reservado.');
        const where = { id: usuario.sub, email: null, versaoSessao: registro.versao! };
        if (!(await tx.conta.updateMany({ where, data: { email: registro.email, emailVerificado: true } })).count) {
          throw new ConflictException('Esta conta já tem um e-mail vinculado ou o link venceu.');
        }
        return tx.conta.findUniqueOrThrow({ where: { id: usuario.sub }, select: contaAutenticada });
      });
      return { conta };
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException('Já existe uma conta com esse e-mail.');
      throw erro;
    }
  }

  @Post('auth/recuperacao')
  @HttpCode(202)
  @UseGuards(LimitePorIp)
  async recuperacao(@Body() dados: EmailDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    this.email.exigirDisponibilidade();
    this.limites.consumir('recuperacao-email:' + dados.email, 5, res);
    const conta = await this.db.conta.findUnique({ where: { email: dados.email } });
    if (conta?.emailVerificado && !conta.trocarSenha) {
      await this.email.enviar({ finalidade: 'RECUPERACAO', email: dados.email, contaId: conta.id, versao: conta.versaoSessao })
        .catch(() => console.warn('Não foi possível enviar um e-mail de recuperação.'));
    }
    return { mensagem: 'Se houver uma conta com esse e-mail, você receberá um link para redefinir a senha.' };
  }

  @Post('auth/redefinir-senha')
  @HttpCode(204)
  @UseGuards(LimitePorIp)
  async redefinirSenha(@Body() dados: SenhaEmailDto) {
    await this.db.$transaction(async tx => {
      const registro = await this.email.consumir(tx, dados.token, 'RECUPERACAO');
      const where = { id: registro.contaId!, email: registro.email, emailVerificado: true, versaoSessao: registro.versao!, trocarSenha: false };
      const resultado = await tx.conta.updateMany({
        where, data: { hash: await gerarHash(dados.senha), versaoSessao: { increment: 1 } },
      });
      if (!resultado.count) throw new BadRequestException('Link inválido ou vencido. Solicite um novo e-mail.');
      await tx.sessaoAcesso.deleteMany({ where: { contaId: registro.contaId! } });
    });
  }

  @Post('auth/ativar-profissional')
  @HttpCode(204)
  @UseGuards(LimitePorIp)
  async ativarProfissional(@Body() dados: SenhaEmailDto) {
    if (!proprietario) throw new ForbiddenException('Área profissional indisponível.');
    try {
      await this.db.$transaction(async tx => {
        const registro = await this.email.consumir(tx, dados.token, 'PROPRIETARIO', proprietario);
        if (emailProprietario && registro.email !== emailProprietario) {
          throw new BadRequestException('Convite inválido ou vencido.');
        }
        const resultado = await tx.conta.updateMany({
          where: {
            id: proprietario, papel: 'ENGENHEIRO', versaoSessao: registro.versao!,
            OR: [{ email: null }, { email: registro.email }],
          },
          data: { email: registro.email, emailVerificado: true, hash: await gerarHash(dados.senha), versaoSessao: { increment: 1 } },
        });
        if (!resultado.count) throw new BadRequestException('Convite inválido ou vencido.');
        await tx.sessaoAcesso.deleteMany({ where: { contaId: proprietario } });
      });
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException('Este e-mail já pertence a outra conta.');
      throw erro;
    }
  }

  @Post('auth/convite-profissional')
  @HttpCode(202)
  @UseGuards(LimitePorIp)
  async conviteProfissional(@Body() dados: EmailDto) {
    const resposta = { mensagem: 'Se o endereço estiver autorizado, você receberá um link para definir sua senha.' };
    if (!proprietario || !emailProprietario || !this.email.disponivel() || dados.email !== emailProprietario) return resposta;
    try {
      this.limites.consumir('convite-profissional:' + proprietario, 3, { setHeader() {} });
    } catch (erro) {
      if (erro instanceof HttpException && erro.getStatus() === 429) return resposta;
      throw erro;
    }
    const conta = await this.db.conta.findUnique({ where: { id: proprietario } });
    if (conta?.papel === 'ENGENHEIRO' && conta.email === null &&
        !await this.db.conta.count({ where: { email: emailProprietario } })) {
      await this.email.enviar({
        finalidade: 'PROPRIETARIO', contaId: conta.id, email: emailProprietario, versao: conta.versaoSessao,
      }).catch(() => console.warn('Não foi possível enviar o convite profissional.'));
    }
    return resposta;
  }

  @Post('auth/sair')
  @HttpCode(204)
  @PermitirSenhaInicial()
  @UseGuards(Autenticacao)
  async sair(@Usuario() usuario: Sessao) {
    await this.db.sessaoAcesso.deleteMany({ where: { id: usuario.id, contaId: usuario.sub } });
  }

  @Post('auth/trocar-senha')
  @HttpCode(204)
  @PermitirSenhaInicial()
  @UseGuards(Autenticacao, LimitePorIp)
  async trocarSenha(@Usuario() usuario: Sessao, @Body() dados: TrocaSenhaDto) {
    exigirProfissional(usuario);
    const conta = await this.db.conta.findUniqueOrThrow({ where: { id: usuario.sub } });
    if (conta.versaoSessao !== usuario.ver) throw new UnauthorizedException('Sua sessão terminou. Entre novamente.');
    if (!await verificarSenha(dados.senhaAtual, conta.hash)) throw new BadRequestException('Senha atual incorreta.');
    if (dados.senha === dados.senhaAtual) throw new BadRequestException('Escolha uma senha diferente da atual.');
    const hash = await gerarHash(dados.senha);
    await this.db.$transaction(async tx => {
      const alteradas = await tx.conta.updateMany({
        where: { id: usuario.sub, versaoSessao: usuario.ver, hash: conta.hash },
        data: { hash, trocarSenha: false, versaoSessao: { increment: 1 } },
      });
      if (!alteradas.count) throw new UnauthorizedException('Sua sessão terminou. Entre novamente.');
      await tx.sessaoAcesso.deleteMany({ where: { contaId: usuario.sub } });
    });
  }

  private async sessao(conta: { id: string; nome: string; celular: string | null; email: string | null; papel: Papel; emailVerificado: boolean }, ver: number, trocarSenha = false, tx?: Prisma.TransactionClient) {
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + duracaoSessao * 1000);
    const criar = (db: Prisma.TransactionClient) => db.sessaoAcesso.create({ data: { contaId: conta.id, expiraEm }, select: { id: true } });
    const { id } = tx ? await criar(tx) : (await this.db.$transaction([
      this.db.sessaoAcesso.deleteMany({ where: { expiraEm: { lte: agora } } }),
      criar(this.db),
    ]))[1];
    return { conta: { ...conta, profissional: ehProprietario(conta.id, conta.papel), ...(trocarSenha && { trocarSenha }) }, expiraEm, token: await this.jwt.signAsync({ sub: conta.id, jti: id, ver }) };
  }
}

const dadosRegistro = {
  nomeCompleto: true, titulo: true, creaUf: true, registro: true, autorizaPublicacao: true,
} satisfies Prisma.PerfilProfissionalSelect;

@Controller('profissionais')
class ProfissionaisController {
  constructor(private db: Db) {}

  @Get('publico')
  async publico() {
    const perfil = proprietario ? await this.db.perfilProfissional.findFirst({
      where: { contaId: proprietario, conta: { papel: 'ENGENHEIRO' }, autorizaPublicacao: true },
      select: { nomeCompleto: true, titulo: true, creaUf: true, registro: true },
    }) : null;
    return { perfil };
  }

  @Get('meu-perfil')
  @UseGuards(Autenticacao)
  async meuPerfil(@Usuario() usuario: Sessao) {
    exigirProfissional(usuario);
    const perfil = await this.db.perfilProfissional.findUnique({
      where: { contaId: usuario.sub }, select: dadosRegistro,
    });
    return { perfil };
  }

  @Post('meu-perfil')
  @UseGuards(Autenticacao)
  async salvarPerfil(@Usuario() usuario: Sessao, @Body() dados: PerfilProfissionalDto) {
    exigirProfissional(usuario);
    return this.db.perfilProfissional.upsert({
      where: { contaId: usuario.sub }, create: { ...dados, contaId: usuario.sub },
      update: dados, select: dadosRegistro,
    });
  }
}

@Injectable()
class PedidosService {
  constructor(private db: Db) {}

  async obter(id: string, usuario: Sessao) {
    const pedido = await this.db.pedido.findFirst({
      where: { id, clienteId: usuario.papel === 'CLIENTE' ? usuario.sub : undefined },
      include: dadosPedido,
    });
    if (!pedido) throw new NotFoundException('Pedido não encontrado.');
    return pedido;
  }

  listar(usuario: Sessao, filtros: FiltrosDto) {
    return this.db.pedido.findMany({
      where: {
        clienteId: usuario.papel === 'CLIENTE' ? usuario.sub : undefined,
        municipio: filtros.municipio ? { contains: filtros.municipio, mode: 'insensitive' } : undefined,
        comunidade: filtros.comunidade ? { contains: filtros.comunidade, mode: 'insensitive' } : undefined,
      },
      include: dadosPedido,
      orderBy: { criadoEm: 'desc' },
    });
  }

  criar(usuario: Sessao, dados: PedidoDto) {
    exigirPapel(usuario, 'CLIENTE');
    return this.db.pedido.create({ data: { ...dados, clienteId: usuario.sub }, include: dadosPedido });
  }

  async alterar(usuario: Sessao, id: string, destino: Situacao, origens: Situacao[], texto?: string, horario?: Date, horarioAnterior?: Date) {
    try {
      return await this.db.$transaction(async tx => {
        const where = { id, clienteId: usuario.papel === 'CLIENTE' ? usuario.sub : undefined };
        const alterados = await tx.pedido.updateMany({
          where: { ...where, situacao: { in: origens } },
          data: { situacao: destino },
        });
        if (!alterados.count) {
          if (!(await tx.pedido.count({ where }))) throw new NotFoundException('Pedido não encontrado.');
          throw new ConflictException('A situação do pedido mudou. Atualize a lista e tente novamente.');
        }
        if (texto) await tx.mensagem.create({ data: { pedidoId: id, autor: usuario.papel, texto } });
        if (horario && horarioAnterior) {
          const visita = await tx.visita.updateMany({ where: { pedidoId: id, horario: horarioAnterior }, data: { horario } });
          if (!visita.count) throw new ConflictException('A visita mudou. Atualize a lista e tente novamente.');
        } else if (horario) {
          await tx.visita.create({ data: { pedidoId: id, horario } });
        }
        return tx.pedido.findUniqueOrThrow({ where: { id }, include: dadosPedido });
      });
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException({ message: 'Já existe visita neste horário.', campos: { hora: 'Este horário está ocupado.' } });
      throw erro;
    }
  }

  visitas() {
    return this.db.visita.findMany({
      where: { pedido: { situacao: 'MARCADO' } },
      orderBy: { horario: 'asc' },
      include: { pedido: { select: { id: true, servico: true, municipio: true, comunidade: true, local: true, cliente: { select: { nome: true } } } } },
    });
  }
}

@Controller('pedidos')
@UseGuards(Autenticacao)
class PedidosController {
  constructor(private pedidos: PedidosService) {}

  @Get()
  listar(@Usuario() usuario: Sessao, @Query() filtros: FiltrosDto) {
    exigirAcessoAosPedidos(usuario);
    return this.pedidos.listar(usuario, filtros);
  }

  @Get(':id')
  obter(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string) {
    exigirAcessoAosPedidos(usuario);
    return this.pedidos.obter(id, usuario);
  }

  @Post()
  criar(@Usuario() usuario: Sessao, @Body() dados: PedidoDto) {
    return this.pedidos.criar(usuario, dados);
  }

  @Post(':id/informacoes')
  informar(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string, @Body() dados: MensagemDto) {
    exigirProfissional(usuario);
    return this.pedidos.alterar(usuario, id, 'INFORMACOES', ['RECEBIDO','INFORMACOES'], dados.texto);
  }

  @Post(':id/respostas')
  responder(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string, @Body() dados: MensagemDto) {
    exigirPapel(usuario, 'CLIENTE');
    return this.pedidos.alterar(usuario, id, 'RECEBIDO', ['INFORMACOES'], dados.texto);
  }

  @Post(':id/conclusao')
  concluir(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string) {
    exigirProfissional(usuario);
    return this.pedidos.alterar(usuario, id, 'CONCLUIDO', ['RECEBIDO','INFORMACOES','MARCADO']);
  }
}

const fuso = 'America/Sao_Paulo';
const diaBrasilia = new Intl.DateTimeFormat('sv-SE', { timeZone: fuso });
const horaBrasilia = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

@Controller('visitas')
@UseGuards(Autenticacao)
class VisitasController {
  constructor(private pedidos: PedidosService) {}

  @Post()
  marcar(@Usuario() usuario: Sessao, @Body() dados: VisitaDto) {
    exigirProfissional(usuario);
    return this.pedidos.alterar(usuario, dados.pedidoId, 'MARCADO', ['RECEBIDO','INFORMACOES'], undefined, this.horario(dados));
  }

  @Post('remarcacao')
  remarcar(@Usuario() usuario: Sessao, @Body() dados: RemarcacaoDto) {
    exigirProfissional(usuario);
    return this.pedidos.alterar(usuario, dados.pedidoId, 'MARCADO', ['MARCADO'], undefined, this.horario(dados), new Date(dados.horarioAnterior));
  }

  private horario(dados: VisitaDto) {
    const horario = new Date(dados.dia + 'T' + dados.hora + ':00-03:00');
    if (isNaN(horario.getTime()) || diaBrasilia.format(horario) !== dados.dia || horaBrasilia.format(horario) !== dados.hora || horario <= new Date()) {
      throw new BadRequestException({ message: 'Escolha um horário futuro no fuso de Brasília.', campos: { dia: 'Escolha uma data e um horário futuros.' } });
    }
    return horario;
  }

  @Get()
  listar(@Usuario() usuario: Sessao) {
    exigirProfissional(usuario);
    return this.pedidos.visitas();
  }
}

@Module({
  imports: [JwtModule.register({
    secret: jwtSecret,
    signOptions: { algorithm: 'HS256', expiresIn: duracaoSessao, issuer: 'agenda-api', audience: 'agenda-web' },
    verifyOptions: { algorithms: ['HS256'], issuer: 'agenda-api', audience: 'agenda-web' },
  })],
  controllers: [Acesso, PedidosController, VisitasController, ProfissionaisController],
  providers: [Db, Autenticacao, LimiteAcesso, LimitePorIp, PedidosService, Email],
})
class App {}

function errosDeCampos(erros: ValidationError[]): [string, string][] {
  return erros.flatMap(erro => erro.children?.length
    ? errosDeCampos(erro.children)
    : [[erro.property, erro.constraints?.matches ??
      (erro.property === 'senha' ? erro.constraints?.isLength : undefined) ?? 'Confira este campo.']]);
}

async function iniciar() {
  const origens = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(origem => origem.trim());
  if (origens.some(origem => !/^https?:\/\/[^/]+$/.test(origem)) ||
      (publicacao && (origens.length !== 1 || origens[0] !== 'https://' + process.env.SITE_DOMAIN))) {
    throw new Error('Configure uma lista de origens autorizadas.');
  }
  const app = await NestFactory.create(App, { logger: false, bodyParser: true });
  if (publicacao) app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(helmet());
  app.use((_req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: origens,
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: ['Authorization','Content-Type'],
  });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    exceptionFactory: erros => new BadRequestException({
      message: 'Confira os campos destacados.',
      campos: Object.fromEntries(errosDeCampos(erros)),
    }),
  }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void iniciar().catch(() => { console.error('Não foi possível iniciar a API.'); process.exitCode = 1; });
