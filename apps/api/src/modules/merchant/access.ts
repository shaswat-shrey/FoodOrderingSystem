import type { Response } from 'express';
import type { PrismaClient } from '@fos/db';
import type { RestaurantPermission } from '@fos/shared';
import { AppError } from '../../platform/http/errors';
import { hasRestaurantPermission, type IamService, type ResolvedPermissions } from '../iam';

/**
 * Restaurant-scoped authorization (ADR-002, FR-RSTAFF-002). Permissions are
 * resolved from the database per request (cached by permission version), never
 * from the token. Someone who isn't a member gets 404 — the resource's
 * existence isn't revealed; a member without the permission gets 403.
 */
export class MerchantAccess {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly iam: IamService,
  ) {}

  async permissions(res: Response): Promise<ResolvedPermissions> {
    const auth = res.locals.auth!;
    if (auth.app !== 'RESTAURANT') throw new AppError('AUTH_APP_NOT_PERMITTED');
    return this.iam.resolve(auth.userId, auth.permissionVersion);
  }

  private check(
    perms: ResolvedPermissions,
    permission: RestaurantPermission,
    restaurantId: string,
    branchId?: string,
  ) {
    const member = perms.restaurants.some(
      (g) =>
        g.restaurantId === restaurantId &&
        (branchId === undefined || g.allBranches || g.branchIds.includes(branchId)),
    );
    if (!member) throw new AppError('NOT_FOUND', { message: "We couldn't find that." });
    if (!hasRestaurantPermission(perms, permission, restaurantId, branchId))
      throw new AppError('FORBIDDEN', { message: 'Your role doesn’t allow this.' });
  }

  /** The caller may do `permission` for the restaurant (any branch). */
  async restaurant(res: Response, restaurantId: string, permission: RestaurantPermission) {
    this.check(await this.permissions(res), permission, restaurantId);
    return restaurantId;
  }

  /** The caller may do `permission` at this branch; returns the branch's ids. */
  async branch(res: Response, branchId: string, permission: RestaurantPermission) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { id: true, restaurantId: true },
    });
    if (!branch) throw new AppError('NOT_FOUND', { message: "We couldn't find that branch." });
    this.check(await this.permissions(res), permission, branch.restaurantId, branch.id);
    return branch;
  }

  /** The caller may do `permission` for this order's branch. */
  async order(res: Response, orderId: string, permission: RestaurantPermission) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, restaurantId: true, branchId: true },
    });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    this.check(await this.permissions(res), permission, order.restaurantId, order.branchId);
    return order;
  }

  /** Branch ids the caller can see with `permission` in a restaurant. */
  async branchesIn(res: Response, restaurantId: string, permission: RestaurantPermission) {
    const perms = await this.permissions(res);
    this.check(perms, permission, restaurantId);
    const grant = perms.restaurants.find((g) => g.restaurantId === restaurantId)!;
    if (grant.allBranches) return null; // all
    return grant.branchIds;
  }
}

/**
 * A user's roles or memberships changed: bump the permission version and drop
 * cached session state so the very next request sees it (FR-AUTH-024).
 */
export class PermissionChanges {
  constructor(
    private readonly iam: IamService,
    private readonly sessions: { invalidateUser(userId: string): Promise<void> },
  ) {}

  async changed(userId: string): Promise<void> {
    await this.iam.bumpPermissionVersion(userId);
    await this.sessions.invalidateUser(userId);
  }
}
