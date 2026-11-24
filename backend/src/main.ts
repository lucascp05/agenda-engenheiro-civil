import 'dotenv/config';
import 'reflect-metadata';
import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, createParamDecorator,
  ExecutionContext, ForbiddenException, Get, Injectable, Module, NotFoundException, Param,
  ParseUUIDPipe, Post, Query, UnauthorizedException, UseGuards, ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Papel, Prisma, Situacao } from '@prisma/client';
import helmet from 'helmet';
import { Db } from './db';
import { CadastroDto, FiltrosDto, LoginDto, MensagemDto, PedidoDto, VisitaDto } from './dto';
import { gerarHash, verificarSenha } from './senha';

type Sessao = { sub: string; papel: Papel };
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

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('Configure JWT_SECRET com pelo menos 32 caracteres.');

@Injectable()
class Autenticacao implements CanActivate {
  constructor(private jwt: JwtService) {}

  async canActivate(contexto: ExecutionContext) {
    const req = contexto.switchToHttp().getRequest();
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Entre na sua conta.');
    try {
      req.usuario = await this.jwt.verifyAsync<Sessao>(token);
      return true;
    } catch {
      throw new UnauthorizedException('Sua sessão expirou. Entre novamente.');
    }
  }
}

@Controller()
class Acesso {
  constructor(private db: Db, private jwt: JwtService) {}

  @Get('saude')
  async saude() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true };
  }

  @Post('auth/cadastro')
  async cadastro(@Body() dados: CadastroDto) {
    try {
      const conta = await this.db.conta.create({
        data: { nome: dados.nome, celular: dados.celular, hash: await gerarHash(dados.senha) },
        select: contaPublica,
      });
      return this.sessao(conta);
    } catch (erro) {
      if (erroUnico(erro)) throw new ConflictException({ message: 'Este celular já está cadastrado.', campos: { celular: 'Este celular já está cadastrado.' } });
      throw erro;
    }
  }

  @Post('auth/login')
  async login(@Body() dados: LoginDto) {
    const conta = await this.db.conta.findUnique({ where: { celular: dados.celular } });
    const hashReserva = '00000000000000000000000000000000:' + '00'.repeat(64);
    const valida = await verificarSenha(dados.senha, conta?.hash ?? hashReserva);
    if (!conta || !valida) throw new UnauthorizedException('Celular ou senha incorretos.');
    const { id, nome, celular, papel } = conta;
    return this.sessao({ id, nome, celular, papel });
  }

  private async sessao(conta: { id: string; nome: string; celular: string; papel: Papel }) {
    return { conta, token: await this.jwt.signAsync({ sub: conta.id, papel: conta.papel }) };
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
    return this.pedidos.listar(usuario, filtros);
  }

  @Get(':id')
  obter(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string) {
    return this.pedidos.obter(id, usuario);
  }

  @Post()
  criar(@Usuario() usuario: Sessao, @Body() dados: PedidoDto) {
    return this.pedidos.criar(usuario, dados);
  }

  @Post(':id/informacoes')
  informar(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string, @Body() dados: MensagemDto) {
    exigirPapel(usuario, 'ENGENHEIRO');
    return this.pedidos.alterar(usuario, id, 'INFORMACOES', ['RECEBIDO','INFORMACOES'], dados.texto);
  }

  @Post(':id/respostas')
  responder(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string, @Body() dados: MensagemDto) {
    exigirPapel(usuario, 'CLIENTE');
    return this.pedidos.alterar(usuario, id, 'RECEBIDO', ['INFORMACOES'], dados.texto);
  }

  @Post(':id/conclusao')
  concluir(@Usuario() usuario: Sessao, @Param('id', ParseUUIDPipe) id: string) {
    exigirPapel(usuario, 'ENGENHEIRO');
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
    exigirPapel(usuario, 'ENGENHEIRO');
    const horario = new Date(dados.dia + 'T' + dados.hora + ':00-03:00');
    if (isNaN(horario.getTime()) || diaBrasilia.format(horario) !== dados.dia || horaBrasilia.format(horario) !== dados.hora || horario <= new Date()) {
      throw new BadRequestException({ message: 'Escolha um horário futuro no fuso de Brasília.', campos: { dia: 'Escolha uma data e um horário futuros.' } });
    }
    return this.pedidos.alterar(usuario, dados.pedidoId, 'MARCADO', ['RECEBIDO','INFORMACOES'], undefined, horario);
  }

  @Get()
  listar(@Usuario() usuario: Sessao) {
    exigirPapel(usuario, 'ENGENHEIRO');
    return this.pedidos.visitas();
  }
}

@Module({
  imports: [JwtModule.register({ secret: jwtSecret, signOptions: { expiresIn: '8h' } })],
  controllers: [Acesso, PedidosController, VisitasController],
  providers: [Db, Autenticacao, PedidosService],
})
class App {}

async function iniciar() {
  const app = await NestFactory.create(App, { logger: false, bodyParser: true });
  app.use(helmet());
  app.use((_req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(origem => origem.trim()),
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: ['Authorization','Content-Type'],
  });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    exceptionFactory: erros => new BadRequestException({
      message: 'Confira os campos destacados.',
      campos: Object.fromEntries(erros.map(erro => [erro.property, erro.constraints?.matches ?? 'Confira este campo.'])),
    }),
  }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void iniciar().catch(() => { console.error('Não foi possível iniciar a API.'); process.exitCode = 1; });
