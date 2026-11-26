import { createHash, randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminInitiateAuthCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient, NotAuthorizedException, UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const pool = process.env.COGNITO_USER_POOL_ID?.trim();
const clientId = process.env.COGNITO_CLIENT_ID?.trim();
if (Boolean(pool) !== Boolean(clientId) || (process.env.AGENDA_PUBLICACAO === '1' && !pool)) {
  throw new Error('Configure COGNITO_USER_POOL_ID e COGNITO_CLIENT_ID.');
}

export type IdentidadeCognito = { cognitoUsuario: string; cognitoSub: string };

@Injectable()
export class Cognito {
  readonly ativo = Boolean(pool);
  private readonly api = pool ? new CognitoIdentityProviderClient({ region: pool.split('_')[0], requestHandler: { requestTimeout: 4000 }, maxAttempts: 2 }) : undefined;
  private readonly verifier = pool && clientId ? CognitoJwtVerifier.create({ userPoolId: pool, clientId, tokenUse: 'access' }) : undefined;

  private senha(usuario: string, senha: string) {
    // Preserva as senhas aceitas pela Agenda, inclusive frases com espaços.
    return createHash('sha256').update(usuario).update('\0').update(senha).digest('hex');
  }

  async verificar(token: string) {
    const claims = await this.verifier!.verify(token);
    if (!claims.sub || !claims.username || !Number.isSafeInteger(claims.exp)) throw new Error('Token incompleto.');
    return claims;
  }

  async criar(senha: string): Promise<IdentidadeCognito> {
    const usuario = randomUUID();
    let criado = false;
    try {
      const { User } = await this.api!.send(new AdminCreateUserCommand({
        UserPoolId: pool, Username: usuario, MessageAction: 'SUPPRESS',
      }));
      criado = true;
      const sub = User?.Attributes?.find(atributo => atributo.Name === 'sub')?.Value;
      if (!sub || User?.Username !== usuario) throw new Error('Identidade incompleta.');
      await this.api!.send(new AdminSetUserPasswordCommand({
        UserPoolId: pool, Username: usuario, Password: this.senha(usuario, senha), Permanent: true,
      }));
      return { cognitoUsuario: usuario, cognitoSub: sub };
    } catch (erro) {
      if (criado) await this.remover(usuario);
      throw this.indisponivel(erro);
    }
  }

  async remover(usuario: string) {
    try {
      await this.api!.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: usuario }));
    } catch (erro) {
      if (!(erro instanceof UserNotFoundException)) this.indisponivel(erro);
    }
  }

  async autenticar(usuario: string, senha: string) {
    try {
      const resultado = await this.api!.send(new AdminInitiateAuthCommand({
        UserPoolId: pool, ClientId: clientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: usuario, PASSWORD: this.senha(usuario, senha) },
      }));
      const token = resultado.AuthenticationResult?.AccessToken;
      if (!token) throw new Error('Access token ausente.');
      return { token, claims: await this.verificar(token) };
    } catch (erro) {
      if (erro instanceof NotAuthorizedException || erro instanceof UserNotFoundException) {
        throw new UnauthorizedException('Dados de acesso incorretos.');
      }
      throw this.indisponivel(erro);
    }
  }

  private indisponivel(erro: unknown) {
    console.warn('Falha na operação Cognito:', erro instanceof Error ? erro.name : 'desconhecida');
    return new ServiceUnavailableException('Autenticação indisponível. Tente novamente.');
  }
}
