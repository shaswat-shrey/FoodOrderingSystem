import { describe, expect, it } from 'vitest';
import {
  appScopeFor,
  grantsFor,
  hasRestaurantPermission,
  type ResolvedPermissions,
} from './policies';

const none: ResolvedPermissions = { platformRoles: [], platform: [], restaurants: [] };
const kitchen: ResolvedPermissions = {
  platformRoles: [],
  platform: [],
  restaurants: [
    {
      restaurantId: 'r1',
      role: 'KITCHEN',
      allBranches: false,
      branchIds: ['b1'],
      permissions: grantsFor('KITCHEN'),
    },
  ],
};

describe('appScopeFor (BR-AUTH-010)', () => {
  it('requires CUSTOMER for the customer app and staff roles for the admin app', () => {
    expect(appScopeFor('CUSTOMER', none)).toBeNull();
    expect(appScopeFor('CUSTOMER', { ...none, platformRoles: ['CUSTOMER'] })).toBe('FULL');
    expect(appScopeFor('ADMIN', { ...none, platformRoles: ['CUSTOMER'] })).toBeNull();
    expect(appScopeFor('ADMIN', { ...none, platformRoles: ['SUPPORT_AGENT'] })).toBe('FULL');
  });

  it('gives applicants onboarding-only scope in the restaurant and delivery apps', () => {
    expect(appScopeFor('RESTAURANT', none)).toBe('ONBOARDING');
    expect(appScopeFor('RESTAURANT', kitchen)).toBe('FULL');
    expect(appScopeFor('DELIVERY', none)).toBe('ONBOARDING');
    expect(appScopeFor('DELIVERY', { ...none, platformRoles: ['DELIVERY_PARTNER'] })).toBe('FULL');
  });
});

describe('hasRestaurantPermission (ADR-002, AC-RBAC-003/004)', () => {
  it('scopes members to their restaurant and branches', () => {
    expect(hasRestaurantPermission(kitchen, 'rest.kds:view', 'r1', 'b1')).toBe(true);
    expect(hasRestaurantPermission(kitchen, 'rest.kds:view', 'r1', 'b2')).toBe(false);
    expect(hasRestaurantPermission(kitchen, 'rest.kds:view', 'r2', 'b1')).toBe(false);
  });

  it('denies kitchen staff order details and finance', () => {
    expect(hasRestaurantPermission(kitchen, 'rest.order:read', 'r1', 'b1')).toBe(false);
    expect(hasRestaurantPermission(kitchen, 'rest.finance:read', 'r1')).toBe(false);
  });
});
