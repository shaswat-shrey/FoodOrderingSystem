import type { EntityType, Prisma, PrismaClient, Restaurant, RestaurantDocumentType } from '@fos/db';
import { uuidv7 } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import type { FieldCipher } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import type { ServiceabilityService } from '../catalog';
import type { FilesService } from '../files';
import type { PermissionChanges } from './access';
import { fromTime, toTime, type Slot } from './hours';

type Tx = Prisma.TransactionClient;

const EDITABLE = new Set(['DRAFT', 'CHANGES_REQUESTED']);
const OPEN = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED'] as const;
const MAX_SUBMISSIONS = 5; // BR-REST-008
const REAPPLY_DAYS = 30; // BR-REST-007
const MIN_RADIUS_M = 500; // BR-GEO-002

export interface ApplicationPatch {
  brandName?: string | undefined;
  legalName?: string | undefined;
  entityType?: EntityType | undefined;
  pan?: string | undefined;
  gstin?: string | null | undefined;
  fssaiNumber?: string | undefined;
  fssaiExpiresOn?: string | undefined;
  description?: string | null | undefined;
  contactEmail?: string | undefined;
  contactPhone?: string | undefined;
  cuisineIds?: string[] | undefined;
  pureVeg?: boolean | undefined;
  logoFileId?: string | undefined;
  branch?:
    | {
        name: string;
        line1: string;
        line2?: string | null | undefined;
        area: string;
        city: string;
        state: string;
        pincode: string;
        location: { lat: number; lng: number };
        phone?: string | null | undefined;
        deliveryRadiusM: number;
        defaultPrepMinutes: number;
        priceForTwo?: number | null | undefined;
        hours: Slot[];
      }
    | undefined;
  bank?: { holderName: string; accountNumber: string; ifsc: string } | undefined;
}

const DOC_LABEL: Record<string, string> = {
  FSSAI: 'FSSAI licence',
  PAN: 'PAN card',
  GST: 'GST certificate',
  BANK_PROOF: 'Cancelled cheque or bank proof',
};

