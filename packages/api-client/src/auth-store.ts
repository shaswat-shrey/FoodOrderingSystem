import { createStore, type StoreApi } from 'zustand/vanilla';

/** Account summary returned by sign-in, refresh and GET /me (API-USER-001). */
export interface AuthUser {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'ANONYMIZED';
  roles: string[];
  scope: 'FULL' | 'ONBOARDING';
  profileComplete: boolean;
}

export interface AuthState {
  /** `loading` until the first session restore attempt finishes. */
  status: 'loading' | 'signedOut' | 'signedIn';
  user: AuthUser | null;
  /** Access token held in memory only — never in localStorage (FR-FE-002, C-14). */
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
}

export type AuthStore = StoreApi<AuthState>;

export function createAuthStore(): AuthStore {
  return createStore<AuthState>(() => ({
    status: 'loading',
    user: null,
    accessToken: null,
    accessTokenExpiresAt: null,
  }));
}

export function setSignedIn(
  store: AuthStore,
  session: { accessToken: string; accessTokenExpiresAt: string; user: AuthUser },
): void {
  store.setState({
    status: 'signedIn',
    user: session.user,
    accessToken: session.accessToken,
    accessTokenExpiresAt: Date.parse(session.accessTokenExpiresAt),
  });
}

export function setSignedOut(store: AuthStore): void {
  store.setState({
    status: 'signedOut',
    user: null,
    accessToken: null,
    accessTokenExpiresAt: null,
  });
}
