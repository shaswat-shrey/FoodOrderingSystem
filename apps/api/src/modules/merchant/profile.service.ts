import type { ChangeRequestType, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import type { FieldCipher } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import type { AuditService } from '../audit';
import type { FilesService } from '../files';

export interface ProfilePatch {
  description?: string | null | undefined;
  contactEmail?: string | undefined;
  contactPhone?: string | undefined;
  cuisineIds?: string[] | undefined;
  pureVeg?: boolean | undefined;
}

/** Restaurant profile for its staff (FR-REST-010, FR-RFIN-003, API-MER-008…014). */
export class RestaurantProfileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly clock: Clock,
  ) {}

  /** API-MER-008 */
  async view(restaurantId: string) {
    const r = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      include: {
        logoFile: true,
        coverFile: true,
        cuisines: { select: { cuisine: { select: { id: true, name: true } } } },
        bankAccounts: {
          where: { status: { in: ['VERIFIED', 'PENDING_VERIFICATION'] } },
          orderBy: { createdAt: 'desc' },
        },
        changeRequests: { where: { status: 'PENDING' }, select: { type: true } },
      },
    });
    const bank = r.bankAccounts.find((b) => b.status === 'VERIFIED') ?? r.bankAccounts[0];
    return {
      id: r.id,
      brandName: r.brandName,
      slug: r.slug,
      legalName: r.legalName,
      entityType: r.entityType,
      panMasked: r.panLast4 ? `XXXXXX${r.panLast4}` : null,
      gstin: r.gstin,
      fssaiNumber: r.fssaiNumber,
      fssaiExpiresOn: r.fssaiExpiresOn?.toISOString().slice(0, 10) ?? null,
      description: r.description,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      pureVeg: r.pureVeg,
      cuisines: r.cuisines.map((c) => c.cuisine),
      logo: r.logoFile ? { fileId: r.logoFile.id, urls: this.files.urls(r.logoFile) } : null,
      cover: r.coverFile ? { fileId: r.coverFile.id, urls: this.files.urls(r.coverFile) } : null,
      bank: bank
        ? {
            holderName: bank.holderName,
            accountMasked: `XXXXXX${bank.accountLast4}`,
            ifsc: bank.ifsc,
            status: bank.status,
          }
        : null,
      pendingChanges: r.changeRequests.map((c) => c.type),
      rating: r.ratingCount ? { average: (r.ratingAvgBps ?? 0) / 100, count: r.ratingCount } : null,
    };
  }

  /** API-MER-009: non-legal fields only. */
  async update(actorId: string, restaurantId: string, patch: ProfilePatch) {
    await this.prisma.$transaction(async (tx) => {
      if (patch.cuisineIds) {
        const found = await tx.cuisine.count({
          where: { id: { in: patch.cuisineIds }, isActive: true },
        });
        if (found !== new Set(patch.cuisineIds).size)
          throw new AppError('VALIDATION_ERROR', {
            details: [{ path: 'cuisineIds', code: 'INVALID', message: 'Unknown cuisine.' }],
          });
        await tx.restaurantCuisine.deleteMany({ where: { restaurantId } });
        await tx.restaurantCuisine.createMany({
          data: [...new Set(patch.cuisineIds)].map((cuisineId) => ({ restaurantId, cuisineId })),
        });
      }
      await tx.restaurant.update({
        where: { id: restaurantId },
        data: {
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail } : {}),
          ...(patch.contactPhone !== undefined ? { contactPhone: patch.contactPhone } : {}),
          ...(patch.pureVeg !== undefined ? { pureVeg: patch.pureVeg } : {}),
        },
      });
      // Listings and menus show these fields.
      await tx.branch.updateMany({
        where: { restaurantId },
        data: { menuVersion: { increment: 1 } },
      });
      await this.audit.record(
        {
          action: 'restaurant.profile_updated',
          targetType: 'restaurant',
          targetId: restaurantId,
          actorUserId: actorId,
          after: { fields: Object.keys(patch) },
        },
        tx,
      );
    });
    return this.view(restaurantId);
  }

  /** API-MER-012/013 */
  async setImage(actorId: string, restaurantId: string, kind: 'logo' | 'cover', fileId: string) {
    let previous: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.files.claim(tx, {
        fileId,
        userId: actorId,
        purposes: [kind === 'logo' ? 'RESTAURANT_LOGO' : 'RESTAURANT_COVER'],
      });
      const r = await tx.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
      previous = kind === 'logo' ? r.logoFileId : r.coverFileId;
      await tx.restaurant.update({
        where: { id: restaurantId },
        data: kind === 'logo' ? { logoFileId: fileId } : { coverFileId: fileId },
      });
      await tx.branch.updateMany({
        where: { restaurantId },
        data: { menuVersion: { increment: 1 } },
      });
    });
    if (previous && previous !== fileId) await this.files.release(previous);
    return this.view(restaurantId);
  }

  /**
   * API-MER-010 (BR-REST-012, FR-RFIN-003): legal, tax and bank changes go to
   * admin review; values are stored encrypted. The caller has re-authenticated.
   */
  async requestChange(
    actorId: string,
    restaurantId: string,
    type: ChangeRequestType,
    values: Record<string, string>,
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.restaurantChangeRequest.count({
        where: { restaurantId, type, status: 'PENDING' },
      });
      if (pending) throw new AppError('CHANGE_REQUEST_PENDING');
      const cr = await tx.restaurantChangeRequest.create({
        data: {
          restaurantId,
          type,
          payloadEncrypted: this.cipher.encrypt(JSON.stringify(values)),
          requestedBy: actorId,
          createdAt: this.clock.now(),
        },
      });
      await writeOutbox(tx, {
        aggregateType: 'restaurant',
        aggregateId: restaurantId,
        aggregateVersion: 1,
        eventType: 'restaurant.change_requested',
        payload: { restaurantId, changeRequestId: cr.id, type },
      });
      await this.audit.record(
        {
          action: 'restaurant.change_requested',
          targetType: 'restaurant',
          targetId: restaurantId,
          actorUserId: actorId,
          after: { type, changeRequestId: cr.id },
          sensitivity: 'HIGH',
        },
        tx,
      );
      return cr;
    });
    return {
      id: created.id,
      type: created.type,
      status: created.status,
      createdAt: created.createdAt,
    };
  }

  /** API-MER-011: values are never echoed back, only what was asked and its state. */
  async changeRequests(restaurantId: string) {
    const rows = await this.prisma.restaurantChangeRequest.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((c) => ({
      id: c.id,
      type: c.type,
      status: c.status,
      reason: c.reason,
      createdAt: c.createdAt,
      decidedAt: c.decidedAt,
    }));
  }

  /**
   * FR-RFIN-002 (read-only): the restaurant's payouts from admin payout batches, newest
   * first, with the settlement period they cover and where the money went (masked).
   */
  async payouts(restaurantId: string, page: { limit: number; cursor?: string | undefined }) {
    const context = queryFingerprint(['restaurant-payouts', restaurantId]);
    const after = page.cursor ? decodeCursor(page.cursor, context) : null;
    const rows = await this.prisma.payout.findMany({
      where: {
        restaurantId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after[0] as number) } },
                { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      include: {
        batch: { select: { periodStart: true, periodEnd: true } },
        restaurantBankAccount: { select: { accountLast4: true, ifsc: true } },
        settlement: {
          select: {
            grossAmount: true,
            commissionAmount: true,
            discountsAmount: true,
            taxesAmount: true,
            adjustmentsAmount: true,
            netAmount: true,
          },
        },
      },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((p) => ({
        id: p.id,
        periodStart: p.batch.periodStart,
        periodEnd: p.batch.periodEnd,
        amount: Number(p.amount),
        status: p.status,
        utr: p.utr,
        failureReason: p.failureReason,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        bank: p.restaurantBankAccount
          ? {
              accountMasked: `XXXXXX${p.restaurantBankAccount.accountLast4}`,
              ifsc: p.restaurantBankAccount.ifsc,
            }
          : null,
        settlement: p.settlement
          ? {
              gross: Number(p.settlement.grossAmount),
              commission: Number(p.settlement.commissionAmount),
              discounts: Number(p.settlement.discountsAmount),
              taxes: Number(p.settlement.taxesAmount),
              adjustments: Number(p.settlement.adjustmentsAmount),
              net: Number(p.settlement.netAmount),
            }
          : null,
      })),
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  /** API-MER-014: branches the caller can see. */
  async branches(restaurantId: string, only: string[] | null) {
    const rows = await this.prisma.branch.findMany({
      where: { restaurantId, deletedAt: null, ...(only ? { id: { in: only } } : {}) },
      select: {
        id: true,
        name: true,
        area: true,
        city: true,
        status: true,
        isOpenManual: true,
        pausedUntil: true,
      },
      orderBy: { name: 'asc' },
    });
    const now = this.clock.now();
    return rows.map((b) => ({
      ...b,
      pausedUntil: b.pausedUntil && b.pausedUntil > now ? b.pausedUntil : null,
    }));
  }
}