/**
 * Restaurant applications (FR-REST-001…005, API-MER-001…007). The application
 * is the restaurant row itself in an onboarding status; the first branch,
 * bank account and documents hang off it. Nothing is live until approval.
 */
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: FilesService,
    private readonly serviceability: ServiceabilityService,
    private readonly permissionChanges: PermissionChanges,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly clock: Clock,
  ) {}

  /** The applicant's restaurant, locked when `tx` is given. */
  private async own(db: Tx | PrismaClient, userId: string, id: string, lock = false) {
    if (lock) await db.$queryRaw`SELECT id FROM restaurants WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await db.restaurant.findFirst({
      where: { id, members: { some: { userId, role: 'OWNER', status: { not: 'REMOVED' } } } },
    });
    if (!r) throw new AppError('NOT_FOUND', { message: "We couldn't find that application." });
    return r;
  }

  /** API-MER-001 */
  async start(
    userId: string,
    input: { brandName: string; legalName: string; entityType: EntityType },
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phoneVerifiedAt: true, email: true, phone: true },
    });
    if (!user.phoneVerifiedAt) throw new AppError('AUTH_VERIFICATION_REQUIRED');
    const existing = await this.prisma.restaurant.findMany({
      where: { members: { some: { userId, role: 'OWNER' } } },
      select: { id: true, onboardingStatus: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const open = existing.find((r) => (OPEN as readonly string[]).includes(r.onboardingStatus));
    if (open)
      throw new AppError('APPLICATION_STATE_CONFLICT', {
        message: 'You already have an application in progress.',
        details: [{ path: 'applicationId', code: 'EXISTING', message: open.id }],
      });
    const rejected = existing.find((r) => r.onboardingStatus === 'REJECTED');
    if (
      rejected &&
      this.clock.now().getTime() - rejected.updatedAt.getTime() < REAPPLY_DAYS * 86_400_000
    )
      throw new AppError('REAPPLY_TOO_SOON', {
        message: `You can apply again ${REAPPLY_DAYS} days after a rejection.`,
      });
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await tx.restaurant.create({
        data: {
          id,
          brandName: input.brandName,
          legalName: input.legalName,
          entityType: input.entityType,
          slug: `draft-${id}`,
          contactEmail: user.email,
          contactPhone: user.phone,
          onboardingStatus: 'DRAFT',
        },
      });
      // The owner membership exists from the start; IAM ignores it until approval.
      await tx.restaurantMember.create({
        data: { restaurantId: id, userId, role: 'OWNER', allBranches: true },
      });
    });
    return this.view(userId, id);
  }

  /** API-MER-003: save any section; only while editable. */
  async update(userId: string, id: string, patch: ApplicationPatch) {
    const released: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const r = await this.own(tx, userId, id, true);
      if (!EDITABLE.has(r.onboardingStatus))
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'This application is being reviewed and can’t be edited now.',
        });
      let logoFileId: string | undefined;
      if (patch.logoFileId) {
        await this.files.claim(tx, {
          fileId: patch.logoFileId,
          userId,
          purposes: ['RESTAURANT_LOGO'],
        });
        logoFileId = patch.logoFileId;
        if (r.logoFileId && r.logoFileId !== logoFileId) released.push(r.logoFileId);
      }
      await tx.restaurant.update({
        where: { id },
        data: {
          ...(patch.brandName !== undefined ? { brandName: patch.brandName } : {}),
          ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
          ...(patch.entityType !== undefined ? { entityType: patch.entityType } : {}),
          ...(patch.pan !== undefined
            ? { panEncrypted: this.cipher.encrypt(patch.pan), panLast4: patch.pan.slice(-4) }
            : {}),
          ...(patch.gstin !== undefined ? { gstin: patch.gstin } : {}),
          ...(patch.fssaiNumber !== undefined ? { fssaiNumber: patch.fssaiNumber } : {}),
          ...(patch.fssaiExpiresOn !== undefined
            ? { fssaiExpiresOn: new Date(`${patch.fssaiExpiresOn}T00:00:00Z`) }
            : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail } : {}),
          ...(patch.contactPhone !== undefined ? { contactPhone: patch.contactPhone } : {}),
          ...(patch.pureVeg !== undefined ? { pureVeg: patch.pureVeg } : {}),
          ...(logoFileId ? { logoFileId } : {}),
        },
      });
      if (patch.cuisineIds) {
        const found = await tx.cuisine.count({
          where: { id: { in: patch.cuisineIds }, isActive: true },
        });
        if (found !== new Set(patch.cuisineIds).size)
          throw new AppError('VALIDATION_ERROR', {
            details: [{ path: 'cuisineIds', code: 'INVALID', message: 'Unknown cuisine.' }],
          });
        await tx.restaurantCuisine.deleteMany({ where: { restaurantId: id } });
        await tx.restaurantCuisine.createMany({
          data: [...new Set(patch.cuisineIds)].map((cuisineId) => ({
            restaurantId: id,
            cuisineId,
          })),
        });
      }
      if (patch.branch) await this.saveBranch(tx, id, patch.branch);
      if (patch.bank) {
        await tx.restaurantBankAccount.updateMany({
          where: { restaurantId: id, status: 'PENDING_VERIFICATION' },
          data: { status: 'SUPERSEDED' },
        });
        await tx.restaurantBankAccount.create({
          data: {
            restaurantId: id,
            holderName: patch.bank.holderName,
            accountNumberEncrypted: this.cipher.encrypt(patch.bank.accountNumber),
            accountLast4: patch.bank.accountNumber.slice(-4),
            ifsc: patch.bank.ifsc,
          },
        });
      }
    });
    for (const f of released) await this.files.release(f);
    return this.view(userId, id);
  }

  /** The first branch (FR-REST-001 step 2); its zone comes from the pin. */
  private async saveBranch(
    tx: Tx,
    restaurantId: string,
    b: NonNullable<ApplicationPatch['branch']>,
  ) {
    const zone = await this.serviceability.zoneAt(b.location);
    if (!zone || zone.status !== 'ACTIVE')
      throw new AppError('ADDRESS_NOT_SERVICEABLE', {
        message: 'We don’t deliver in this area yet, so a restaurant here can’t be listed.',
      });
    const z = await tx.zone.findUniqueOrThrow({
      where: { id: zone.id },
      select: { maxDeliveryRadiusM: true },
    });
    if (b.deliveryRadiusM < MIN_RADIUS_M || b.deliveryRadiusM > z.maxDeliveryRadiusM)
      throw new AppError('VALIDATION_ERROR', {
        details: [
          {
            path: 'branch.deliveryRadiusM',
            code: 'OUT_OF_RANGE',
            message: `Delivery radius must be between ${MIN_RADIUS_M / 1000} and ${z.maxDeliveryRadiusM / 1000} km here.`,
          },
        ],
      });
    const existing = await tx.branch.findFirst({ where: { restaurantId }, select: { id: true } });
    const branchId = existing?.id ?? uuidv7();
    const point = `POINT(${b.location.lng} ${b.location.lat})`;
    if (existing) {
      await tx.$executeRaw`
        UPDATE branches SET zone_id = ${zone.id}::uuid, name = ${b.name}, line1 = ${b.line1}, line2 = ${b.line2 ?? null},
          area = ${b.area}, city = ${b.city}, state = ${b.state}, pincode = ${b.pincode},
          location = ST_GeogFromText(${point}), phone = ${b.phone ?? null}, delivery_radius_m = ${b.deliveryRadiusM},
          default_prep_minutes = ${b.defaultPrepMinutes}, price_for_two = ${b.priceForTwo ?? null}, updated_at = now()
        WHERE id = ${branchId}::uuid`;
    } else {
      await tx.$executeRaw`
        INSERT INTO branches (id, restaurant_id, zone_id, name, line1, line2, area, city, state, pincode, location, phone,
          delivery_radius_m, default_prep_minutes, price_for_two, status, is_open_manual, updated_at)
        VALUES (${branchId}::uuid, ${restaurantId}::uuid, ${zone.id}::uuid, ${b.name}, ${b.line1}, ${b.line2 ?? null},
          ${b.area}, ${b.city}, ${b.state}, ${b.pincode}, ST_GeogFromText(${point}), ${b.phone ?? null},
          ${b.deliveryRadiusM}, ${b.defaultPrepMinutes}, ${b.priceForTwo ?? null}, 'PENDING_APPROVAL', false, now())`;
    }
    await tx.branchOperatingHour.deleteMany({ where: { branchId } });
    await tx.branchOperatingHour.createMany({
      data: b.hours.map((s) => ({
        branchId,
        weekday: s.weekday,
        opensAt: toTime(s.opensAt),
        closesAt: toTime(s.closesAt),
      })),
    });
  }

  /** API-MER-004: one current document per type; replacing releases the old file. */
  async addDocument(
    userId: string,
    id: string,
    input: { type: RestaurantDocumentType; fileId: string; expiresOn?: string | undefined },
  ) {
    const released: string[] = [];
    const doc = await this.prisma.$transaction(async (tx) => {
      const r = await this.own(tx, userId, id, true);
      if (!EDITABLE.has(r.onboardingStatus))
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Documents can’t be changed while the application is under review.',
        });
      await this.files.claim(tx, {
        fileId: input.fileId,
        userId,
        purposes: ['RESTAURANT_DOCUMENT'],
      });
      if (input.type !== 'OTHER') {
        const old = await tx.restaurantDocument.findMany({
          where: { restaurantId: id, type: input.type },
        });
        for (const o of old) {
          await tx.restaurantDocument.delete({ where: { id: o.id } });
          if (o.fileId !== input.fileId) released.push(o.fileId);
        }
      }
      return tx.restaurantDocument.create({
        data: {
          restaurantId: id,
          type: input.type,
          fileId: input.fileId,
          ...(input.expiresOn ? { expiresOn: new Date(`${input.expiresOn}T00:00:00Z`) } : {}),
        },
      });
    });
    for (const f of released) await this.files.release(f);
    return {
      id: doc.id,
      type: doc.type,
      fileId: doc.fileId,
      status: doc.status,
      expiresOn: doc.expiresOn,
    };
  }

  /** API-MER-005 */
  async removeDocument(userId: string, id: string, docId: string) {
    const fileId = await this.prisma.$transaction(async (tx) => {
      const r = await this.own(tx, userId, id, true);
      if (!EDITABLE.has(r.onboardingStatus))
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Documents can’t be changed while the application is under review.',
        });
      const doc = await tx.restaurantDocument.findFirst({ where: { id: docId, restaurantId: id } });
      if (!doc) throw new AppError('NOT_FOUND', { message: "We couldn't find that document." });
      await tx.restaurantDocument.delete({ where: { id: docId } });
      return doc.fileId;
    });
    await this.files.release(fileId);
  }

  /** What's still missing before submit (FR-REST-001 step 5, BR-REST-005). */
  private async missing(db: Tx | PrismaClient, r: Restaurant, declareNoGst: boolean) {
    const [branch, bank, docs, cuisines] = await Promise.all([
      db.branch.findFirst({
        where: { restaurantId: r.id },
        select: { id: true, _count: { select: { operatingHours: true } } },
      }),
      db.restaurantBankAccount.count({
        where: { restaurantId: r.id, status: { in: ['PENDING_VERIFICATION', 'VERIFIED'] } },
      }),
      db.restaurantDocument.findMany({ where: { restaurantId: r.id }, select: { type: true } }),
      db.restaurantCuisine.count({ where: { restaurantId: r.id } }),
    ]);
    const has = new Set(docs.map((d) => d.type));
    const out: { path: string; code: string; message: string }[] = [];
    const need = (ok: unknown, path: string, message: string) => {
      if (!ok) out.push({ path, code: 'MISSING', message });
    };
    need(r.panLast4, 'pan', 'Business PAN');
    need(r.fssaiNumber, 'fssaiNumber', 'FSSAI licence number');
    need(
      r.fssaiExpiresOn && r.fssaiExpiresOn > this.clock.now(),
      'fssaiExpiresOn',
      'A valid (future) FSSAI expiry date',
    );
    need(r.contactEmail && r.contactPhone, 'contact', 'Contact email and phone');
    need(cuisines > 0, 'cuisineIds', 'At least one cuisine');
    need(r.logoFileId, 'logoFileId', 'Logo');
    need(branch, 'branch', 'Outlet address and delivery settings');
    need(branch && branch._count.operatingHours > 0, 'branch.hours', 'Operating hours');
    need(bank, 'bank', 'Bank account');
    for (const t of ['FSSAI', 'PAN', 'BANK_PROOF'])
      need(has.has(t as never), `documents.${t}`, DOC_LABEL[t]!);
    if (r.gstin) need(has.has('GST'), 'documents.GST', DOC_LABEL.GST!);
    else
      need(declareNoGst, 'declareNoGst', 'GSTIN, or a declaration that you are not GST-registered');
    return out;
  }

  /** API-MER-006 */
  async submit(userId: string, id: string, input: { declareNoGst?: boolean | undefined }) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.own(tx, userId, id, true);
      if (!EDITABLE.has(r.onboardingStatus))
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'This application has already been submitted.',
        });
      if (r.submissionCount >= MAX_SUBMISSIONS)
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'This application has been resubmitted too many times. Our team will call you.',
        });
      const missing = await this.missing(tx, r, Boolean(input.declareNoGst));
      if (missing.length > 0) throw new AppError('ONBOARDING_INCOMPLETE', { details: missing });
      // Same FSSAI or GSTIN elsewhere: flagged for the reviewer, not blocked (FR-REST-001).
      const duplicates = await tx.restaurant.findMany({
        where: {
          id: { not: id },
          OR: [{ fssaiNumber: r.fssaiNumber }, ...(r.gstin ? [{ gstin: r.gstin }] : [])],
        },
        select: { id: true, fssaiNumber: true, gstin: true },
      });
      await tx.restaurant.update({
        where: { id },
        data: { onboardingStatus: 'SUBMITTED', submissionCount: { increment: 1 } },
      });
      await writeOutbox(tx, {
        aggregateType: 'restaurant',
        aggregateId: id,
        aggregateVersion: r.submissionCount + 1,
        eventType: 'restaurant.application_submitted',
        payload: {
          restaurantId: id,
          submissionNo: r.submissionCount + 1,
          flags: [
            ...(duplicates.some((d) => d.fssaiNumber === r.fssaiNumber) ? ['DUPLICATE_FSSAI'] : []),
            ...(r.gstin && duplicates.some((d) => d.gstin === r.gstin) ? ['DUPLICATE_GSTIN'] : []),
          ],
          declaredNoGst: !r.gstin,
        },
      });
      await this.audit.record(
        {
          action: 'restaurant.application_submitted',
          targetType: 'restaurant',
          targetId: id,
          actorUserId: userId,
          after: {
            submissionNo: r.submissionCount + 1,
            declaredNoGst: !r.gstin && Boolean(input.declareNoGst),
          },
        },
        tx,
      );
    });
    return this.view(userId, id);
  }

  /**
   * Admin decision (FR-REST-004/005; called by the admin console in Phase 11).
   * Approval activates the restaurant and first branch (not yet open), verifies
   * the documents and bank account, and grants the owner role.
   */
  async decide(
    reviewerId: string,
    id: string,
    input: {
      decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
      comments?: Record<string, string>;
      reason?: string;
    },
  ) {
    const ownerId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM restaurants WHERE id = ${id}::uuid FOR UPDATE`;
      const r = await tx.restaurant.findUniqueOrThrow({ where: { id } });
      if (r.onboardingStatus !== 'SUBMITTED' && r.onboardingStatus !== 'UNDER_REVIEW')
        throw new AppError('APPLICATION_STATE_CONFLICT');
      await tx.restaurantApplicationReview.create({
        data: {
          restaurantId: id,
          submissionNo: r.submissionCount,
          reviewerId,
          decision: input.decision,
          comments: (input.comments ?? {}) as Prisma.InputJsonValue,
        },
      });
      const owner = await tx.restaurantMember.findFirstOrThrow({
        where: { restaurantId: id, role: 'OWNER', status: 'ACTIVE' },
        select: { userId: true },
      });
      if (input.decision === 'APPROVED') {
        await tx.restaurant.update({
          where: { id },
          data: {
            onboardingStatus: 'APPROVED',
            approvedAt: this.clock.now(),
            approvedBy: reviewerId,
            slug: await this.slugFor(tx, r.brandName, id),
          },
        });
        await tx.branch.updateMany({
          where: { restaurantId: id, status: 'PENDING_APPROVAL' },
          data: { status: 'ACTIVE', isOpenManual: false },
        });
        await tx.restaurantDocument.updateMany({
          where: { restaurantId: id, status: 'PENDING' },
          data: { status: 'VERIFIED' },
        });
        await tx.restaurantBankAccount.updateMany({
          where: { restaurantId: id, status: 'PENDING_VERIFICATION' },
          data: { status: 'VERIFIED', verifiedAt: this.clock.now() },
        });
        const role = await tx.role.findUniqueOrThrow({ where: { key: 'RESTAURANT_OWNER' } });
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: owner.userId, roleId: role.id } },
          create: { userId: owner.userId, roleId: role.id, grantedBy: reviewerId },
          update: {},
        });
      } else {
        await tx.restaurant.update({
          where: { id },
          data: {
            onboardingStatus: input.decision,
            ...(input.decision === 'REJECTED' ? { rejectedReason: input.reason ?? null } : {}),
          },
        });
      }
      await writeOutbox(tx, {
        aggregateType: 'restaurant',
        aggregateId: id,
        aggregateVersion: r.submissionCount,
        eventType: `restaurant.application_${input.decision.toLowerCase()}`,
        payload: { restaurantId: id, ownerId: owner.userId, reason: input.reason ?? null },
      });
      return owner.userId;
    });
    // Membership now counts: refresh the owner's permissions everywhere (FR-AUTH-024).
    await this.permissionChanges.changed(ownerId);
  }

  private async slugFor(tx: Tx, brand: string, id: string) {
    const base =
      brand
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .slice(0, 120) || 'restaurant';
    const taken = await tx.restaurant.count({ where: { slug: base, id: { not: id } } });
    return taken ? `${base}-${id.slice(-6)}` : base;
  }

  /** API-MER-002: the application with its checklist and the latest review comments. */
  async view(userId: string, id: string) {
    const r = await this.own(this.prisma, userId, id);
    const [branch, bank, docs, cuisines, reviews] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { restaurantId: id },
        include: { operatingHours: { orderBy: [{ weekday: 'asc' }, { opensAt: 'asc' }] } },
      }),
      this.prisma.restaurantBankAccount.findFirst({
        where: { restaurantId: id, status: { not: 'SUPERSEDED' } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.restaurantDocument.findMany({
        where: { restaurantId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.restaurantCuisine.findMany({
        where: { restaurantId: id },
        select: { cuisine: { select: { id: true, name: true } } },
      }),
      this.prisma.restaurantApplicationReview.findMany({
        where: { restaurantId: id },
        orderBy: { createdAt: 'desc' },
        take: 1,
      }),
    ]);
    const location = branch
      ? (
          await this.prisma.$queryRaw<{ lat: number; lng: number }[]>`
            SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM branches WHERE id = ${branch.id}::uuid`
        )[0]
      : null;
    const logo = r.logoFileId
      ? await this.prisma.file.findUnique({ where: { id: r.logoFileId } })
      : null;
    const editable = EDITABLE.has(r.onboardingStatus);
    return {
      id: r.id,
      status: r.onboardingStatus,
      editable,
      submissionCount: r.submissionCount,
      brandName: r.brandName,
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
      cuisines: cuisines.map((c) => c.cuisine),
      logo: logo ? { fileId: logo.id, urls: this.files.urls(logo) } : null,
      branch: branch
        ? {
            id: branch.id,
            name: branch.name,
            line1: branch.line1,
            line2: branch.line2,
            area: branch.area,
            city: branch.city,
            state: branch.state,
            pincode: branch.pincode,
            location,
            phone: branch.phone,
            deliveryRadiusM: branch.deliveryRadiusM,
            defaultPrepMinutes: branch.defaultPrepMinutes,
            priceForTwo: branch.priceForTwo,
            status: branch.status,
            hours: branch.operatingHours.map((h) => ({
              weekday: h.weekday,
              opensAt: fromTime(h.opensAt),
              closesAt: fromTime(h.closesAt),
            })),
          }
        : null,
      bank: bank
        ? {
            holderName: bank.holderName,
            accountMasked: `XXXXXX${bank.accountLast4}`,
            ifsc: bank.ifsc,
            status: bank.status,
          }
        : null,
      documents: docs.map((d) => ({
        id: d.id,
        type: d.type,
        fileId: d.fileId,
        status: d.status,
        expiresOn: d.expiresOn?.toISOString().slice(0, 10) ?? null,
        reviewerNote: d.reviewerNote,
      })),
      missing: editable ? await this.missing(this.prisma, r, true) : [],
      review: reviews[0]
        ? {
            decision: reviews[0].decision,
            comments: reviews[0].comments,
            at: reviews[0].createdAt,
          }
        : null,
      rejectedReason: r.onboardingStatus === 'REJECTED' ? r.rejectedReason : null,
    };
  }

  /** API-MER-007 (applicant part): applications the user owns. */
  async applications(userId: string) {
    return this.prisma.restaurant.findMany({
      where: {
        members: { some: { userId, role: 'OWNER' } },
        onboardingStatus: { not: 'APPROVED' },
      },
      select: { id: true, brandName: true, onboardingStatus: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
