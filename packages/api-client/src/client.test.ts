import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { createApiClient } from './client';
import { ApiClientError } from './errors';

type Reply = { status: number; data: unknown } | 'network-error';

function adapterReturning(reply: Reply, seen: InternalAxiosRequestConfig[] = []): AxiosAdapter {
  return async (config) => {
    seen.push(config);
    if (reply === 'network-error') throw new AxiosError('Network Error', 'ERR_NETWORK', config);
    const response = {
      data: reply.data,
      status: reply.status,
      statusText: '',
      headers: new AxiosHeaders(),
      config,
    };
    const valid = config.validateStatus ? config.validateStatus(reply.status) : reply.status < 400;
    if (!valid)
      throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, undefined, response);
    return response;
  };
}

describe('api client', () => {
  it('sends X-Client-App and a request id, and unwraps the success envelope', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      adapter: adapterReturning(
        { status: 200, data: { success: true, message: 'OK', data: { id: 1 }, meta: {} } },
        seen,
      ),
    });
    await expect(client.get('/things')).resolves.toEqual({ id: 1 });
    expect(seen[0]?.url).toBe('/api/v1/things');
    expect(seen[0]?.headers.get('x-client-app')).toBe('CUSTOMER');
    expect(String(seen[0]?.headers.get('x-request-id'))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns an error envelope into ApiClientError with code, details and request id', async () => {
    const client = createApiClient({
      clientApp: 'RESTAURANT',
      adapter: adapterReturning({
        status: 409,
        data: {
          success: false,
          message: 'This order was just updated.',
          error: { code: 'ORDER_STATE_CONFLICT', details: [], retryable: false },
          meta: { requestId: 'req-123' },
        },
      }),
    });
    const error = await client.post('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: 'ORDER_STATE_CONFLICT',
      status: 409,
      message: 'This order was just updated.',
      retryable: false,
      requestId: 'req-123',
    });
  });

  it('reports network failures as retryable NETWORK_ERROR', async () => {
    const client = createApiClient({
      clientApp: 'DELIVERY',
      adapter: adapterReturning('network-error'),
    });
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    });
  });

  it('treats a 503 readiness report as data, not an error', async () => {
    const report = {
      status: 'unavailable',
      checks: { database: { status: 'down', error: 'unreachable' } },
    };
    const client = createApiClient({
      clientApp: 'ADMIN',
      adapter: adapterReturning({ status: 503, data: report }),
    });
    await expect(client.readiness()).resolves.toEqual(report);
  });
});
