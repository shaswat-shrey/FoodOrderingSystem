import { describe, expect, it } from 'vitest';
import { appOrigins, EnvValidationError, loadEnv } from './env';

const secret = 'x'.repeat(32);
const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://fos:pw@localhost:5432/fos',
  REDIS_CORE_URL: 'redis://localhost:6379',
  REDIS_CACHE_URL: 'redis://localhost:6380',
  JWT_SIGNING_KEYS: `k2:${secret},k1:${'y'.repeat(40)}`,
  AUTH_HMAC_SECRET: secret,
};

describe('loadEnv (NFR-SEC-011)', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.JWT_SIGNING_KEYS.map((k) => k.kid)).toEqual(['k2', 'k1']);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(appOrigins(env).CUSTOMER).toBe('http://localhost:5173');
  });

  it('fails loudly on missing or malformed values without echoing secret values', () => {
    const attempt = () =>
      loadEnv({
        ...valid,
        DATABASE_URL: 'mysql://secret-password@host/db',
        REDIS_CORE_URL: undefined,
      });
    expect(attempt).toThrow(EnvValidationError);
    try {
      attempt();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_CORE_URL');
      expect(message).not.toContain('secret-password');
    }
  });

  it('rejects short or duplicate signing keys and short HMAC secrets', () => {
    expect(() => loadEnv({ ...valid, JWT_SIGNING_KEYS: 'k1:short' })).toThrow(/32 bytes/);
    expect(() => loadEnv({ ...valid, JWT_SIGNING_KEYS: `k1:${secret},k1:${secret}` })).toThrow(
      /unique/,
    );
    expect(() => loadEnv({ ...valid, AUTH_HMAC_SECRET: 'short' })).toThrow(/AUTH_HMAC_SECRET/);
  });

  it('requires secure cookies and https app URLs in production', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/APP_URL_CUSTOMER/);
    const prod = loadEnv({
      ...valid,
      NODE_ENV: 'production',
      RAZORPAY_KEY_ID: 'rzp_live_x',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRETS: 'whsec',
      APP_URL_CUSTOMER: 'https://app.example.com',
      APP_URL_RESTAURANT: 'https://partner.example.com',
      APP_URL_DELIVERY: 'https://rider.example.com',
      APP_URL_ADMIN: 'https://admin.example.com',
      STORAGE_ACCESS_KEY: 'access',
      STORAGE_SECRET_KEY: 'secret',
      API_PUBLIC_URL: 'https://api.example.com',
      FIELD_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 7).toString('base64')}`,
    });
    expect(prod.COOKIE_SECURE).toBe(true);
    expect(prod.GEO_PROVIDER).toBe('none'); // degraded address search, never the fictional mock
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', GEO_PROVIDER: 'mock' })).toThrow(
      /GEO_PROVIDER/,
    );
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    );
    // FR-FILE-005: production files go to S3-compatible storage with credentials.
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/STORAGE_ACCESS_KEY/);
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', STORAGE_DRIVER: 'local' })).toThrow(
      /STORAGE_DRIVER/,
    );
  });
});
