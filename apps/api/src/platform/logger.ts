import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths redacted from every log line (NFR-SEC-014). Applies to request/response
 * objects and to any structured context passed by modules.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'currentPassword',
  '*.currentPassword',
  'newPassword',
  '*.newPassword',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'otp',
  '*.otp',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'accountNumber',
  '*.accountNumber',
];

export interface CreateLoggerOptions {
  level: LoggerOptions['level'];
  service: 'api' | 'worker';
  /** Optional destination stream (tests capture output here). */
  destination?: DestinationStream;
}

export function createLogger({ level, service, destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
