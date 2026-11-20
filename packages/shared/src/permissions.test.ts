import { describe, expect, it } from 'vitest';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_GRANTS,
  RESTAURANT_PERMISSIONS,
  RESTAURANT_ROLE_GRANTS,
} from './permissions';

describe('permission catalog (ADR-002, SYSTEM-ARCHITECTURE §7.3)', () => {
  it('only grants permissions that exist in the catalog', () => {
    for (const grants of Object.values(PLATFORM_ROLE_GRANTS)) {
      for (const p of grants) expect(PLATFORM_PERMISSIONS).toHaveProperty([p]);
    }
    for (const grants of Object.values(RESTAURANT_ROLE_GRANTS)) {
      for (const p of grants) expect(RESTAURANT_PERMISSIONS).toHaveProperty([p]);
    }
  });

  it('keeps IAM, pricing and commission changes for super admins only', () => {
    for (const p of ['iam:assign', 'pricing:write', 'commission:write', 'pii:export'] as const) {
      expect(PLATFORM_ROLE_GRANTS.SUPER_ADMIN).toContain(p);
      expect(PLATFORM_ROLE_GRANTS.ADMIN).not.toContain(p);
      expect(PLATFORM_ROLE_GRANTS.SUPPORT_AGENT).not.toContain(p);
    }
  });

  it('does not let support agents approve refunds or touch configuration', () => {
    expect(PLATFORM_ROLE_GRANTS.SUPPORT_AGENT).toContain('refund:create');
    expect(PLATFORM_ROLE_GRANTS.SUPPORT_AGENT).not.toContain('refund:approve');
    expect(PLATFORM_ROLE_GRANTS.SUPPORT_AGENT).not.toContain('settings:write');
  });

  it('gives kitchen staff no access to orders, prices or customer data', () => {
    expect(RESTAURANT_ROLE_GRANTS.KITCHEN).not.toContain('rest.order:read');
    expect(RESTAURANT_ROLE_GRANTS.KITCHEN).not.toContain('rest.finance:read');
    expect(RESTAURANT_ROLE_GRANTS.KITCHEN).toContain('rest.kds:view');
  });

  it('reserves legal/bank changes and finance to owners', () => {
    for (const role of ['MANAGER', 'ORDER_MANAGER', 'KITCHEN', 'STAFF'] as const) {
      expect(RESTAURANT_ROLE_GRANTS[role]).not.toContain('rest.restaurant:legal');
      expect(RESTAURANT_ROLE_GRANTS[role]).not.toContain('rest.finance:read');
    }
  });
});
