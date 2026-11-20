import {
  RESTAURANT_ROLE_GRANTS,
  type ClientApp,
  type PlatformPermission,
  type RestaurantPermission,
  type RestaurantRoleName,
} from '@fos/shared';

export interface RestaurantGrant {
  restaurantId: string;
  role: RestaurantRoleName;
  allBranches: boolean;
  branchIds: string[];
  permissions: RestaurantPermission[];
}

export interface ResolvedPermissions {
  platformRoles: string[];
  platform: PlatformPermission[];
  restaurants: RestaurantGrant[];
}

export type AppScope = 'FULL' | 'ONBOARDING';

const ADMIN_APP_ROLES = ['SUPPORT_AGENT', 'ADMIN', 'SUPER_ADMIN'];

/**
 * Which session scope a user gets in an app (BR-AUTH-010). `null` = not allowed.
 * Restaurant and delivery applicants may sign in with ONBOARDING scope so they
 * can complete their application before any role is granted (FR-AUTH-001).
 */
export function appScopeFor(app: ClientApp, perms: ResolvedPermissions): AppScope | null {
  const roles = perms.platformRoles;
  switch (app) {
    case 'CUSTOMER':
      return roles.includes('CUSTOMER') ? 'FULL' : null;
    case 'RESTAURANT':
      return perms.restaurants.length > 0 ? 'FULL' : 'ONBOARDING';
    case 'DELIVERY':
      return roles.includes('DELIVERY_PARTNER') ? 'FULL' : 'ONBOARDING';
    case 'ADMIN':
      return roles.some((r) => ADMIN_APP_ROLES.includes(r)) ? 'FULL' : null;
  }
}

export function grantsFor(role: RestaurantRoleName): RestaurantPermission[] {
  return [...RESTAURANT_ROLE_GRANTS[role]];
}

/** Restaurant-scoped check: member of the restaurant, branch in scope, permission granted (ADR-002). */
export function hasRestaurantPermission(
  perms: ResolvedPermissions,
  permission: RestaurantPermission,
  restaurantId: string,
  branchId?: string,
): boolean {
  return perms.restaurants.some(
    (g) =>
      g.restaurantId === restaurantId &&
      g.permissions.includes(permission) &&
      (branchId === undefined || g.allBranches || g.branchIds.includes(branchId)),
  );
}
