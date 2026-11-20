import type { LoginBody, OtpLoginBody, RegisterBody, ResetPasswordBody } from '@fos/validation';
import { setSignedIn, setSignedOut, type AuthUser } from './auth-store';
import type { ApiClient } from './client';

export interface SignedIn {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: AuthUser;
  session: { id: string };
}

export interface MfaRequired {
  mfaRequired: true;
  mfaToken: string;
  mfaTokenExpiresAt: string;
}

export type SignInResponse = SignedIn | MfaRequired;

export function isMfaRequired(response: SignInResponse): response is MfaRequired {
  return 'mfaRequired' in response && response.mfaRequired;
}

export interface DeviceSession {
  id: string;
  app: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
}

export interface PermissionsView {
  app: string;
  scope: 'FULL' | 'ONBOARDING';
  platformRoles: string[];
  permissions: string[];
  restaurants: {
    restaurantId: string;
    role: string;
    allBranches: boolean;
    branchIds: string[];
    permissions: string[];
  }[];
}

/** Typed wrappers for API-AUTH-* and /me. Sign-in calls update the in-memory auth store. */
export function createAuthApi(client: ApiClient) {
  const store = client.authStore;
  const signIn = async (promise: Promise<SignInResponse>) => {
    const result = await promise;
    if (!isMfaRequired(result)) setSignedIn(store, result);
    return result;
  };

  return {
    register: (body: RegisterBody) => signIn(client.post<SignInResponse>('/auth/register', body)),
    login: (body: LoginBody) => signIn(client.post<SignInResponse>('/auth/login', body)),
    requestOtp: (body: {
      phone?: string;
      purpose: 'LOGIN' | 'RESET_PASSWORD' | 'VERIFY_PHONE' | 'DELETE_ACCOUNT';
    }) =>
      client.post<{ resendAfterSeconds: number; expiresInSeconds: number }>(
        '/auth/otp/request',
        body,
      ),
    loginWithOtp: (body: OtpLoginBody) =>
      signIn(client.post<SignInResponse>('/auth/otp/login', body)),
    completeMfa: (body: { mfaToken: string; code: string }) =>
      signIn(client.post<SignInResponse>('/auth/mfa/challenge', body)),
    async logout() {
      try {
        await client.post('/auth/logout');
      } finally {
        setSignedOut(store);
      }
    },
    async logoutAll(keepCurrent = false) {
      const result = await client.post<{ revokedSessions: number }>('/auth/logout-all', {
        keepCurrent,
      });
      if (!keepCurrent) setSignedOut(store);
      return result;
    },
    sessions: () => client.get<DeviceSession[]>('/auth/sessions'),
    revokeSession: (sessionId: string) => client.delete<null>(`/auth/sessions/${sessionId}`),
    async verifyPhone(code: string) {
      await client.post('/auth/phone/verify', { code });
      const user = await client.get<AuthUser>('/me');
      store.setState({ user });
    },
    sendEmailVerification: () => client.post('/auth/email/send-verification'),
    verifyEmail: (token: string) => client.post('/auth/email/verify', { token }),
    forgotPassword: (identifier: string) => client.post('/auth/password/forgot', { identifier }),
    resetPassword: (body: ResetPasswordBody) => client.post('/auth/password/reset', body),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      client.post('/auth/password/change', body),
    me: () => client.get<AuthUser>('/me'),
    permissions: () => client.get<PermissionsView>('/me/permissions'),
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
