import type { DeliveryStatus, Prisma, PrismaClient } from '@fos/db';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import type { DispatchService } from '../dispatch';
import type { AdminActor, Page } from './admin.http';
import { auditAs, maskPhone, pageArgs, pageMeta } from './admin.http';

/** API-ADM-075: how far one extension may move the no-partner deadline. */
export const MAX_DEADLINE_EXTENSION_MINUTES = 60;

/**
 * The dispatch board and manual dispatch (FR-DISP-009…012, API-ADM-070…075).
 * The mechanics live in DispatchService; this adds the views and the audit.
 */
export class AdminDispatchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly dispatch: DispatchService,
    private readonly audit: AuditService,
  ) {}

  private async delivery(id: string) {
    const d = await this.prisma.delivery.findUnique({ where: { id } });
    if (!d) throw new AppError('NOT_FOUND', { message: "We couldn't find that delivery." });
    return d;
  }

  /** API-ADM-070: open deliveries by default, escalated and oldest first. */
  async board(
    filter: Page & {
      status?: DeliveryStatus | undefined;
      escalated?: boolean | undefined;
      zone?: string | undefined;
    },
  ) {
    const where: Prisma.DeliveryWhereInput = {
      status: filter.status ?? {
        in: [
          'PENDING',
          'SEARCHING',
          'ASSIGNED',
          'AT_RESTAURANT',
          'EN_ROUTE_TO_CUSTOMER',
          'AT_CUSTOMER',
        ],
      },
      ...(filter.escalated === undefined ? {} : { escalated: filter.escalated }),
      ...(filter.zone ? { branch: { zoneId: filter.zone } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        orderBy: [{ escalated: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(filter),
        include: {
          order: {
            select: { id: true, number: true, status: true, readyBy: true, paymentMethod: true },
          },
          branch: {
            select: {
              id: true,
              name: true,
              zoneId: true,
              restaurant: { select: { brandName: true } },
            },
          },
          partner: { select: { id: true, legalName: true, user: { select: { phone: true } } } },
          assignments: {
            where: { status: { in: ['OFFERED', 'ACCEPTED'] } },
            select: {
              id: true,
              status: true,
              partnerId: true,
              manual: true,
              expiresAt: true,
              respondedAt: true,
            },
          },
          _count: { select: { assignments: true } },
        },
      }),
      this.prisma.delivery.count({ where }),
    ]);
    return {
      items: rows.map((d) => {
        const manual = d.assignments.find((a) => a.status === 'ACCEPTED' && a.manual);
        return {
          id: d.id,
          status: d.status,
          escalated: d.escalated,
          searchRound: d.searchRound,
          offers: d._count.assignments,
          openOffer: d.assignments.find((a) => a.status === 'OFFERED') ?? null,
          noPartnerDeadline: d.noPartnerDeadline,
          deadlineExtended: d.deadlineExtended,
          createdAt: d.createdAt,
          assignedAt: d.assignedAt,
          order: d.order,
          restaurant: { name: d.branch.restaurant.brandName, branch: d.branch.name },
          zoneId: d.branch.zoneId,
          partner: d.partner
            ? {
                id: d.partner.id,
                name: d.partner.legalName,
                phone: maskPhone(d.partner.user.phone),
              }
            : null,
          manualAssignment: manual
            ? { acknowledgeBy: manual.expiresAt, acknowledgedAt: manual.respondedAt }
            : null,
        };
      }),
      meta: pageMeta(filter, total),
    };
  }

  /** API-ADM-071 (FR-DISP-011): eligible partners, best first. */
  async candidates(id: string) {
    await this.delivery(id);
    const ranked = await this.dispatch.rankedFor(id);
    const partners = await this.prisma.deliveryPartner.findMany({
      where: { id: { in: ranked.map((c) => c.partnerId) } },
      select: { id: true, legalName: true, user: { select: { phone: true } } },
    });
    return ranked.map((c, i) => {
      const p = partners.find((x) => x.id === c.partnerId);
      return {
        rank: i + 1,
        partnerId: c.partnerId,
        name: p?.legalName ?? null,
        phone: maskPhone(p?.user.phone),
        distanceM: Math.round(c.distanceM),
        etaMinutes: Math.round(c.etaMinutes * 10) / 10,
        acceptanceRate: c.acceptanceRate,
        rating: c.rating,
        deliveriesToday: c.deliveriesToday,
        score: c.score,
        breakdown: c.breakdown,
      };
    });
  }

  /** API-ADM-072 ★ */
  async assign(
    actor: AdminActor,
    id: string,
    input: { partnerId: string; force: boolean; reason: string },
  ) {
    const before = await this.delivery(id);
    const result = await this.dispatch.assignManually(id, input.partnerId, {
      userId: actor.userId,
      force: input.force,
    });
    await auditAs(this.audit, actor, {
      action: 'admin.delivery_assigned',
      targetType: 'delivery',
      targetId: id,
      reason: input.reason,
      before: { status: before.status, partnerId: before.partnerId },
      after: { status: result.status, partnerId: input.partnerId, force: input.force },
      sensitivity: 'HIGH',
    });
    return result;
  }

  /** API-ADM-073 ★ */
  async reassign(
    actor: AdminActor,
    id: string,
    input: { partnerId: string; force: boolean; reason: string },
  ) {
    const before = await this.delivery(id);
    const result = await this.dispatch.reassign(id, input.partnerId, {
      userId: actor.userId,
      force: input.force,
      reason: input.reason,
    });
    await auditAs(this.audit, actor, {
      action: 'admin.delivery_reassigned',
      targetType: 'delivery',
      targetId: id,
      reason: input.reason,
      before: { status: before.status, partnerId: before.partnerId },
      after: { status: result.status, partnerId: input.partnerId, force: input.force },
      sensitivity: 'HIGH',
    });
    return result;
  }

  /** API-ADM-074: release any partner and restart automatic dispatch from round one. */
  async redispatch(actor: AdminActor, id: string, reason: string | undefined) {
    const before = await this.delivery(id);
    const result = await this.dispatch.redispatch(
      id,
      actor.userId,
      reason ?? 'Re-dispatched by ops',
    );
    await auditAs(this.audit, actor, {
      action: 'admin.delivery_redispatched',
      targetType: 'delivery',
      targetId: id,
      reason: reason ?? null,
      before: { status: before.status, partnerId: before.partnerId },
      after: { status: result.status, outcome: result.outcome },
      sensitivity: 'NORMAL',
    });
    return result;
  }

  /** API-ADM-075 ★ (FR-DISP-010): once per delivery. */
  async extendDeadline(actor: AdminActor, id: string, input: { minutes: number; reason: string }) {
    await this.delivery(id);
    const result = await this.dispatch.extendDeadline(id, input.minutes);
    await auditAs(this.audit, actor, {
      action: 'admin.delivery_deadline_extended',
      targetType: 'delivery',
      targetId: id,
      reason: input.reason,
      before: { noPartnerDeadline: result.before?.toISOString() ?? null },
      after: { noPartnerDeadline: result.noPartnerDeadline.toISOString() },
      sensitivity: 'HIGH',
    });
    return { deliveryId: id, noPartnerDeadline: result.noPartnerDeadline };
  }
}
