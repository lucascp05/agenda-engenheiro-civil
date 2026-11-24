import 'dotenv/config';
import 'reflect-metadata';
import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, createParamDecorator,
  ExecutionContext, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param,
  ParseUUIDPipe, Post, Query, Res, UnauthorizedException, UseGuards, ValidationPipe, type ValidationError,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Papel, Prisma, Situacao } from '@prisma/client';
import helmet from 'helmet';
import { Db } from './db';
import { CadastroDto, CadastroProfissionalDto, ConsentimentoDto, FiltrosDto, LoginDto, MensagemDto, PedidoDto, PerfilProfissionalDto, RevisaoProfissionalDto, VisitaDto } from './dto';
import { gerarHash, hashLegado, hashReserva, verificarSenha } from './senha';
import { LimiteAcesso, type RespostaComCabecalho } from './limite-acesso';

type Sessao = { sub: string; papel: Papel; id: string; profissionalAprovado: boolean };
type TokenSessao = { sub: string; jti: string; ver: number };
const Usuario = createParamDecorator((_, contexto: ExecutionContext) =>
  contexto.switchToHttp().getRequest().usuario as Sessao);
const contaPublica = { id: true, nome: true, celular: true, papel: true };
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

function exigirProfissionalAprovado(usuario: Sessao) {
  exigirPapel(usuario, 'ENGENHEIRO');
  if (!usuario.profissionalAprovado) throw new ForbiddenException('O painel fica disponível após a aprovação profissional.');
}

function exigirAcessoAosPedidos(usuario: Sessao) {
  if (usuario.papel !== 'CLIENTE') exigirProfissionalAprovado(usuario);
}

const jwtSecret = process.env.JWT_SECRET;
const publicacao = process.env.AGENDA_PUBLICACAO === '1';
if (!jwtSecret || jwtSecret.length < 32) throw new Error('Configure JWT_SECRET com pelo menos 32 caracteres.');
if (publicacao && jwtSecret.startsWith('apenas-demo-local')) throw new Error('Configure um JWT_SECRET próprio para a publicação.');
if (publicacao && new URL(process.env.DATABASE_URL ?? '').password === 'apenas-demo-local') {
  throw new Error('Configure uma senha própria para o PostgreSQL.');
}
const duracaoSessao = 8 * 60 * 60;

