import type { PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { hmac } from '../../platform/crypto';
import type { AuditService } from '../audit';

/**
 * JOB-USER-001 (FR-AUTH-041): anonymises accounts whose deletion grace period
 * has ended. Orders, payments and ledger rows stay for legal retention (SRS §20)
 * but point to an anonymous user. Safe to run repeatedly; a reactivated account
 * is skipped.
 */
export class AccountAnonymizer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly hmacSecret: string,
  ) {}

  async run(limit = 100): Promise<number> {
    const due = await this.prisma.user.findMany({
      where: { status: 'DEACTIVATED', deletionScheduledAt: { lte: this.clock.now() } },
      select: { id: true },
      take: limit,
    });
    for (const { id } of due) await this.anonymize(id);
    return due.length;
  }

  private async anonymize(userId: string): Promise<void> {
    const tombstone = Buffer.from(hmac(this.hmacSecret, 'anonymized-user', userId))
      .toString('hex')
      .slice(0, 24);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.status !== 'DEACTIVATED') return; // reactivated meanwhile
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'ANONYMIZED',
          fullName: 'Deleted user',
          email: `deleted-${tombstone}@deleted.invalid`,
          phone: null,
          emailVerifiedAt: null,
          phoneVerifiedAt: null,
          avatarFileId: null,
          deletionScheduledAt: null,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.$executeRaw`
        UPDATE customer_addresses
        SET line1 = 'Deleted', line2 = NULL, landmark = NULL, area = 'Deleted', contact_name = 'Deleted user',
            contact_phone = '+910000000000', instructions = NULL, location = ST_GeogFromText('SRID=4326;POINT(0 0)'),
            is_default = false, deleted_at = COALESCE(deleted_at, now())
        WHERE user_id = ${userId}::uuid`;
      await tx.userCredential.deleteMany({ where: { userId } });
      await tx.oAuthAccount.deleteMany({ where: { userId } });
      await tx.mfaFactor.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.pushSubscription.deleteMany({ where: { userId } });
      await tx.searchHistory.deleteMany({ where: { userId } });
      await tx.customerAllergen.deleteMany({ where: { userId } });
      await tx.customerDietaryPreference.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.verificationToken.deleteMany({ where: { userId } });
      await this.audit.record(
        { action: 'account.anonymized', targetType: 'user', targetId: userId, sensitivity: 'HIGH' },
        tx,
      );
    });
  }
}
