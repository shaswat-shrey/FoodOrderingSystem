import type { PartnerDocumentType, Prisma, PrismaClient, VehicleType } from '@fos/db';
import type { Clock } from '../../platform/clock';
import type { FieldCipher } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import type { FilesService } from '../files';
import type { PermissionChanges } from '../merchant';

type Tx = Prisma.TransactionClient;

const EDITABLE = new Set(['DRAFT', 'CHANGES_REQUESTED']);
const MOTORIZED = new Set<VehicleType>(['MOTORCYCLE', 'SCOOTER']);
const MAX_SUBMISSIONS = 5;
export const GUIDELINES_VERSION = '1.0'; // FR-DP-007

export interface PartnerPatch {
  legalName?: string | undefined;
  dateOfBirth?: string | undefined;
  homeZoneId?: string | undefined;
  photoFileId?: string | undefined;
  pan?: string | undefined;
  aadhaarLast4?: string | undefined;
  emergencyContact?: { name: string; relation: string; phone: string } | undefined;
  vehicle?: { type: VehicleType; registrationNumber?: string | null | undefined } | undefined;
  license?: { numberLast4: string; expiresOn: string } | undefined;
  bank?: { holderName: string; accountNumber: string; ifsc: string } | undefined;
}

/** Full years between two dates (BR-DEL-016). */
export function ageOn(dob: Date, on: Date): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const m = on.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/** Delivery partner applications and profile (FR-DP-001…007, API-DP-001…013). */
export class PartnerOnboardingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: FilesService,
    private readonly permissionChanges: PermissionChanges,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly clock: Clock,
  ) {}

  private async mine(db: Tx | PrismaClient, userId: string, lock = false) {
    if (lock)
      await db.$queryRaw`SELECT id FROM delivery_partners WHERE user_id = ${userId}::uuid FOR UPDATE`;
    const p = await db.deliveryPartner.findUnique({ where: { userId } });
    if (!p) throw new AppError('NOT_FOUND', { message: 'Start your application first.' });
    return p;
  }

  /** API-DP-001: one application per user. */
  async start(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phoneVerifiedAt: true, fullName: true },
    });
    if (!user.phoneVerifiedAt) throw new AppError('AUTH_VERIFICATION_REQUIRED');
    const existing = await this.prisma.deliveryPartner.findUnique({ where: { userId } });
    if (existing)
      throw new AppError('APPLICATION_STATE_CONFLICT', {
        message: 'You already have an application.',
      });
    await this.prisma.deliveryPartner.create({
      data: { userId, legalName: user.fullName, onboardingStatus: 'DRAFT' },
    });
    return this.view(userId);
  }

  /** API-DP-003 */
  async update(userId: string, patch: PartnerPatch) {
    const released: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const p = await this.mine(tx, userId, true);
      if (!EDITABLE.has(p.onboardingStatus))
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Your application is being reviewed and can’t be edited now.',
        });
      if (patch.homeZoneId) {
        const z = await tx.zone.count({ where: { id: patch.homeZoneId, status: 'ACTIVE' } });
        if (!z)
          throw new AppError('VALIDATION_ERROR', {
            details: [{ path: 'homeZoneId', code: 'INVALID', message: 'Pick an active zone.' }],
          });
      }
      if (patch.photoFileId) {
        await this.files.claim(tx, {
          fileId: patch.photoFileId,
          userId,
          purposes: ['PARTNER_PHOTO'],
        });
        if (p.photoFileId && p.photoFileId !== patch.photoFileId) released.push(p.photoFileId);
      }
      await tx.deliveryPartner.update({
        where: { id: p.id },
        data: {
          ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
          ...(patch.dateOfBirth !== undefined
            ? { dateOfBirth: new Date(`${patch.dateOfBirth}T00:00:00Z`) }
            : {}),
          ...(patch.homeZoneId !== undefined ? { homeZoneId: patch.homeZoneId } : {}),
          ...(patch.photoFileId !== undefined ? { photoFileId: patch.photoFileId } : {}),
          ...(patch.pan !== undefined
            ? { panEncrypted: this.cipher.encrypt(patch.pan), panLast4: patch.pan.slice(-4) }
            : {}),
          ...(patch.aadhaarLast4 !== undefined ? { aadhaarLast4: patch.aadhaarLast4 } : {}),
          ...(patch.emergencyContact
            ? {
                emergencyContactName: patch.emergencyContact.name,
                emergencyContactRelation: patch.emergencyContact.relation,
                emergencyContactPhone: patch.emergencyContact.phone,
              }
            : {}),
        },
      });
      if (patch.vehicle) {
        if (MOTORIZED.has(patch.vehicle.type) && !patch.vehicle.registrationNumber)
          throw new AppError('VALIDATION_ERROR', {
            details: [
              {
                path: 'vehicle.registrationNumber',
                code: 'REQUIRED',
                message: 'Enter the registration number.',
              },
            ],
          });
        await tx.partnerVehicle.updateMany({
          where: { partnerId: p.id, deletedAt: null },
          data: { deletedAt: this.clock.now(), isActive: false },
        });
        await tx.partnerVehicle.create({
          data: {
            partnerId: p.id,
            type: patch.vehicle.type,
            registrationNumber: patch.vehicle.registrationNumber ?? null,
            isActive: true,
          },
        });
      }
      if (patch.license) {
        // DL number and expiry ride on the DL_FRONT document row; stored when the document is attached.
        await tx.partnerDocument.updateMany({
          where: { partnerId: p.id, type: 'DL_FRONT' },
          data: {
            numberLast4: patch.license.numberLast4,
            expiresOn: new Date(`${patch.license.expiresOn}T00:00:00Z`),
          },
        });
      }
      if (patch.bank) {
        await tx.partnerBankAccount.updateMany({
          where: { partnerId: p.id, status: 'PENDING_VERIFICATION' },
          data: { status: 'SUPERSEDED' },
        });
        await tx.partnerBankAccount.create({
          data: {
            partnerId: p.id,
            holderName: patch.bank.holderName,
            accountNumberEncrypted: this.cipher.encrypt(patch.bank.accountNumber),
            accountLast4: patch.bank.accountNumber.slice(-4),
            ifsc: patch.bank.ifsc,
          },
        });
      }
    });
    for (const f of released) await this.files.release(f);
    return this.view(userId);
  }

  /** API-DP-004 */
  async addDocument(
    userId: string,
    input: {
      type: PartnerDocumentType;
      fileId: string;
      numberLast4?: string | undefined;
      expiresOn?: string | undefined;
    },
  ) {
    const released: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const p = await this.mine(tx, userId, true);
      if (!EDITABLE.has(p.onboardingStatus) && p.onboardingStatus !== 'APPROVED')
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Documents can’t be changed during review.',
        });
      await this.files.claim(tx, {
        fileId: input.fileId,
        userId,
        purposes: ['PARTNER_DOCUMENT', 'PARTNER_PHOTO'],
      });
      const old = await tx.partnerDocument.findMany({
        where: { partnerId: p.id, type: input.type },
      });
      for (const o of old) {
        await tx.partnerDocument.delete({ where: { id: o.id } });
        if (o.fileId !== input.fileId) released.push(o.fileId);
      }
      await tx.partnerDocument.create({
        data: {
          partnerId: p.id,
          type: input.type,
          fileId: input.fileId,
          numberLast4: input.numberLast4 ?? null,
          ...(input.expiresOn ? { expiresOn: new Date(`${input.expiresOn}T00:00:00Z`) } : {}),
        },
      });
    });
    for (const f of released) await this.files.release(f);
    return this.view(userId);
  }

  /** API-DP-005 */
  async removeDocument(userId: string, docId: string) {
    const fileId = await this.prisma.$transaction(async (tx) => {
      const p = await this.mine(tx, userId, true);
      if (!EDITABLE.has(p.onboardingStatus)) throw new AppError('APPLICATION_STATE_CONFLICT');
      const d = await tx.partnerDocument.findFirst({ where: { id: docId, partnerId: p.id } });
      if (!d) throw new AppError('NOT_FOUND', { message: "We couldn't find that document." });
      await tx.partnerDocument.delete({ where: { id: docId } });
      return d.fileId;
    });
    await this.files.release(fileId);
    return this.view(userId);
  }

  private async missing(db: Tx | PrismaClient, partnerId: string) {
    const p = await db.deliveryPartner.findUniqueOrThrow({
      where: { id: partnerId },
      include: {
        documents: { select: { type: true, expiresOn: true } },
        vehicles: { where: { deletedAt: null, isActive: true } },
        bankAccounts: { where: { status: { in: ['PENDING_VERIFICATION', 'VERIFIED'] } } },
      },
    });
    const out: { path: string; code: string; message: string }[] = [];
    const need = (ok: unknown, path: string, message: string) => {
      if (!ok) out.push({ path, code: 'MISSING', message });
    };
    const has = new Set(p.documents.map((d) => d.type));
    need(p.legalName, 'legalName', 'Full legal name');
    need(p.dateOfBirth, 'dateOfBirth', 'Date of birth');
    need(p.homeZoneId, 'homeZoneId', 'Preferred zone');
    need(p.photoFileId, 'photoFileId', 'Profile photo');
    need(p.panLast4, 'pan', 'PAN');
    need(p.aadhaarLast4, 'aadhaarLast4', 'Last 4 digits of Aadhaar');
    need(p.emergencyContactPhone, 'emergencyContact', 'Emergency contact');
    need(p.vehicles[0], 'vehicle', 'Vehicle');
    need(p.bankAccounts[0], 'bank', 'Bank account');
    for (const t of ['PAN', 'ID_PROOF', 'BANK_PROOF'] as const)
      need(has.has(t), `documents.${t}`, `${t.replace('_', ' ')} document`);
    if (p.vehicles[0] && MOTORIZED.has(p.vehicles[0].type)) {
      // BR-DEL-016: motorized vehicles need DL, RC and insurance.
      for (const t of ['DL_FRONT', 'DL_BACK', 'RC', 'INSURANCE'] as const)
        need(has.has(t), `documents.${t}`, `${t.replace('_', ' ')} document`);
      const dl = p.documents.find((d) => d.type === 'DL_FRONT');
      if (dl)
        need(
          dl.expiresOn && dl.expiresOn > this.clock.now(),
          'license.expiresOn',
          'A valid driving licence expiry date',
        );
    }
    return { out, dob: p.dateOfBirth };
  }

  /** API-DP-006 */
  async submit(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.mine(tx, userId, true);
      if (!EDITABLE.has(p.onboardingStatus))
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Your application has already been submitted.',
        });
      if (p.submissionCount >= MAX_SUBMISSIONS)
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Too many resubmissions. Our team will call you.',
        });
      const { out, dob } = await this.missing(tx, p.id);
      if (out.length) throw new AppError('ONBOARDING_INCOMPLETE', { details: out });
      if (dob && ageOn(dob, this.clock.now()) < 18) throw new AppError('AGE_REQUIREMENT_NOT_MET');
      await tx.deliveryPartner.update({
        where: { id: p.id },
        data: { onboardingStatus: 'SUBMITTED', submissionCount: { increment: 1 } },
      });
      await writeOutbox(tx, {
        aggregateType: 'partner',
        aggregateId: p.id,
        aggregateVersion: p.submissionCount + 1,
        eventType: 'partner.application_submitted',
        payload: { partnerId: p.id, submissionNo: p.submissionCount + 1 },
      });
    });
    return this.view(userId);
  }

  /** Admin decision (FR-DP-003; console in Phase 11). Approval grants DELIVERY_PARTNER. */
  async decide(
    reviewerId: string,
    partnerId: string,
    input: {
      decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
      reason?: string;
      /** Document type → what to fix (shown on the document). */
      documentNotes?: Partial<Record<PartnerDocumentType, string>>;
    },
    meta: { sessionId?: string | null; actorRoles?: string[] } = {},
  ) {
    const userId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM delivery_partners WHERE id = ${partnerId}::uuid FOR UPDATE`;
      const p = await tx.deliveryPartner.findUniqueOrThrow({ where: { id: partnerId } });
      if (p.onboardingStatus !== 'SUBMITTED' && p.onboardingStatus !== 'UNDER_REVIEW')
        throw new AppError('APPLICATION_STATE_CONFLICT');
      if (input.decision === 'APPROVED') {
        await tx.deliveryPartner.update({
          where: { id: partnerId },
          data: { onboardingStatus: 'APPROVED', approvedAt: this.clock.now(), status: 'ACTIVE' },
        });
        await tx.partnerDocument.updateMany({
          where: { partnerId, status: 'PENDING' },
          data: { status: 'VERIFIED' },
        });
        await tx.partnerVehicle.updateMany({
          where: { partnerId, deletedAt: null },
          data: { status: 'VERIFIED' },
        });
        await tx.partnerBankAccount.updateMany({
          where: { partnerId, status: 'PENDING_VERIFICATION' },
          data: { status: 'VERIFIED', verifiedAt: this.clock.now() },
        });
        await tx.partnerStats.upsert({ where: { partnerId }, create: { partnerId }, update: {} });
        const role = await tx.role.findUniqueOrThrow({ where: { key: 'DELIVERY_PARTNER' } });
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: p.userId, roleId: role.id } },
          create: { userId: p.userId, roleId: role.id, grantedBy: reviewerId },
          update: {},
        });
      } else {
        await tx.deliveryPartner.update({
          where: { id: partnerId },
          data: {
            onboardingStatus: input.decision,
            // The applicant sees why (rejected) or what to change (changes requested).
            rejectedReason: input.reason ?? null,
          },
        });
        for (const [type, note] of Object.entries(input.documentNotes ?? {}))
          await tx.partnerDocument.updateMany({
            where: { partnerId, type: type as PartnerDocumentType },
            data: { reviewerNote: note },
          });
      }
      await writeOutbox(tx, {
        aggregateType: 'partner',
        aggregateId: partnerId,
        aggregateVersion: p.submissionCount,
        eventType: `partner.application_${input.decision.toLowerCase()}`,
        payload: { partnerId, userId: p.userId },
      });
      await this.audit.record(
        {
          action: 'partner.application_decided',
          targetType: 'partner',
          targetId: partnerId,
          actorUserId: reviewerId,
          actorRoles: meta.actorRoles ?? [],
          sessionId: meta.sessionId ?? null,
          reason: input.reason ?? null,
          before: { status: p.onboardingStatus },
          after: { decision: input.decision },
          // ★ approve/reject (API-ADM-043/044); change requests are routine.
          sensitivity: input.decision === 'CHANGES_REQUESTED' ? 'NORMAL' : 'HIGH',
        },
        tx,
      );
      return p.userId;
    });
    await this.permissionChanges.changed(userId);
  }

  /** API-DP-002 / API-DP-007 */
  async view(userId: string) {
    const p = await this.prisma.deliveryPartner.findUnique({
      where: { userId },
      include: {
        documents: { orderBy: { createdAt: 'asc' } },
        vehicles: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        bankAccounts: {
          where: { status: { not: 'SUPERSEDED' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        homeZone: { select: { id: true, name: true } },
        photoFile: true,
      },
    });
    if (!p) return null;
    const editable = EDITABLE.has(p.onboardingStatus);
    return {
      id: p.id,
      status: p.onboardingStatus,
      accountStatus: p.status,
      editable,
      legalName: p.legalName,
      dateOfBirth: p.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      homeZone: p.homeZone,
      photoFileId: p.photoFileId,
      panMasked: p.panLast4 ? `XXXXXX${p.panLast4}` : null,
      aadhaarMasked: p.aadhaarLast4 ? `XXXX XXXX ${p.aadhaarLast4}` : null,
      emergencyContact: p.emergencyContactPhone
        ? {
            name: p.emergencyContactName,
            relation: p.emergencyContactRelation,
            phone: p.emergencyContactPhone,
          }
        : null,
      vehicles: p.vehicles.map((v) => ({
        id: v.id,
        type: v.type,
        registrationNumber: v.registrationNumber,
        status: v.status,
        isActive: v.isActive,
      })),
      documents: p.documents.map((d) => ({
        id: d.id,
        type: d.type,
        status: d.status,
        expiresOn: d.expiresOn?.toISOString().slice(0, 10) ?? null,
        reviewerNote: d.reviewerNote,
      })),
      bank: p.bankAccounts[0]
        ? {
            holderName: p.bankAccounts[0].holderName,
            accountMasked: `XXXXXX${p.bankAccounts[0].accountLast4}`,
            ifsc: p.bankAccounts[0].ifsc,
            status: p.bankAccounts[0].status,
          }
        : null,
      guidelines: { required: GUIDELINES_VERSION, acknowledged: p.guidelinesVersionAck },
      missing: editable ? (await this.missing(this.prisma, p.id)).out : [],
      rejectedReason: p.onboardingStatus === 'REJECTED' ? p.rejectedReason : null,
      changesRequested: p.onboardingStatus === 'CHANGES_REQUESTED' ? p.rejectedReason : null,
    };
  }

  /** API-ADM-054 (FR-DP-005): a reviewer verifies or rejects a vehicle. */
  async verifyVehicle(
    reviewerId: string,
    vehicleId: string,
    input: { decision: 'VERIFIED' | 'REJECTED'; reason: string },
    meta: { sessionId?: string | null; actorRoles?: string[] } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.partnerVehicle.findFirst({ where: { id: vehicleId, deletedAt: null } });
      if (!v) throw new AppError('NOT_FOUND', { message: "We couldn't find that vehicle." });
      if (input.decision === 'REJECTED' && v.isActive)
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'This is the partner’s active vehicle. Ask them to switch vehicles first.',
        });
      const updated = await tx.partnerVehicle.update({
        where: { id: vehicleId },
        data: { status: input.decision },
      });
      await this.audit.record(
        {
          action: 'partner.vehicle_verified',
          targetType: 'partner_vehicle',
          targetId: vehicleId,
          actorUserId: reviewerId,
          actorRoles: meta.actorRoles ?? [],
          sessionId: meta.sessionId ?? null,
          reason: input.reason,
          before: { status: v.status },
          after: { status: input.decision, partnerId: v.partnerId },
          sensitivity: 'HIGH',
        },
        tx,
      );
      return {
        id: updated.id,
        partnerId: updated.partnerId,
        type: updated.type,
        registrationNumber: updated.registrationNumber,
        status: updated.status,
        isActive: updated.isActive,
      };
    });
  }

  /** API-DP-008: editable after approval — emergency contact and preferred zone; legal fields are locked. */
  async updateProfile(
    userId: string,
    patch: Pick<PartnerPatch, 'emergencyContact' | 'homeZoneId'>,
  ) {
    const p = await this.mine(this.prisma, userId);
    if (p.onboardingStatus !== 'APPROVED') return this.update(userId, patch);
    if (
      patch.homeZoneId &&
      !(await this.prisma.zone.count({ where: { id: patch.homeZoneId, status: 'ACTIVE' } }))
    )
      throw new AppError('VALIDATION_ERROR', {
        details: [{ path: 'homeZoneId', code: 'INVALID', message: 'Pick an active zone.' }],
      });
    await this.prisma.deliveryPartner.update({
      where: { id: p.id },
      data: {
        ...(patch.homeZoneId ? { homeZoneId: patch.homeZoneId } : {}),
        ...(patch.emergencyContact
          ? {
              emergencyContactName: patch.emergencyContact.name,
              emergencyContactRelation: patch.emergencyContact.relation,
              emergencyContactPhone: patch.emergencyContact.phone,
            }
          : {}),
      },
    });
    return this.view(userId);
  }

  /** API-DP-010: new vehicles start unverified. */
  async addVehicle(
    userId: string,
    input: { type: VehicleType; registrationNumber?: string | null | undefined },
  ) {
    const p = await this.mine(this.prisma, userId);
    if (MOTORIZED.has(input.type) && !input.registrationNumber)
      throw new AppError('VALIDATION_ERROR', {
        details: [
          {
            path: 'registrationNumber',
            code: 'REQUIRED',
            message: 'Enter the registration number.',
          },
        ],
      });
    await this.prisma.partnerVehicle.create({
      data: {
        partnerId: p.id,
        type: input.type,
        registrationNumber: input.registrationNumber ?? null,
      },
    });
    return this.view(userId);
  }

  /** API-DP-012 (FR-DP-005): a motorized vehicle needs verified DL and RC; never while on a delivery. */
  async activateVehicle(userId: string, vehicleId: string) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.mine(tx, userId, true);
      const v = await tx.partnerVehicle.findFirst({
        where: { id: vehicleId, partnerId: p.id, deletedAt: null },
      });
      if (!v) throw new AppError('NOT_FOUND', { message: "We couldn't find that vehicle." });
      if (p.availabilityState !== 'OFFLINE')
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'Go offline before changing vehicles.',
        });
      if (v.status !== 'VERIFIED')
        throw new AppError('APPLICATION_STATE_CONFLICT', {
          message: 'This vehicle is waiting for verification.',
        });
      if (MOTORIZED.has(v.type)) {
        const docs = await tx.partnerDocument.findMany({
          where: { partnerId: p.id, type: { in: ['DL_FRONT', 'RC'] }, status: 'VERIFIED' },
        });
        if (new Set(docs.map((d) => d.type)).size < 2)
          throw new AppError('APPLICATION_STATE_CONFLICT', {
            message: 'A verified driving licence and RC are needed for this vehicle.',
          });
      }
      await tx.partnerVehicle.updateMany({ where: { partnerId: p.id }, data: { isActive: false } });
      await tx.partnerVehicle.update({ where: { id: vehicleId }, data: { isActive: true } });
    });
    return this.view(userId);
  }

  /** API-DP-013 (FR-DP-007) */
  async acknowledgeGuidelines(userId: string, version: string) {
    if (version !== GUIDELINES_VERSION)
      throw new AppError('VALIDATION_ERROR', { message: 'Please read the latest guidelines.' });
    const p = await this.mine(this.prisma, userId);
    await this.prisma.deliveryPartner.update({
      where: { id: p.id },
      data: { guidelinesVersionAck: version },
    });
    return this.view(userId);
  }
}