@Injectable()
class Autenticacao implements CanActivate {
  constructor(private jwt: JwtService, private db: Db) {}

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
        papel: true, versaoSessao: true, perfilProfissional: { select: { situacao: true } },
      } } },
    });
    if (!sessao || sessao.contaId !== dados.sub || sessao.expiraEm <= new Date() || sessao.conta.versaoSessao !== dados.ver) throw invalida();
    req.usuario = {
      id: dados.jti, sub: sessao.contaId, papel: sessao.conta.papel,
      profissionalAprovado: sessao.conta.perfilProfissional?.situacao === 'APROVADO',
    };
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
  constructor(private db: Db, private jwt: JwtService, private limites: LimiteAcesso) {}

  @Get('saude')
  async saude() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true };
  }

  @Post('auth/cadastro')
  @UseGuards(LimitePorIp)
  async cadastro(@Body() dados: CadastroDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    this.limites.consumir('cadastro-celular:' + dados.celular, 5, res);
    try {
      const conta = await this.db.conta.create({
        data: { nome: dados.nome, celular: dados.celular, hash: await gerarHash(dados.senha), papel: 'CLIENTE' },
        select: contaPublica,
      });
      return this.sessao(conta, 0);
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException({ message: 'Entre com este celular ou procure ajuda para acessar a conta.', campos: { celular: 'Já existe uma conta com este celular.' } });
      throw erro;
    }
  }

  @Post('auth/login')
  @UseGuards(LimitePorIp)
  async login(@Body() dados: LoginDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    this.limites.consumir('login-celular:' + dados.celular, 8, res);
    const conta = await this.db.conta.findUnique({ where: { celular: dados.celular } });
    const valida = await verificarSenha(dados.senha, conta?.hash ?? hashReserva);
    if (!conta || !valida) throw new UnauthorizedException('Celular ou senha incorretos.');
    const { id, nome, celular, papel } = conta;
    if (hashLegado(conta.hash)) {
      await this.db.conta.updateMany({ where: { id, hash: conta.hash }, data: { hash: await gerarHash(dados.senha) } });
    }
    return this.sessao({ id, nome, celular, papel }, conta.versaoSessao);
  }

  @Post('auth/cadastro-profissional')
  @UseGuards(LimitePorIp)
  async cadastroProfissional(@Body() dados: CadastroProfissionalDto, @Res({ passthrough: true }) res: RespostaComCabecalho) {
    this.limites.consumir('cadastro-celular:' + dados.celular, 5, res);
    try {
      const conta = await this.db.conta.create({
        data: {
          nome: dados.nome, celular: dados.celular, hash: await gerarHash(dados.senha), papel: 'ENGENHEIRO',
          perfilProfissional: { create: { ...dados.registro, nomeCompleto: dados.nome } },
        },
        select: contaPublica,
      });
      return this.sessao(conta, 0);
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException({ message: 'Já existe uma conta com este celular. Entre para continuar.', campos: { celular: 'Já existe uma conta com este celular.' } });
      throw erro;
    }
  }

  @Post('auth/sair')
  @HttpCode(204)
  @UseGuards(Autenticacao)
  async sair(@Usuario() usuario: Sessao) {
    await this.db.sessaoAcesso.deleteMany({ where: { id: usuario.id, contaId: usuario.sub } });
  }

  private async sessao(conta: { id: string; nome: string; celular: string; papel: Papel }, ver: number) {
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + duracaoSessao * 1000);
    const [, { id }] = await this.db.$transaction([
      this.db.sessaoAcesso.deleteMany({ where: { expiraEm: { lte: agora } } }),
      this.db.sessaoAcesso.create({ data: { contaId: conta.id, expiraEm }, select: { id: true } }),
    ]);
    return { conta, expiraEm, token: await this.jwt.signAsync({ sub: conta.id, jti: id, ver }) };
  }
}

const dadosRegistro = {
  nomeCompleto: true, titulo: true, creaUf: true, registro: true, revisadoEm: true,
} satisfies Prisma.PerfilProfissionalSelect;
const dadosSolicitacao = { ...dadosRegistro, situacao: true, autorizaPublicacao: true, criadoEm: true };

@Controller('profissionais')
class ProfissionaisController {
  constructor(private db: Db) {}

  @Get('publico')
  async publico() {
    const perfil = await this.db.perfilProfissional.findFirst({
      where: { situacao: 'APROVADO', autorizaPublicacao: true },
      select: dadosRegistro,
    });
    return { perfil };
  }

  @Get('meu-perfil')
  @UseGuards(Autenticacao)
  async meuPerfil(@Usuario() usuario: Sessao) {
    exigirPapel(usuario, 'ENGENHEIRO');
    const perfil = await this.db.perfilProfissional.findUnique({
      where: { contaId: usuario.sub }, select: dadosSolicitacao,
    });
    return { perfil };
  }

  @Post('meu-perfil')
  @UseGuards(Autenticacao)
  async solicitar(@Usuario() usuario: Sessao, @Body() dados: PerfilProfissionalDto) {
    exigirPapel(usuario, 'ENGENHEIRO');
    try {
      return await this.db.perfilProfissional.create({
        data: { ...dados, contaId: usuario.sub }, select: dadosSolicitacao,
      });
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException('Esta conta já tem uma solicitação de verificação.');
      throw erro;
    }
  }

