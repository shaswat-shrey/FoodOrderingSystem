import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { CLIENT_APP_HEADER, REQUEST_ID_HEADER, type ClientApp } from '@fos/shared';
import type { ApiFailure, ApiSuccess, ReadinessReport } from '@fos/types';
import { createAuthApi, type AuthApi } from './auth-api';
import {
  createAuthStore,
  setSignedIn,
  setSignedOut,
  type AuthStore,
  type AuthUser,
} from './auth-store';
import { ApiClientError } from './errors';

/** Minimal Web Locks API surface (navigator.locks) used to refresh once across tabs. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface ApiClientOptions {
  /** Origin of the API; '' means same origin (Vite dev proxy / reverse proxy). */
  baseURL?: string;
  clientApp: ClientApp;
  /** Injected in tests to avoid real network. */
  adapter?: AxiosInstance['defaults']['adapter'];
  /** Defaults to navigator.locks when available. */
  locks?: LockManagerLike | null;
  /** Pause before retrying a refresh that lost a race (ms). */
  raceRetryDelayMs?: number;
}

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function toClientError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error;
  if (error instanceof AxiosError) {
    const body = error.response?.data as Partial<ApiFailure> | undefined;
    if (error.response && body && body.success === false && body.error) {
      return new ApiClientError(
        body.error.code,
        body.message ?? 'Request failed',
        error.response.status,
        body.error.details ?? [],
        body.error.retryable ?? false,
        body.meta?.requestId,
      );
    }
    if (error.response) {
      return new ApiClientError(
        'HTTP_ERROR',
        'Something went wrong. Please try again.',
        error.response.status,
        [],
        error.response.status >= 500,
      );
    }
    return new ApiClientError(
      'NETWORK_ERROR',
      "Can't reach the server. Check your connection.",
      undefined,
      [],
      true,
    );
  }
  return new ApiClientError('UNKNOWN_ERROR', 'Something went wrong.', undefined);
}

