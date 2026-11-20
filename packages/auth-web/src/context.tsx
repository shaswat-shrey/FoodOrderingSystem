import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ApiClient, AuthState } from '@fos/api-client';

export type SignInMethod = 'otp' | 'password';

export interface AuthConfig {
  /** Shown on auth screens, e.g. "FoodOrderSystem Partner". */
  appName: string;
  /** Offered sign-in methods; the first is the default tab. */
  methods: readonly SignInMethod[];
  /** Whether new accounts can be created from this app (never for admin, BR-AUTH-010). */
  allowSignUp: boolean;
  /** Where to go after signing in when no `next` is given. */
  homePath?: string;
}

interface AuthContextValue {
  api: ApiClient;
  config: Required<AuthConfig>;
  /** Set when the session could not be restored because the API was unreachable. */
  restoreError: boolean;
  retryRestore: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Restores the session from the HttpOnly refresh cookie on boot (FR-FE-002)
 * and exposes the client and app auth settings to the screens below it.
 */
export function AuthProvider({
  api,
  config,
  children,
}: {
  api: ApiClient;
  config: AuthConfig;
  children: ReactNode;
}) {
  const [restoreError, setRestoreError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (api.authStore.getState().status !== 'loading') return;
    let cancelled = false;
    api.refreshSession().then(
      () => !cancelled && setRestoreError(false),
      () => !cancelled && setRestoreError(true),
    );
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const retryRestore = useCallback(() => {
    setRestoreError(false);
    setAttempt((n) => n + 1);
  }, []);

  return (
    <AuthContext.Provider
      value={{ api, config: { homePath: '/', ...config }, restoreError, retryRestore }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** Current auth state plus the client's auth API. Re-renders on sign-in/out. */
export function useAuth() {
  const { api, config } = useAuthContext();
  const state: AuthState = useStore(api.authStore);
  return { ...state, api, auth: api.auth, config };
}
