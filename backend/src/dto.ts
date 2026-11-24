import 'reflect-metadata';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsIn, IsOptional, IsString, IsUrl, IsUUID, Length, Matches, ValidateNested } from 'class-validator';

export const servicos = ['Topografia', 'CAR', 'INCRA', 'Projetos', 'Não sei qual serviço preciso'];
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export function normalizarCelular(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9 ()-]+$/.test(value)) return value;
  return value.replace(/\D/g, '');
}

export class LoginDto {
  @Transform(({value}) => normalizarCelular(value))
  @Matches(/^[1-9][0-9]9[0-9]{8}$/, {message: 'Informe o celular com DDD e 11 dígitos.'})
  celular!: string;

  @IsString() @Length(8, 128, { message: 'Digite uma senha válida.' })
  senha!: string;
}

export class CadastroDto extends LoginDto {
  @IsString() @Length(15, 128, { message: 'Escolha uma senha de 15 a 128 caracteres.' })
  declare senha: string;

  @Transform(trim) @IsString() @Length(2, 80)
  nome!: string;
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

export class CadastroProfissionalDto extends CadastroDto {
  @IsDefined() @ValidateNested() @Type(() => RegistroProfissionalDto)
  registro!: RegistroProfissionalDto;
}

export class RevisaoProfissionalDto {
  @IsIn(['APROVADO', 'REJEITADO'])
  decisao!: 'APROVADO' | 'REJEITADO';

  @IsBoolean()
  dadosConferidos!: boolean;

  @IsBoolean()
  titularConfirmado!: boolean;

  @IsOptional() @IsIn(['CONFEA', 'CREA'])
  fonteOficial?: string;

  @IsOptional() @IsIn(['CONTATO_INSTITUCIONAL', 'VERIFICACAO_PRESENCIAL', 'CONFIRMACAO_PELO_CREA'])
  metodoIdentidade?: string;
}

export class PedidoDto {
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