export interface ApiClient {
  readonly http: AxiosInstance;
  readonly clientApp: ClientApp;
  readonly authStore: AuthStore;
  readonly auth: AuthApi;
  get<T>(path: string, params?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  delete<T>(path: string, params?: Record<string, unknown>): Promise<T>;
  patch<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  /** GET a cursor-paginated list (SRS §14.1): data plus the next cursor, if any. */
  getPage<T>(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: T; nextCursor: string | null }>;
  /** API-SYS-002 readiness (not enveloped; 503 is a valid answer, not an error). */
  readiness(): Promise<ReadinessReport>;
  /**
   * Restores or renews the session from the refresh cookie. Concurrent callers
   * share one request; tabs coordinate through a lock (FR-FE-003).
   */
  refreshSession(): Promise<boolean>;
}

type RetriableConfig = InternalAxiosRequestConfig & { _authRetried?: boolean };

const AUTH_PATH_PREFIX = '/api/v1/auth/';
const REFRESH_PATH = `${AUTH_PATH_PREFIX}refresh`;
const RETRY_ON = new Set(['AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID']);

export function createApiClient({
  baseURL = '',
  clientApp,
  adapter,
  locks = typeof navigator !== 'undefined' && 'locks' in navigator
    ? (navigator.locks as LockManagerLike)
    : null,
  raceRetryDelayMs = 250,
}: ApiClientOptions): ApiClient {
  const authStore = createAuthStore();
  const http = axios.create({
    baseURL,
    timeout: 15_000,
    headers: { Accept: 'application/json' },
    // NFR-SEC-009: the refresh cookie (path /api/v1/auth) is the only credential the
    // browser sends; the interceptor below enables it for auth calls only.
    ...(adapter ? { adapter } : {}),
  });

  http.interceptors.request.use((config) => {
    config.withCredentials = (config.url ?? '').startsWith(AUTH_PATH_PREFIX);
    config.headers.set(CLIENT_APP_HEADER, clientApp);
    if (!config.headers.has(REQUEST_ID_HEADER))
      config.headers.set(REQUEST_ID_HEADER, newRequestId());
    const token = authStore.getState().accessToken;
    if (token && !config.headers.has('Authorization'))
      config.headers.set('Authorization', `Bearer ${token}`);
    return config;
  });

  let inFlight: Promise<boolean> | null = null;

  async function doRefresh(attempt = 0): Promise<boolean> {
    try {
      const response = await http.post<
        ApiSuccess<{ accessToken: string; accessTokenExpiresAt: string; user: AuthUser }>
      >(REFRESH_PATH, undefined, { headers: { Authorization: '' } });
      setSignedIn(authStore, response.data.data);
      return true;
    } catch (error) {
      const failure = toClientError(error);
      if (failure.code === 'AUTH_REFRESH_RACE' && attempt < 2) {
        // Another tab (or the page we navigated away from) rotated the cookie a moment ago;
        // the browser holds the new one, or the server hands it back on the retry.
        await new Promise((resolve) => setTimeout(resolve, raceRetryDelayMs * (attempt * 2 + 1)));
        return doRefresh(attempt + 1);
      }
      if (failure.code === 'NETWORK_ERROR' || (failure.status ?? 0) >= 500) throw failure;
      setSignedOut(authStore);
      return false;
    }
  }

  function refreshSession(): Promise<boolean> {
    inFlight ??= (
      locks ? locks.request(`fos-auth-refresh-${clientApp}`, () => doRefresh()) : doRefresh()
    ).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  http.interceptors.response.use(undefined, async (error: unknown) => {
    if (!(error instanceof AxiosError) || !error.config) throw error;
    const config = error.config as RetriableConfig;
    const failure = toClientError(error);
    const isAuthCall = (config.url ?? '').startsWith(AUTH_PATH_PREFIX);
    if (
      error.response?.status === 401 &&
      RETRY_ON.has(failure.code) &&
      !config._authRetried &&
      !isAuthCall
    ) {
      config._authRetried = true;
      if (await refreshSession()) {
        config.headers.set('Authorization', `Bearer ${authStore.getState().accessToken}`);
        return http.request(config);
      }
    }
    if (
      failure.code === 'AUTH_SESSION_REVOKED' ||
      failure.code === 'AUTH_SESSION_EXPIRED' ||
      failure.code === 'AUTH_REFRESH_REUSED'
    ) {
      setSignedOut(authStore);
    }
    throw error;
  });

  async function unwrap<T>(promise: Promise<{ data: ApiSuccess<T> }>): Promise<T> {
    try {
      const response = await promise;
      return response.data.data;
    } catch (error) {
      throw toClientError(error);
    }
  }

  const client: ApiClient = {
    http,
    clientApp,
    authStore,
    auth: undefined as unknown as AuthApi,
    get: (path, params) => unwrap(http.get(`/api/v1${path}`, { params })),
    post: (path, body, headers) => unwrap(http.post(`/api/v1${path}`, body, { headers })),
    delete: (path, params) => unwrap(http.delete(`/api/v1${path}`, { params })),
    patch: (path, body, headers) => unwrap(http.patch(`/api/v1${path}`, body, { headers })),
    put: (path, body) => unwrap(http.put(`/api/v1${path}`, body)),
    async getPage<T>(path: string, params?: Record<string, unknown>) {
      try {
        const response = await http.get<ApiSuccess<T>>(`/api/v1${path}`, { params });
        return {
          data: response.data.data,
          nextCursor: response.data.meta.pagination?.nextCursor ?? null,
        };
      } catch (error) {
        throw toClientError(error);
      }
    },
    refreshSession,
    async readiness() {
      try {
        const response = await http.get<ReadinessReport>('/health/ready', {
          validateStatus: (status) => status === 200 || status === 503,
        });
        return response.data;
      } catch (error) {
        throw toClientError(error);
      }
    },
  };
  (client as { auth: AuthApi }).auth = createAuthApi(client);
  return client;
}
