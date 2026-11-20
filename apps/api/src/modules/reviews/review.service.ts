import { Prisma, type PrismaClient, type ReviewReportReason } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import type { SettingsService } from '../config';
import type { FilesService } from '../files';
import { moderateText } from './moderation';

type Tx = Prisma.TransactionClient;
type Page = { limit: number; cursor?: string | undefined };

export const RESTAURANT_TAGS = ['TASTE', 'PORTION', 'PACKAGING', 'VALUE'] as const;
export const PARTNER_TAGS = ['POLITE', 'ON_TIME', 'FOLLOWED_INSTRUCTIONS', 'RUDE', 'LATE'] as const;

export interface ReviewInput {
  restaurant?:
    | {
        rating: number;
        text?: string | undefined;
        tags?: string[] | undefined;
        photoFileIds?: string[] | undefined;
      }
    | undefined;
  partner?: { rating: number; text?: string | undefined; tags?: string[] | undefined } | undefined;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const keyset = (after: (string | number)[] | null) =>
  after
    ? {
        OR: [
          { createdAt: { lt: new Date(after[0] as number) } },
          { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
        ],
      }
    : {};

/**
 * Reviews (FR-REV-001…006, FR-RREV-001…003, BR-REVIEW-001…007). Aggregates are
 * recomputed from the outbox event `review.changed` (JOB-REV-001), not inline.
 */
export class ReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  private changed(
    tx: Tx,
    r: {
      id: string;
      branchId: string | null;
      restaurantId: string | null;
      partnerId: string | null;
    },
  ) {
    return writeOutbox(tx, {
      aggregateType: 'review',
      aggregateId: r.id,
      aggregateVersion: 1,
      eventType: 'review.changed',
      payload: { branchId: r.branchId, restaurantId: r.restaurantId, partnerId: r.partnerId },
    });
  }

  private clean(text: string | undefined) {
    if (text === undefined) return null;
    const t = moderateText(text).text;
    return t.length > 0 ? t : null;
  }

  /** API-REV-001: rate the restaurant and/or the partner of a delivered order. */
  async submit(userId: string, orderId: string, input: ReviewInput) {
    const [windowDays, editHours] = await Promise.all([
      this.settings.get('review.windowDays'),
      this.settings.get('review.editHours'),
    ]);
    const now = this.clock.now();
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: {
        id: true,
        status: true,
        deliveredAt: true,
        restaurantId: true,
        branchId: true,
        delivery: { select: { partnerId: true, status: true } },
      },
    });
    if (!order) throw new AppError('NOT_FOUND', { message: 'Order not found.' });
    // BR-REVIEW-001: only after delivery, within the window.
    if (
      order.status !== 'DELIVERED' ||
      !order.deliveredAt ||
      now.getTime() - order.deliveredAt.getTime() > windowDays * DAY
    )
      throw new AppError('REVIEW_NOT_ALLOWED');
    const partnerId = order.delivery?.status === 'DELIVERED' ? order.delivery.partnerId : null;
    if (input.partner && !partnerId)
      throw new AppError('REVIEW_NOT_ALLOWED', {
        message: 'This order had no delivery partner to rate.',
      });
    const editableUntil = new Date(now.getTime() + editHours * HOUR);
    try {
      const ids = await this.prisma.$transaction(async (tx) => {
        const created: string[] = [];
        if (input.restaurant) {
          const r = await tx.review.create({
            data: {
              orderId,
              authorId: userId,
              targetType: 'RESTAURANT',
              restaurantId: order.restaurantId,
              branchId: order.branchId,
              rating: input.restaurant.rating,
              text: this.clean(input.restaurant.text),
              editableUntil,
              createdAt: now,
              tags: { create: [...new Set(input.restaurant.tags ?? [])].map((tag) => ({ tag })) },
            },
          });
          for (const fileId of input.restaurant.photoFileIds ?? []) {
            await this.files.claim(tx, { fileId, userId, purposes: ['REVIEW_PHOTO'] });
            await tx.reviewPhoto.create({ data: { reviewId: r.id, fileId } });
          }
          await this.changed(tx, r);
          created.push(r.id);
        }
        if (input.partner && partnerId) {
          const r = await tx.review.create({
            data: {
              orderId,
              authorId: userId,
              targetType: 'PARTNER',
              partnerId,
              rating: input.partner.rating,
              text: this.clean(input.partner.text),
              editableUntil,
              createdAt: now,
              tags: { create: [...new Set(input.partner.tags ?? [])].map((tag) => ({ tag })) },
            },
          });
          await this.changed(tx, r);
          created.push(r.id);
        }
        return created;
      });
      return this.byIds(ids);
    } catch (error) {
      // BR-REVIEW-002: reviews_one_per_target_uq.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AppError('REVIEW_ALREADY_SUBMITTED');
      throw error;
    }
  }

  private async byIds(ids: string[]) {
    const rows = await this.prisma.review.findMany({
      where: { id: { in: ids } },
      include: this.include,
      orderBy: { targetType: 'asc' },
    });
    return rows.map((r) => this.view(r));
  }

  private readonly include = {
    tags: { select: { tag: true } },
    photos: { select: { file: true } },
    response: { select: { text: true, createdAt: true, updatedAt: true } },
  } satisfies Prisma.ReviewInclude;

  private view(
    r: Prisma.ReviewGetPayload<{ include: ReviewService['include'] }>,
    extra: Record<string, unknown> = {},
  ) {
    const now = this.clock.now();
    return {
      id: r.id,
      orderId: r.orderId,
      target: r.targetType,
      rating: r.rating,
      text: r.text,
      tags: r.tags.map((t) => t.tag),
      photos: r.photos.map((p) => ({ id: p.file.id, urls: this.files.urls(p.file) })),
      status: r.status,
      editable: r.editableUntil > now && r.status === 'PUBLISHED',
      editableUntil: r.editableUntil,
      response: r.response ? { text: r.response.text, at: r.response.updatedAt } : null,
      createdAt: r.createdAt,
      ...extra,
    };
  }

  private async own(userId: string, reviewId: string) {
    const r = await this.prisma.review.findFirst({
      where: { id: reviewId, authorId: userId, deletedAt: null },
    });
    if (!r) throw new AppError('NOT_FOUND', { message: 'Review not found.' });
    return r;
  }

  /** API-REV-002 (BR-REVIEW-003): edits within 48 h. */
  async edit(
    userId: string,
    reviewId: string,
    patch: {
      rating?: number | undefined;
      text?: string | null | undefined;
      tags?: string[] | undefined;
    },
  ) {
    const r = await this.own(userId, reviewId);
    if (r.editableUntil <= this.clock.now() || r.status !== 'PUBLISHED')
      throw new AppError('REVIEW_EDIT_WINDOW_CLOSED');
    const allowed: readonly string[] = r.targetType === 'PARTNER' ? PARTNER_TAGS : RESTAURANT_TAGS;
    if (patch.tags?.some((t) => !allowed.includes(t)))
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'tags', code: 'INVALID', message: `Use: ${allowed.join(', ')}` }],
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({
        where: { id: r.id },
        data: {
          ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
          ...(patch.text !== undefined
            ? { text: patch.text === null ? null : this.clean(patch.text) }
            : {}),
        },
      });
      if (patch.tags) {
        await tx.reviewTag.deleteMany({ where: { reviewId: r.id } });
        await tx.reviewTag.createMany({
          data: [...new Set(patch.tags)].map((tag) => ({ reviewId: r.id, tag })),
        });
      }
      if (patch.rating !== undefined) await this.changed(tx, r);
    });
    return (await this.byIds([r.id]))[0]!;
  }

  /** API-REV-003: soft delete, any time. */
  async remove(userId: string, reviewId: string) {
    const r = await this.own(userId, reviewId);
    const photos = await this.prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id: r.id }, data: { deletedAt: this.clock.now() } });
      await this.changed(tx, r);
      const p = await tx.reviewPhoto.findMany({
        where: { reviewId: r.id },
        select: { fileId: true },
      });
      await tx.reviewPhoto.deleteMany({ where: { reviewId: r.id } });
      return p;
    });
    for (const p of photos) await this.files.release(p.fileId);
  }

  /** API-REV-004. */
  async mine(userId: string, page: Page) {
    const context = queryFingerprint(['my-reviews', userId]);
    const after = page.cursor ? decodeCursor(page.cursor, context) : null;
    const rows = await this.prisma.review.findMany({
      where: { authorId: userId, deletedAt: null, ...keyset(after) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      include: {
        ...this.include,
        order: {
          select: {
            number: true,
            branch: { select: { name: true, restaurant: { select: { brandName: true } } } },
          },
        },
      },
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((r) =>
        this.view(r, {
          orderNumber: r.order.number,
          restaurant: `${r.order.branch.restaurant.brandName}, ${r.order.branch.name}`,
        }),
      ),
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  /**
   * API-REV-005 / API-RREV-004 (FR-REV-005): a reporter counts once per review;
   * enough independent reports hide it until moderation (BR-REVIEW-004).
   */
  async report(
    userId: string,
    reviewId: string,
    input: { reason: ReviewReportReason; note?: string | undefined },
  ) {
    const threshold = await this.settings.get('review.reportsToHide');
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.review.findFirst({ where: { id: reviewId, deletedAt: null } });
      if (!r) throw new AppError('NOT_FOUND', { message: 'Review not found.' });
      if (r.authorId === userId)
        throw new AppError('VALIDATION_ERROR', { message: 'You can’t report your own review.' });
      await tx.reviewReport.upsert({
        where: { reviewId_reporterId: { reviewId, reporterId: userId } },
        create: {
          reviewId,
          reporterId: userId,
          reason: input.reason,
          note: input.note ?? null,
          createdAt: this.clock.now(),
        },
        update: {},
      });
      const open = await tx.reviewReport.count({ where: { reviewId, status: 'OPEN' } });
      let hidden = r.status === 'HIDDEN';
      if (!hidden && r.status === 'PUBLISHED' && open >= threshold) {
        await tx.review.update({ where: { id: r.id }, data: { status: 'HIDDEN' } });
        await this.changed(tx, r);
        hidden = true;
      }
      return { reported: true, hidden };
    });
  }

  /**
   * FR-ADMIN-082 (API-ADM-164/165): a moderator's decision, inside the caller's
   * transaction. Hiding upholds the open reports; restoring dismisses them (and
   * any earlier upheld ones). Ratings follow through `review.changed`.
   */
  async moderate(tx: Tx, reviewId: string, hide: boolean) {
    await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
    const r = await tx.review.findFirst({ where: { id: reviewId, deletedAt: null } });
    if (!r || r.status === 'REMOVED')
      throw new AppError('NOT_FOUND', { message: 'Review not found.' });
    const to = hide ? 'HIDDEN' : 'PUBLISHED';
    const open = await tx.reviewReport.count({ where: { reviewId, status: 'OPEN' } });
    if (r.status === to && open === 0)
      throw new AppError('RESOURCE_CONFLICT', {
        message: hide ? 'This review is already hidden.' : 'This review is already visible.',
      });
    const reports = await tx.reviewReport.updateMany({
      where: { reviewId, status: hide ? 'OPEN' : { in: ['OPEN', 'UPHELD'] } },
      data: { status: hide ? 'UPHELD' : 'DISMISSED' },
    });
    if (r.status !== to) {
      await tx.review.update({ where: { id: r.id }, data: { status: to } });
      await this.changed(tx, r);
    }
    return { id: r.id, before: r.status, status: to, reportsResolved: reports.count };
  }

  /** API-RREV-001 (FR-RREV-001): a branch's reviews for its team. Customers show by first name. */
  async forBranch(
    branchId: string,
    filter: Page & { rating?: number | undefined; responded?: boolean | undefined },
  ) {
    const context = queryFingerprint(['branch-reviews', branchId, filter.rating, filter.responded]);
    const after = filter.cursor ? decodeCursor(filter.cursor, context) : null;
    const rows = await this.prisma.review.findMany({
      where: {
        branchId,
        targetType: 'RESTAURANT',
        deletedAt: null,
        status: { in: ['PUBLISHED', 'HIDDEN'] },
        ...(filter.rating ? { rating: filter.rating } : {}),
        ...(filter.responded === undefined
          ? {}
          : filter.responded
            ? { response: { isNot: null } }
            : { response: { is: null } }),
        ...keyset(after),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
      include: {
        ...this.include,
        author: { select: { fullName: true } },
        order: { select: { number: true } },
        response: { select: { text: true, createdAt: true, updatedAt: true, editableUntil: true } },
      },
    });
    const items = rows.slice(0, filter.limit);
    const last = items.at(-1);
    const now = this.clock.now();
    return {
      items: items.map((r) =>
        this.view(r, {
          author: r.author.fullName.split(/\s+/)[0],
          orderNumber: r.order.number,
          response: r.response
            ? {
                text: r.response.text,
                at: r.response.updatedAt,
                editable: r.response.editableUntil > now,
              }
            : null,
          editable: undefined,
          editableUntil: undefined,
        }),
      ),
      nextCursor:
        rows.length > filter.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  /** The branch a restaurant review belongs to (for the caller's permission check). */
  async branchOf(reviewId: string) {
    const r = await this.prisma.review.findFirst({
      where: { id: reviewId, targetType: 'RESTAURANT', deletedAt: null },
      select: { branchId: true },
    });
    if (!r?.branchId) throw new AppError('NOT_FOUND', { message: 'Review not found.' });
    return r.branchId;
  }

  /** API-RREV-002 (BR-REVIEW-005): one public response per review. */
  async respond(userId: string, reviewId: string, text: string) {
    const hours = await this.settings.get('review.responseEditHours');
    const now = this.clock.now();
    try {
      await this.prisma.reviewResponse.create({
        data: {
          reviewId,
          authorId: userId,
          text: moderateText(text).text,
          editableUntil: new Date(now.getTime() + hours * HOUR),
          createdAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new AppError('REVIEW_ALREADY_SUBMITTED', {
          message: 'This review already has a response.',
        });
      throw error;
    }
    return { reviewId, text: moderateText(text).text };
  }

  /** API-RREV-003: edits within 24 h. */
  async editResponse(reviewId: string, text: string) {
    const r = await this.prisma.reviewResponse.findUnique({ where: { reviewId } });
    if (!r) throw new AppError('NOT_FOUND', { message: 'No response to edit.' });
    if (r.editableUntil <= this.clock.now()) throw new AppError('REVIEW_EDIT_WINDOW_CLOSED');
    const clean = moderateText(text).text;
    await this.prisma.reviewResponse.update({ where: { reviewId }, data: { text: clean } });
    return { reviewId, text: clean };
  }

  /**
   * JOB-REV-001 (FR-REV-006): recompute the averages a change touched, from published
   * reviews only. Stored raw (hundredths of a star); display smoothing happens on read.
   */
  async recompute(target: {
    branchId?: string | null;
    restaurantId?: string | null;
    partnerId?: string | null;
  }) {
    const avg = async (where: Prisma.ReviewWhereInput) => {
      const a = await this.prisma.review.aggregate({
        where: { ...where, status: 'PUBLISHED', deletedAt: null },
        _avg: { rating: true },
        _count: { _all: true },
      });
      return {
        ratingAvgBps:
          a._count._all > 0 && a._avg.rating !== null ? Math.round(a._avg.rating * 100) : null,
        ratingCount: a._count._all,
      };
    };
    if (target.branchId)
      await this.prisma.branch.update({
        where: { id: target.branchId },
        data: await avg({ branchId: target.branchId, targetType: 'RESTAURANT' }),
      });
    if (target.restaurantId)
      await this.prisma.restaurant.update({
        where: { id: target.restaurantId },
        data: await avg({ restaurantId: target.restaurantId, targetType: 'RESTAURANT' }),
      });
    if (target.partnerId) {
      const data = await avg({ partnerId: target.partnerId, targetType: 'PARTNER' });
      await this.prisma.partnerStats.upsert({
        where: { partnerId: target.partnerId },
        create: { partnerId: target.partnerId, ...data },
        update: data,
      });
    }
  }

  /** API-EARN-010 (BR-REVIEW-006): averages and tag counts, never per-order ratings or identity. */
  async partnerSummary(partnerId: string) {
    const where = {
      partnerId,
      targetType: 'PARTNER' as const,
      status: 'PUBLISHED' as const,
      deletedAt: null,
    };
    const [groups, tags, stats, comments] = await Promise.all([
      this.prisma.review.groupBy({ by: ['rating'], where, _count: { _all: true } }),
      this.prisma.reviewTag.groupBy({
        by: ['tag'],
        where: { review: where },
        _count: { _all: true },
      }),
      this.prisma.partnerStats.findUnique({ where: { partnerId } }),
      this.prisma.review.findMany({
        where: { ...where, text: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { text: true },
      }),
    ]);
    const count = stats?.ratingCount ?? 0;
    return {
      average: stats?.ratingAvgBps ? stats.ratingAvgBps / 100 : null,
      count,
      distribution: Object.fromEntries(
        [5, 4, 3, 2, 1].map((r) => [r, groups.find((g) => g.rating === r)?._count._all ?? 0]),
      ),
      tags: Object.fromEntries(tags.map((t) => [t.tag, t._count._all])),
      // Comments only once there are enough ratings that none can be tied to one trip.
      comments: count >= 5 ? comments.map((c) => c.text!).sort() : [],
    };
  }
}
