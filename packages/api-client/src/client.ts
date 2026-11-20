import axios, { AxiosError, type AxiosInstance } from 'axios';
import { CLIENT_APP_HEADER, REQUEST_ID_HEADER, type ClientApp } from '@fos/shared';
import type { ApiFailure, ApiSuccess, ReadinessReport } from '@fos/types';
import { ApiClientError } from './errors';

export interface ApiClientOptions {
  /** Origin of the API; '' means same origin (Vite dev proxy / reverse proxy). */
  baseURL?: string;
  clientApp: ClientApp;
  /** Injected in tests to avoid real network. */
  adapter?: AxiosInstance['defaults']['adapter'];
}

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function toClientError(error: unknown): ApiClientError {
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
    return new ApiClientError('NETWORK_ERROR', "Can't reach the server. Check your connection.", undefined, [], true);
  }
  return new ApiClientError('UNKNOWN_ERROR', 'Something went wrong.', undefined);
}

export interface ApiClient {
  readonly http: AxiosInstance;
  get<T>(path: string, params?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  /** API-SYS-002 readiness (not enveloped; 503 is a valid answer, not an error). */
  readiness(): Promise<ReadinessReport>;
}

export function createApiClient({ baseURL = '', clientApp, adapter }: ApiClientOptions): ApiClient {
  const http = axios.create({
    baseURL,
    timeout: 15_000,
    headers: { Accept: 'application/json' },
    ...(adapter ? { adapter } : {}),
  });

  http.interceptors.request.use((config) => {
    config.headers.set(CLIENT_APP_HEADER, clientApp);
    if (!config.headers.has(REQUEST_ID_HEADER)) config.headers.set(REQUEST_ID_HEADER, newRequestId());
    return config;
  });

  async function unwrap<T>(promise: Promise<{ data: ApiSuccess<T> }>): Promise<T> {
    try {
      const response = await promise;
      return response.data.data;
    } catch (error) {
      throw toClientError(error);
    }
  }

  return {
    http,
    get: (path, params) => unwrap(http.get(`/api/v1${path}`, { params })),
    post: (path, body, headers) => unwrap(http.post(`/api/v1${path}`, body, { headers })),
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
}