  @Post('meu-perfil/publicacao')
  @UseGuards(Autenticacao)
  async consentimento(@Usuario() usuario: Sessao, @Body() dados: ConsentimentoDto) {
    exigirPapel(usuario, 'ENGENHEIRO');
    const where = { contaId: usuario.sub };
    const resultado = await this.db.perfilProfissional.updateMany({ where, data: dados });
    if (!resultado.count) throw new NotFoundException('Envie sua solicitação de verificação primeiro.');
    return this.db.perfilProfissional.findUniqueOrThrow({ where, select: dadosSolicitacao });
  }

  @Get('revisao')
  @UseGuards(Autenticacao)
  listarRevisoes(@Usuario() usuario: Sessao) {
    exigirPapel(usuario, 'ADMIN');
    return this.db.perfilProfissional.findMany({
      orderBy: [{ situacao: 'asc' }, { criadoEm: 'asc' }],
      select: { ...dadosSolicitacao, contaId: true, conta: { select: { celular: true } },
        revisor: { select: { nome: true } }, fonteOficial: true, metodoIdentidade: true },
    });
  }

  @Post('revisao/:id')
  @UseGuards(Autenticacao)
  async revisar(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string, @Body() dados: RevisaoProfissionalDto) {
    exigirPapel(usuario, 'ADMIN');
    if (usuario.sub === id) throw new ForbiddenException('A revisão exige outra conta autorizada.');
    const aprovar = dados.decisao === 'APROVADO';
    if (aprovar && (!dados.dadosConferidos || !dados.titularConfirmado || !dados.fonteOficial || !dados.metodoIdentidade)) {
      throw new BadRequestException('Confirme o registro na fonte oficial e a identidade por um canal independente.');
    }
    try {
      const resultado = await this.db.perfilProfissional.updateMany({
        where: { contaId: id, situacao: 'EM_ANALISE', conta: { papel: 'ENGENHEIRO' } },
        data: {
          situacao: dados.decisao, revisorId: usuario.sub, revisadoEm: new Date(),
          fonteOficial: aprovar ? dados.fonteOficial : null,
          metodoIdentidade: aprovar ? dados.metodoIdentidade : null,
        },
      });
      if (!resultado.count) throw new ConflictException('A solicitação já foi revisada ou está indisponível.');
      return { situacao: dados.decisao };
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException('Já há um profissional aprovado para esta agenda compartilhada.');
      throw erro;
    }
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

  async alterar(usuario: Sessao, id: string, destino: Situacao, origens: Situacao[], texto?: string, horario?: Date) {
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
        if (horario) await tx.visita.create({ data: { pedidoId: id, horario } });
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
      include: { pedido: { select: { id: true, municipio: true, comunidade: true, local: true, cliente: { select: { nome: true } } } } },
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
    exigirProfissionalAprovado(usuario);
    return this.pedidos.alterar(usuario, id, 'INFORMACOES', ['RECEBIDO','INFORMACOES'], dados.texto);
  }

  @Post(':id/respostas')
  responder(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string, @Body() dados: MensagemDto) {
    exigirPapel(usuario, 'CLIENTE');
    return this.pedidos.alterar(usuario, id, 'RECEBIDO', ['INFORMACOES'], dados.texto);
  }

  @Post(':id/conclusao')
  concluir(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string) {
    exigirProfissionalAprovado(usuario);
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
    exigirProfissionalAprovado(usuario);
    const horario = new Date(dados.dia + 'T' + dados.hora + ':00-03:00');
    if (isNaN(horario.getTime()) || diaBrasilia.format(horario) !== dados.dia || horaBrasilia.format(horario) !== dados.hora || horario <= new Date()) {
      throw new BadRequestException({ message: 'Escolha um horário futuro no fuso de Brasília.', campos: { dia: 'Escolha uma data e um horário futuros.' } });
    }
    return this.pedidos.alterar(usuario, dados.pedidoId, 'MARCADO', ['RECEBIDO','INFORMACOES'], undefined, horario);
  }

  @Get()
  listar(@Usuario() usuario: Sessao) {
    exigirProfissionalAprovado(usuario);
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
  providers: [Db, Autenticacao, LimiteAcesso, LimitePorIp, PedidosService],
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
