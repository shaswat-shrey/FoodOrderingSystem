import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { createApiClient, type LockManagerLike } from './client';

const user = {
  id: 'u1',
  fullName: 'Asha Rao',
  email: null,
  phone: '+919800000001',
  emailVerified: false,
  phoneVerified: true,
  status: 'ACTIVE',
  roles: ['CUSTOMER'],
  scope: 'FULL',
  profileComplete: true,
};

const ok = (data: unknown) => ({
  status: 200,
  data: { success: true, message: 'OK', data, meta: {} },
});
const fail = (status: number, code: string) => ({
  status,
  data: { success: false, message: code, error: { code, details: [], retryable: false }, meta: {} },
});
const session = (token: string) =>
  ok({
    accessToken: token,
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    user,
    session: { id: 's1' },
  });

type Handler = (config: InternalAxiosRequestConfig) => { status: number; data: unknown };

function routed(handler: Handler, seen: InternalAxiosRequestConfig[] = []): AxiosAdapter {
  return async (config) => {
    seen.push(config);
    await new Promise((r) => setTimeout(r, 5));
    const reply = handler(config);
    const response = {
      data: reply.data,
      status: reply.status,
      statusText: '',
      headers: new AxiosHeaders(),
      config,
    };
    if (reply.status >= 400)
      throw new AxiosError('fail', 'ERR_BAD_RESPONSE', config, undefined, response);
    return response;
  };
}

describe('auth client (FR-FE-002/003)', () => {
  it('stores the access token in memory after sign-in and sends it as a bearer token', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      adapter: routed((c) => (c.url === '/api/v1/auth/login' ? session('tok-1') : ok(user)), seen),
    });
    await client.auth.login({ identifier: 'a@b.co', password: 'pw' });
    expect(client.authStore.getState()).toMatchObject({ status: 'signedIn', accessToken: 'tok-1' });
    await client.auth.me();
    expect(seen[1]?.headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('refreshes once for many concurrent 401s and replays each request with the new token', async () => {
    let refreshes = 0;
    const seen: InternalAxiosRequestConfig[] = [];
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      adapter: routed((c) => {
        if (c.url === '/api/v1/auth/refresh') return session(`tok-${++refreshes + 1}`);
        return c.headers.get('Authorization') === 'Bearer tok-2'
          ? ok({ ok: true })
          : fail(401, 'AUTH_TOKEN_EXPIRED');
      }, seen),
    });
    client.authStore.setState({ status: 'signedIn', accessToken: 'tok-1' });
    const results = await Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(seen.find((c) => c.url === '/api/v1/auth/refresh')?.headers.get('Authorization')).toBe(
      '',
    );
  });

  it('serialises refresh across tabs through the lock manager', async () => {
    const names: string[] = [];
    const locks: LockManagerLike = {
      request: (name, cb) => {
        names.push(name);
        return cb();
      },
    };
    const client = createApiClient({
      clientApp: 'DELIVERY',
      locks,
      adapter: routed(() => session('tok-x')),
    });
    await expect(client.refreshSession()).resolves.toBe(true);
    expect(names).toEqual(['fos-auth-refresh-DELIVERY']);
  });

  it('retries once when another tab won the rotation race', async () => {
    let calls = 0;
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      raceRetryDelayMs: 1,
      adapter: routed(() =>
        ++calls === 1 ? fail(409, 'AUTH_REFRESH_RACE') : session('tok-after-race'),
      ),
    });
    await expect(client.refreshSession()).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(client.authStore.getState().accessToken).toBe('tok-after-race');
  });

  it('survives two races in a row (navigation while the previous page was refreshing)', async () => {
    let calls = 0;
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      raceRetryDelayMs: 1,
      adapter: routed(() => (++calls <= 2 ? fail(409, 'AUTH_REFRESH_RACE') : session('tok-3'))),
    });
    await expect(client.refreshSession()).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up after three races without looping', async () => {
    let calls = 0;
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      raceRetryDelayMs: 1,
      adapter: routed(() => {
        calls += 1;
        return fail(409, 'AUTH_REFRESH_RACE');
      }),
    });
    await expect(client.refreshSession()).resolves.toBe(false);
    expect(calls).toBe(3);
  });

  it('signs out when the refresh cookie is rejected, and surfaces the original 401', async () => {
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      adapter: routed((c) =>
        c.url === '/api/v1/auth/refresh'
          ? fail(401, 'AUTH_REFRESH_INVALID')
          : fail(401, 'AUTH_TOKEN_EXPIRED'),
      ),
    });
    client.authStore.setState({ status: 'signedIn', accessToken: 'old' });
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    expect(client.authStore.getState()).toMatchObject({ status: 'signedOut', accessToken: null });
  });

  it('keeps the session on a network failure during refresh', async () => {
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      adapter: async (config) => {
        throw new AxiosError('Network Error', 'ERR_NETWORK', config);
      },
    });
    client.authStore.setState({ status: 'signedIn', accessToken: 'old' });
    await expect(client.refreshSession()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(client.authStore.getState().status).toBe('signedIn');
  });

  it('returns the MFA challenge without signing in', async () => {
    const client = createApiClient({
      clientApp: 'ADMIN',
      locks: null,
      adapter: routed(() =>
        ok({ mfaRequired: true, mfaToken: 'm'.repeat(32), mfaTokenExpiresAt: 'later' }),
      ),
    });
    const result = await client.auth.login({ identifier: 'admin@x.co', password: 'pw' });
    expect(result).toMatchObject({ mfaRequired: true });
    expect(client.authStore.getState().status).toBe('loading');
  });
});

describe('customer API wrappers', () => {
  it('sends list filters as query strings and returns the next cursor', async () => {
    const { createCustomerApi } = await import('./customer-api');
    const seen: InternalAxiosRequestConfig[] = [];
    const client = createApiClient({
      clientApp: 'CUSTOMER',
      locks: null,
      adapter: async (config) => {
        seen.push(config);
        const data = {
          success: true,
          message: 'OK',
          data: [],
          meta: { pagination: { nextCursor: 'next' } },
        };
        return { data, status: 200, statusText: '', headers: new AxiosHeaders(), config };
      },
    });
    const api = createCustomerApi(client);
    const page = await api.discovery.restaurants(
      { lat: 12.9, lng: 77.6 },
      { cuisines: ['pizza', 'biryani'], sort: 'distance' },
    );
    expect(page).toEqual({ data: [], nextCursor: 'next' });
    expect(seen[0]?.url).toBe('/api/v1/discovery/restaurants');
    expect(seen[0]?.params).toMatchObject({
      lat: 12.9,
      lng: 77.6,
      cuisines: 'pizza,biryani',
      sort: 'distance',
    });
    await api.favorites.addRestaurant('r1');
    expect(seen[1]).toMatchObject({ method: 'put', url: '/api/v1/me/favorites/restaurants/r1' });
  });
});
