import type { OtpPurpose, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { hmac, randomDigits, safeEqual, type Digest } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import { AUTH_POLICY } from './policy';

interface OtpRow {
  id: string;
  code_hmac: Uint8Array;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  user_id: string | null;
}

/**
 * One-time passcodes (FR-AUTH-010, BR-AUTH-003). Only an HMAC of the code is
 * stored; a new code for the same destination and purpose invalidates the old
 * one; verification is constant-time and attempt-limited under a row lock.
 */
export class OtpService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  destinationHash(destination: string): Digest {
    return hmac(this.secret, 'otp-destination', destination.trim().toLowerCase());
  }

  private codeHmac(purpose: OtpPurpose, destinationHash: Digest, code: string): Digest {
    return hmac(
      this.secret,
      'otp-code',
      `${purpose}:${Buffer.from(destinationHash).toString('hex')}:${code}`,
    );
  }

  /** Creates a new code. Throws RATE_LIMITED inside the cooldown or past the hourly cap. */
  async issue(
    destination: string,
    purpose: OtpPurpose,
    userId?: string | null,
  ): Promise<{ code: string; expiresAt: Date }> {
    const now = this.clock.now();
    const destinationHash = this.destinationHash(destination);
    const policy = AUTH_POLICY.otp;

    const latest = await this.prisma.otpCode.findFirst({
      where: { destinationHash, purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latest) {
      const elapsed = (now.getTime() - latest.createdAt.getTime()) / 1000;
      if (elapsed < policy.resendCooldownSeconds) {
        throw rateLimited(
          Math.ceil(policy.resendCooldownSeconds - elapsed),
          'Please wait before requesting another code.',
        );
      }
    }
    const lastHour = await this.prisma.otpCode.count({
      where: { destinationHash, createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
    });
    if (lastHour >= policy.maxPerDestinationPerHour) {
      throw rateLimited(3600, 'Too many codes requested. Try again in an hour.');
    }

    const code = randomDigits(policy.length);
    const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
    await this.prisma.$transaction([
      this.prisma.otpCode.updateMany({
        where: { destinationHash, purpose, consumedAt: null },
        data: { consumedAt: now },
      }),
      this.prisma.otpCode.create({
        data: {
          destinationHash,
          purpose,
          codeHmac: this.codeHmac(purpose, destinationHash, code),
          maxAttempts: policy.maxAttempts,
          expiresAt,
          userId: userId ?? null,
          createdAt: now,
        },
      }),
    ]);
    return { code, expiresAt };
  }

  /** Verifies and consumes a code. Wrong attempts are counted even though the call throws. */
  async verify(destination: string, purpose: OtpPurpose, code: string): Promise<void> {
    const now = this.clock.now();
    const destinationHash = this.destinationHash(destination);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<OtpRow[]>`
        SELECT id, code_hmac, attempts, max_attempts, expires_at, user_id
        FROM otp_codes
        WHERE destination_hash = ${destinationHash} AND purpose = ${purpose}::"OtpPurpose" AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`;
      if (!row) return 'AUTH_OTP_INVALID' as const;
      if (row.expires_at <= now) return 'AUTH_OTP_EXPIRED' as const;
      if (row.attempts >= row.max_attempts) return 'AUTH_OTP_ATTEMPTS_EXCEEDED' as const;
      if (safeEqual(row.code_hmac, this.codeHmac(purpose, destinationHash, code))) {
        await tx.otpCode.update({ where: { id: row.id }, data: { consumedAt: now } });
        return 'OK' as const;
      }
      const attempts = row.attempts + 1;
      await tx.otpCode.update({
        where: { id: row.id },
        data: { attempts, consumedAt: attempts >= row.max_attempts ? now : null },
      });
      return attempts >= row.max_attempts
        ? ('AUTH_OTP_ATTEMPTS_EXCEEDED' as const)
        : ('AUTH_OTP_INVALID' as const);
    });
    if (outcome !== 'OK') throw new AppError(outcome);
  }
}

function rateLimited(retryAfterSeconds: number, message: string): AppError {
  return new AppError('RATE_LIMITED', {
    message,
    details: [{ code: 'RETRY_AFTER', message: String(retryAfterSeconds) }],
  });
}
