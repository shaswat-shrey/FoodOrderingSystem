import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  CORS_ORIGINS: 'http://localhost:5173, http://localhost:5174',
  DATABASE_URL: 'postgresql://fos:pw@localhost:5432/fos',
  REDIS_CORE_URL: 'redis://localhost:6379',
  REDIS_CACHE_URL: 'redis://localhost:6380',
};

describe('loadEnv (NFR-SEC-011)', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:5174']);
  });

  it('fails loudly on missing or malformed values without echoing secret values', () => {
    const attempt = () =>
      loadEnv({ ...valid, DATABASE_URL: 'mysql://secret-password@host/db', REDIS_CORE_URL: undefined });
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
});
