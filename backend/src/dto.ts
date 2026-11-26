import 'reflect-metadata';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsISO8601, IsIn, IsOptional, IsString, IsUrl, IsUUID, Length, Matches } from 'class-validator';

export const servicos = ['Topografia', 'CAR', 'INCRA', 'Serviços relacionados ao INCRA', 'Projetos', 'Não sei qual serviço preciso'];
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export function normalizarCelular(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9 ()-]+$/.test(value)) return value;
  return value.replace(/\D/g, '');
}

const celular = () => Matches(/^[1-9][0-9]9[0-9]{8}$/, { message: 'Informe o celular com DDD e 11 dígitos.' });

export class EmailDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @Length(3, 254)
  email!: string;
}

export class CadastroDto extends EmailDto {
  @Transform(trim) @IsString() @Length(2, 80)
  nome!: string;
}

export class LoginDto {
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @Length(3, 254)
  email?: string;

  @IsOptional() @Transform(({ value }) => normalizarCelular(value)) @celular()
  celular?: string;

  @IsString() @Length(8, 128, { message: 'Digite uma senha válida.' })
  senha!: string;
}

export class CadastroDiretoDto extends LoginDto {
  @Transform(trim) @IsString() @Length(2, 80)
  nome!: string;

  @Length(15, 128, { message: 'Escolha uma senha de 15 a 128 caracteres.' })
  declare senha: string;
}

export class RecuperacaoCodigoDto extends LoginDto {
  @Length(15, 128, { message: 'Escolha uma senha de 15 a 128 caracteres.' })
  declare senha: string;

  @Transform(trim) @Matches(/^[A-Za-z0-9_-]{32}$/)
  codigo!: string;
}

export class TrocaSenhaDto {
  @IsString() @Length(8, 128)
  senhaAtual!: string;

  @IsString() @Length(15, 128, { message: 'Escolha uma senha de 15 a 128 caracteres.' })
  senha!: string;
}

export class TokenEmailDto {
  @Matches(/^[a-f0-9]{64}$/)
  token!: string;
}

export class SenhaEmailDto extends TokenEmailDto {
  @IsString() @Length(15, 128, { message: 'Escolha uma senha de 15 a 128 caracteres.' })
  senha!: string;
}

export const ufs = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

export class ConsentimentoDto {
  @IsBoolean()
  autorizaPublicacao!: boolean;
}

export class RegistroProfissionalDto extends ConsentimentoDto {
  @Transform(trim) @IsString() @Length(2, 120)
  titulo!: string;

  @IsIn(ufs)
  creaUf!: string;

  @Transform(trim) @Matches(/^[A-Za-z0-9][A-Za-z0-9./-]{1,39}$/)
  registro!: string;
}

export class PerfilProfissionalDto extends RegistroProfissionalDto {
  @Transform(trim) @IsString() @Length(3, 80)
  nomeCompleto!: string;
}

export class PedidoDto {
  @IsOptional() @Transform(({ value }) => normalizarCelular(value)) @celular()
  celular?: string;

  @IsIn(servicos)
  servico!: string;

  @Transform(trim) @IsString() @Length(2, 90)
  municipio!: string;

  @IsOptional() @Transform(trim) @IsString() @Length(2, 100)
  comunidade?: string;

  @Transform(trim) @IsString() @Length(3, 160)
  local!: string;

  @Transform(trim) @IsString() @Length(3, 400)
  descricao!: string;

  @IsOptional() @Transform(trim) @IsString() @Length(8, 500)
  @IsUrl({ protocols: ['http','https'], require_protocol: true, disallow_auth: true })
  link?: string;
}

export class FiltrosDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 90)
  municipio?: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 100)
  comunidade?: string;
}

export class MensagemDto {
  @Transform(trim) @IsString() @Length(3, 400)
  texto!: string;
}

export class VisitaDto {
  @IsUUID()
  pedidoId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dia!: string;

  @Matches(/^(?:[01]\d|2[0-3]):00$/)
  hora!: string;
}


export class RemarcacaoDto extends VisitaDto {
  @IsISO8601({ strict: true })
  horarioAnterior!: string;
}
