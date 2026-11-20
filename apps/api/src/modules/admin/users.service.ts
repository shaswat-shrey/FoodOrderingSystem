import type { Prisma, PrismaClient, UserStatus } from '@fos/db';
import { uuidv7, type PlatformRole } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import { maskIp, type SessionService } from '../auth';
import type { WalletService } from '../ledger';
import type { AdminActor, Page } from './admin.http';
import { maskEmail, maskPhone, pageArgs, pageMeta } from './admin.http';

/** Takes a partner off dispatch (implemented by the admin partners service). */
export interface PartnerOffliner {
  forceOfflineForUser(userId: string, reason: 'SUSPENDED'): Promise<void>;
}

/** Bound on one wallet adjustment (₹10,000); maker-checker above ₹500 is CORE (BR-WALLET-004). */
export const MAX_WALLET_ADJUSTMENT = 1_000_000;

/** Customer / user management for the admin console (FR-ADMIN-010, FR-AUTH-040, API-ADM-010…019). */
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly wallet: WalletService,
    private readonly partners: PartnerOffliner,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async user(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw new AppError('NOT_FOUND', { message: "We couldn't find that user." });
    return u;
  }

  /** BR-ADMIN-001: staff don't act on their own account. */
  private notSelf(actor: AdminActor, userId: string) {
    if (actor.userId === userId)
      throw new AppError('FORBIDDEN', { message: 'You can’t do this to your own account.' });
  }

  private record(
    actor: AdminActor,
    entry: {
      action: string;
      targetId: string;
      reason?: string | null;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      sensitivity?: 'NORMAL' | 'HIGH';
    },
    tx?: Prisma.TransactionClient,
  ) {
    return this.audit.record(
      {
        action: entry.action,
        targetType: 'user',
        targetId: entry.targetId,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        sessionId: actor.sessionId,
        reason: entry.reason ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        sensitivity: entry.sensitivity ?? 'HIGH',
      },
      tx,
    );
  }

  /** API-ADM-010: search by name, phone or email; PII masked. */
  async list(
    filter: Page & { role?: PlatformRole | undefined; status?: UserStatus | undefined; q?: string },
  ) {
    const q = filter.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.role ? { roles: { some: { role: { key: filter.role } } } } : {}),
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q.replace(/[\s-]/g, '') } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          status: true,
          createdAt: true,
          roles: { select: { role: { select: { key: true } } } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: rows.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        phone: maskPhone(u.phone),
        email: maskEmail(u.email),
        status: u.status,
        roles: u.roles.map((r) => r.role.key).sort(),
        createdAt: u.createdAt,
      })),
      meta: pageMeta(filter, total),
    };
  }

  /** API-ADM-011: user 360 with masked PII. */
  async detail(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: {
        roles: { select: { role: { select: { key: true } } } },
        customerProfile: true,
        deliveryPartner: { select: { id: true, onboardingStatus: true, status: true } },
        restaurantMemberships: {
          where: { status: { not: 'REMOVED' } },
          select: {
            role: true,
            status: true,
            restaurant: { select: { id: true, brandName: true, status: true } },
          },
        },
      },
    });
    if (!u) throw new AppError('NOT_FOUND', { message: "We couldn't find that user." });
    const [orders, delivered, sessions, wallet] = await Promise.all([
      this.prisma.order.count({ where: { userId: id } }),
      this.prisma.order.count({ where: { userId: id, status: 'DELIVERED' } }),
      this.prisma.userSession.count({
        where: { userId: id, status: 'ACTIVE', absoluteExpiresAt: { gt: this.clock.now() } },
      }),
      this.wallet.summary(id),
    ]);
    return {
      id: u.id,
      fullName: u.fullName,
      phone: maskPhone(u.phone),
      email: maskEmail(u.email),
      phoneVerified: Boolean(u.phoneVerifiedAt),
      emailVerified: Boolean(u.emailVerifiedAt),
      status: u.status,
      suspension:
        u.status === 'SUSPENDED' ? { reason: u.suspensionReason, until: u.suspendedUntil } : null,
      roles: u.roles.map((r) => r.role.key).sort(),
      flags: {
        codBlocked: u.customerProfile?.codBlocked ?? false,
        codRefusalCount: u.customerProfile?.codRefusalCount ?? 0,
      },
      wallet: { availableAmount: wallet.availableAmount, heldAmount: wallet.heldAmount },
      orders: { total: orders, delivered },
      activeSessions: sessions,
      partner: u.deliveryPartner,
      restaurants: u.restaurantMemberships.map((m) => ({
        ...m.restaurant,
        role: m.role,
        memberStatus: m.status,
      })),
      deletionScheduledAt: u.deletionScheduledAt,
      createdAt: u.createdAt,
    };
  }

  /** API-ADM-012 (FR-AUTH-040): blocks sign-in, ends every session, drops open carts, takes a partner offline. */
  async suspend(
    actor: AdminActor,
    id: string,
    input: { reason: string; until?: Date | undefined },
  ) {
    this.notSelf(actor, id);
    const u = await this.user(id);
    if (u.status === 'SUSPENDED') throw new AppError('ACCOUNT_STATE_CONFLICT');
    if (u.status === 'ANONYMIZED')
      throw new AppError('ACCOUNT_STATE_CONFLICT', { message: 'This account has been deleted.' });
    if (input.until && input.until <= this.clock.now())
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'until', code: 'PAST', message: 'Pick a time in the future.' }],
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          status: 'SUSPENDED',
          suspensionReason: input.reason,
          suspendedUntil: input.until ?? null,
        },
      });
      await tx.cart.updateMany({
        where: { userId: id, status: 'ACTIVE' },
        data: { status: 'ABANDONED' },
      });
      await writeOutbox(tx, {
        aggregateType: 'user',
        aggregateId: id,
        aggregateVersion: u.tokenVersion + 1,
        eventType: 'user.suspended',
        payload: { userId: id, until: input.until?.toISOString() ?? null },
      });
      await this.record(
        actor,
        {
          action: 'admin.user_suspended',
          targetId: id,
          reason: input.reason,
          before: { status: u.status },
          after: { status: 'SUSPENDED', until: input.until?.toISOString() ?? null },
        },
        tx,
      );
    });
    await this.sessions.revokeAll(id, 'SUSPENDED');
    await this.partners.forceOfflineForUser(id, 'SUSPENDED');
    return this.detail(id);
  }

  /** API-ADM-013 (FR-AUTH-042): lifts a suspension; the user signs in again. */
  async unsuspend(actor: AdminActor, id: string, reason: string) {
    this.notSelf(actor, id);
    const u = await this.user(id);
    if (u.status !== 'SUSPENDED')
      throw new AppError('ACCOUNT_STATE_CONFLICT', { message: 'This account isn’t suspended.' });
    const status: UserStatus = u.phoneVerifiedAt ? 'ACTIVE' : 'PENDING_VERIFICATION';
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { status, suspensionReason: null, suspendedUntil: null },
      });
      await writeOutbox(tx, {
        aggregateType: 'user',
        aggregateId: id,
        aggregateVersion: u.tokenVersion,
        eventType: 'user.unsuspended',
        payload: { userId: id },
      });
      await this.record(
        actor,
        {
          action: 'admin.user_unsuspended',
          targetId: id,
          reason,
          before: { status: 'SUSPENDED' },
          after: { status },
        },
        tx,
      );
    });
    await this.sessions.invalidateUser(id);
    return this.detail(id);
  }

  /** API-ADM-014: ends every session of the user now. */
  async logoutAll(actor: AdminActor, id: string, reason: string) {
    await this.user(id);
    const revoked = await this.sessions.revokeAll(id, 'ADMIN_REVOKED');
    await this.record(actor, {
      action: 'admin.user_logged_out',
      targetId: id,
      reason,
      after: { sessionsRevoked: revoked.length },
    });
    return { sessionsRevoked: revoked.length };
  }

  /** API-ADM-015: unmasked phone and email, audited with the reason. */
  async revealPii(actor: AdminActor, id: string, reason: string) {
    const u = await this.user(id);
    await this.record(actor, {
      action: 'admin.pii_revealed',
      targetId: id,
      reason,
      after: { fields: ['phone', 'email'] },
    });
    return { id: u.id, phone: u.phone, email: u.email };
  }

  /** API-ADM-016 (BR-WALLET-004): credit (+) or debit (−) the customer wallet through the ledger. */
  async adjustWallet(
    actor: AdminActor,
    id: string,
    input: { amount: number; reason: string; expiresAt?: Date | undefined },
  ) {
    this.notSelf(actor, id);
    await this.user(id);
    if (input.expiresAt && input.expiresAt <= this.clock.now())
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'expiresAt', code: 'PAST', message: 'Pick a time in the future.' }],
      });
    const adjustmentId = uuidv7();
    const before = await this.wallet.available(id);
    await this.prisma.$transaction(async (tx) => {
      await this.wallet.adjust(tx, {
        userId: id,
        amount: input.amount,
        referenceId: adjustmentId,
        description: input.amount > 0 ? 'Credit from customer support' : 'Wallet correction',
        createdBy: actor.userId,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      });
      await this.record(
        actor,
        {
          action: 'admin.wallet_adjusted',
          targetId: id,
          reason: input.reason,
          before: { availableAmount: before },
          after: { amount: input.amount, adjustmentId },
        },
        tx,
      );
    });
    return {
      adjustmentId,
      amount: input.amount,
      availableAmount: await this.wallet.available(id),
    };
  }

  /** API-ADM-017: sets or clears the COD block checked at checkout. */
  async setCodBlock(actor: AdminActor, id: string, input: { blocked: boolean; reason: string }) {
    await this.user(id);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.customerProfile.findUnique({ where: { userId: id } });
      await tx.customerProfile.upsert({
        where: { userId: id },
        create: { userId: id, codBlocked: input.blocked },
        update: { codBlocked: input.blocked },
      });
      await this.record(
        actor,
        {
          action: input.blocked ? 'admin.user_cod_blocked' : 'admin.user_cod_unblocked',
          targetId: id,
          reason: input.reason,
          before: { codBlocked: before?.codBlocked ?? false },
          after: { codBlocked: input.blocked },
        },
        tx,
      );
    });
    return { userId: id, codBlocked: input.blocked };
  }

  /** API-ADM-019 */
  async sessionsOf(id: string) {
    await this.user(id);
    const rows = await this.sessions.list(id);
    return rows.map((s) => ({ ...s, ip: s.ip ? maskIp(s.ip) : null }));
  }
}
