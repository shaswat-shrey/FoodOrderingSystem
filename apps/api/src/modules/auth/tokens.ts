import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import type { ClientApp } from '@fos/shared';
import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AUTH_POLICY } from './policy';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  app: ClientApp;
  roles: string[];
  scope: 'FULL' | 'ONBOARDING';
  permissionVersion: number;
  tokenVersion: number;
}

export interface SigningKey {
  kid: string;
  secret: string;
}

export class TokenError extends Error {
  constructor(readonly reason: 'EXPIRED' | 'INVALID') {
    super(reason);
  }
}

/**
 * Short-lived HS256 access tokens with a `kid` key ring (ADR-003): the first key
 * signs, every configured key verifies, so keys can rotate without logging users out.
 */
export class TokenService {
  private readonly keys: Map<string, Uint8Array>;
  private readonly active: SigningKey;

  constructor(
    signingKeys: SigningKey[],
    private readonly issuer: string,
    private readonly clock: Clock,
  ) {
    if (signingKeys.length === 0) throw new Error('At least one signing key is required');
    this.active = signingKeys[0]!;
    this.keys = new Map(signingKeys.map((k) => [k.kid, new TextEncoder().encode(k.secret)]));
  }

  async sign(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const exp = now + AUTH_POLICY.accessTokenTtlSeconds;
    const token = await new SignJWT({
      sid: claims.sessionId,
      roles: claims.roles,
      scp: claims.scope,
      pv: claims.permissionVersion,
      tv: claims.tokenVersion,
    })
      .setProtectedHeader({ alg: 'HS256', kid: this.active.kid, typ: 'JWT' })
      .setSubject(claims.userId)
      .setAudience(claims.app)
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(uuidv7())
      .sign(this.keys.get(this.active.kid)!);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Verifies signature, issuer, audience (the calling app) and expiry. */
  async verify(token: string, expectedApp: ClientApp): Promise<AccessClaims> {
    return (await this.verifyWithExpiry(token, expectedApp)).claims;
  }

  /** As verify(), also returning the expiry (sockets drop when it lapses, FR-RT-003). */
  async verifyWithExpiry(
    token: string,
    expectedApp: ClientApp,
  ): Promise<{ claims: AccessClaims; expiresAt: Date }> {
    try {
      const { payload } = await jwtVerify(
        token,
        async (header) => {
          const key = header.kid ? this.keys.get(header.kid) : undefined;
          if (!key) throw new TokenError('INVALID');
          return key;
        },
        {
          algorithms: ['HS256'],
          issuer: this.issuer,
          audience: expectedApp,
          currentDate: this.clock.now(),
        },
      );
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.pv !== 'number' ||
        typeof payload.tv !== 'number' ||
        (payload.scp !== 'FULL' && payload.scp !== 'ONBOARDING')
      ) {
        throw new TokenError('INVALID');
      }
      return {
        claims: {
          userId: payload.sub,
          sessionId: payload.sid,
          app: expectedApp,
          roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
          scope: payload.scp,
          permissionVersion: payload.pv,
          tokenVersion: payload.tv,
        },
        expiresAt: new Date((payload.exp ?? 0) * 1000),
      };
    } catch (error) {
      if (error instanceof TokenError) throw error;
      if (error instanceof joseErrors.JWTExpired) throw new TokenError('EXPIRED');
      throw new TokenError('INVALID');
    }
  }
}
