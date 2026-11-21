import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, stream };
}

describe('logger redaction (NFR-SEC-014)', () => {
  it('never writes passwords, tokens, OTPs or auth headers', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ level: 'info', service: 'api', destination: stream });
    logger.info(
      {
        password: 'hunter2',
        body: { otp: '123456', refreshToken: 'rt-abc', newPassword: 'p@ss' },
        req: { headers: { authorization: 'Bearer eyJ...', cookie: 'fos_rt_customer=x' } },
      },
      'login attempt',
    );
    const output = lines.join('');
    for (const secret of ['hunter2', '123456', 'rt-abc', 'p@ss', 'eyJ', 'fos_rt_customer']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ service: 'api', level: 'info' });
  });

  it('masks contact details, pickup and delivery codes and provider signatures', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ level: 'info', service: 'api', destination: stream });
    logger.info(
      {
        phone: '+919876543210',
        body: { identifier: 'asha@example.com', pickupCode: '4821', signature: 'sig-xyz' },
        delivery: { deliveryCode: '7314' },
      },
      'context',
    );
    const output = lines.join('');
    for (const secret of ['9876543210', 'asha@example.com', '4821', 'sig-xyz', '7314'])
      expect(output).not.toContain(secret);
  });
});
