import type { PrismaClient } from '@fos/db';
import type { Component, TaxRuleInput } from './engine';

const TTL_MS = 30_000;

/**
 * Effective-dated pricing configuration (FR-CFG-002): the latest version whose
 * `effective_from` ≤ the given time. Versions are never edited in place, so a
 * short cache is safe; quotes record the IDs they used.
 */
export class PricingConfigService {
  private taxCache: { at: number; value: TaxRuleInput[] } | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  /** BR-PRICE-009: one rule per price component. */
  async taxRules(at: Date): Promise<TaxRuleInput[]> {
    if (this.taxCache && Math.abs(this.taxCache.at - at.getTime()) < TTL_MS)
      return this.taxCache.value;
    const rows = await this.prisma.taxRule.findMany({
      where: { effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
    const latest = new Map<string, TaxRuleInput>();
    for (const r of rows) {
      if (!latest.has(r.component)) {
        latest.set(r.component, {
          id: r.id,
          component: r.component as Component,
          taxCode: r.taxCode,
          rateBps: r.rateBps,
          collectedBy: r.collectedBy,
        });
      }
    }
    const value = [...latest.values()].sort((a, b) => a.component.localeCompare(b.component));
    this.taxCache = { at: at.getTime(), value };
    return value;
  }

  /** Commission for a restaurant at a time: its own override, else the platform plan (used at settlement). */
  async commissionRateBps(
    restaurantId: string,
    at: Date,
  ): Promise<{ rateBps: number; source: 'OVERRIDE' | 'PLAN'; id: string }> {
    const override = await this.prisma.restaurantCommissionOverride.findFirst({
      where: { restaurantId, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (override) return { rateBps: override.rateBps, source: 'OVERRIDE', id: override.id };
    const plan = await this.prisma.commissionPlan.findFirst({
      where: { effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!plan) throw new Error('No commission plan in effect');
    return { rateBps: plan.rateBps, source: 'PLAN', id: plan.id };
  }
}
