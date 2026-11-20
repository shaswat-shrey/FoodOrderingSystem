import type { Allergen, DietaryTag, LegalDocumentType, PrismaClient } from '@fos/db';
import type { ClientApp } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';

/** Legal documents each app's users accept (BR-AUTH-020). */
const CONSENT_TYPES: Record<ClientApp, LegalDocumentType[]> = {
  CUSTOMER: ['TERMS', 'PRIVACY', 'REFUND_POLICY'],
  RESTAURANT: ['TERMS', 'PRIVACY', 'RESTAURANT_TERMS'],
  DELIVERY: ['TERMS', 'PRIVACY', 'PARTNER_TERMS'],
  ADMIN: ['TERMS', 'PRIVACY'],
};

/** FR-CUST-001/002/006/007 and consent records (API-USER-013/014). */
export class ProfileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  /** Fields /me adds to the auth summary (FR-CUST-001). Avatars arrive with file uploads. */
  async profileExtras(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { locale: true, createdAt: true },
    });
    return { avatarUrl: null as string | null, locale: user.locale, createdAt: user.createdAt };
  }

  async updateProfile(
    userId: string,
    input: { fullName?: string; locale?: string },
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      },
    });
  }

  async preferences(userId: string) {
    const [profile, tags, allergens] = await Promise.all([
      this.prisma.customerProfile.findUnique({
        where: { userId },
        select: { vegOnlyDefault: true },
      }),
      this.prisma.customerDietaryPreference.findMany({ where: { userId }, select: { tag: true } }),
      this.prisma.customerAllergen.findMany({ where: { userId }, select: { allergen: true } }),
    ]);
    return {
      vegOnlyDefault: profile?.vegOnlyDefault ?? false,
      dietaryTags: tags.map((t) => t.tag).sort(),
      allergens: allergens.map((a) => a.allergen).sort(),
    };
  }

  /** FR-CUST-006: lists replace the stored sets. */
  async updatePreferences(
    userId: string,
    input: { vegOnlyDefault?: boolean; dietaryTags?: DietaryTag[]; allergens?: Allergen[] },
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (input.vegOnlyDefault !== undefined) {
        await tx.customerProfile.upsert({
          where: { userId },
          create: { userId, vegOnlyDefault: input.vegOnlyDefault },
          update: { vegOnlyDefault: input.vegOnlyDefault },
        });
      }
      if (input.dietaryTags) {
        await tx.customerDietaryPreference.deleteMany({ where: { userId } });
        await tx.customerDietaryPreference.createMany({
          data: [...new Set(input.dietaryTags)].map((tag) => ({ userId, tag })),
        });
      }
      if (input.allergens) {
        await tx.customerAllergen.deleteMany({ where: { userId } });
        await tx.customerAllergen.createMany({
          data: [...new Set(input.allergens)].map((allergen) => ({ userId, allergen })),
        });
      }
    });
    return this.preferences(userId);
  }

  /** FR-CUST-007 */
  async accountStatus(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      status: user.status,
      emailVerified: Boolean(user.emailVerifiedAt),
      phoneVerified: Boolean(user.phoneVerifiedAt),
      suspendedUntil: user.suspendedUntil,
      deletionScheduledAt: user.deletionScheduledAt,
    };
  }

  /** API-USER-013: the current version of each document for this app, accepted or pending. */
  async consents(userId: string, app: ClientApp) {
    const docs = await this.latestDocuments(app);
    const accepted = await this.prisma.userConsent.findMany({
      where: { userId, legalDocumentId: { in: docs.map((d) => d.id) } },
      select: { legalDocumentId: true, acceptedAt: true },
    });
    const acceptedAt = new Map(accepted.map((a) => [a.legalDocumentId, a.acceptedAt]));
    return docs.map((d) => ({
      legalDocumentId: d.id,
      type: d.type,
      version: d.version,
      publishedAt: d.publishedAt,
      isMaterial: d.isMaterial,
      acceptedAt: acceptedAt.get(d.id) ?? null,
    }));
  }

  /** API-USER-014: idempotent acceptance of a current document. */
  async acceptConsent(
    userId: string,
    app: ClientApp,
    legalDocumentId: string,
    meta: { ip?: string; userAgent?: string },
  ) {
    const docs = await this.latestDocuments(app);
    if (!docs.some((d) => d.id === legalDocumentId)) {
      throw new AppError('NOT_FOUND', { message: 'That document is not the current version.' });
    }
    const existing = await this.prisma.userConsent.findFirst({
      where: { userId, legalDocumentId },
    });
    if (!existing) {
      await this.prisma.userConsent.create({
        data: {
          userId,
          legalDocumentId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
        },
      });
    }
    return this.consents(userId, app);
  }

  private async latestDocuments(app: ClientApp) {
    const docs = await this.prisma.legalDocument.findMany({
      where: { type: { in: CONSENT_TYPES[app] }, publishedAt: { lte: this.clock.now() } },
      orderBy: { publishedAt: 'desc' },
    });
    const latest = new Map<LegalDocumentType, (typeof docs)[number]>();
    for (const d of docs) if (!latest.has(d.type)) latest.set(d.type, d);
    return [...latest.values()].sort((a, b) => a.type.localeCompare(b.type));
  }
}
