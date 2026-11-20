import type { ClientApp } from '@fos/shared';
import { SocketAuthError, type SocketAuth } from '../../platform/realtime/socket-server';
import type { SessionService } from './session.service';
import { TokenError, type TokenService } from './tokens';

/** Socket handshake authentication with the same rules as REST (FR-RT-002, FR-AUTH-021). */
export function createSocketAuth(tokens: TokenService, sessions: SessionService): SocketAuth {
  return {
    async authenticate(token: string, app: ClientApp) {
      let verified;
      try {
        verified = await tokens.verifyWithExpiry(token, app);
      } catch (error) {
        const expired = error instanceof TokenError && error.reason === 'EXPIRED';
        throw new SocketAuthError(
          expired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID',
          'Sign in again to receive live updates.',
        );
      }
      const { claims, expiresAt } = verified;
      const state = await sessions.state(claims.sessionId);
      const usable =
        state?.active &&
        state.userId === claims.userId &&
        state.app === app &&
        state.phoneVerified &&
        state.tokenVersion === claims.tokenVersion &&
        ['ACTIVE', 'PENDING_VERIFICATION'].includes(state.userStatus);
      if (!usable) throw new SocketAuthError('AUTH_SESSION_REVOKED', 'Your session has ended.');
      return { userId: claims.userId, sessionId: claims.sessionId, expiresAt };
    },
  };
}
