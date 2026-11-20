import type { PrismaClient } from '@fos/db';
import type { Redis } from 'ioredis';
import type { PlatformPermission, RestaurantRoleName } from '@fos/shared';
import type { Logger } from '../../platform/logger';
import { grantsFor, type ResolvedPermissions } from './policies';

const CACHE_TTL_SECONDS = 600;

/**
 * Resolves a user's effective permissions from the database (never from the
 * token). Cached per permission version, so any role or membership change —
 * which bumps users.permission_version — is visible immediately (FR-AUTH-024).
 */
export class IamService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache: Redis,
    private readonly logger: Logger,
  ) {}

  async resolve(userId: string, permissionVersion: number): Promise<ResolvedPermissions> {
    const key = `perm:${userId}:${permissionVersion}`;
    try {
      const cached = await this.cache.get(key);
      if (cached) return JSON.parse(cached) as ResolvedPermissions;
    } catch (error) {
      this.logger.debug({ err: error }, 'permission cache unavailable');
    }
    const resolved = await this.load(userId);
    this.cache.set(key, JSON.stringify(resolved), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return resolved;
  }

  async load(userId: string): Promise<ResolvedPermissions> {
    const [roles, memberships] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId },
        select: {
          role: {
            select: {
              key: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      }),
      this.prisma.restaurantMember.findMany({
        where: { userId, status: 'ACTIVE', restaurant: { status: 'ACTIVE' } },
        select: {
          restaurantId: true,
          role: true,
          allBranches: true,
          branches: { select: { branchId: true } },
        },
      }),
    ]);
    const platform = new Set<PlatformPermission>();
    for (const r of roles)
      for (const p of r.role.permissions) platform.add(p.permission.key as PlatformPermission);
    return {
      platformRoles: roles.map((r) => r.role.key).sort(),
      platform: [...platform].sort(),
      restaurants: memberships.map((m) => ({
        restaurantId: m.restaurantId,
        role: m.role as RestaurantRoleName,
        allBranches: m.allBranches,
        branchIds: m.branches.map((b) => b.branchId),
        permissions: grantsFor(m.role as RestaurantRoleName),
      })),
    };
  }

  /** Invalidates cached permissions and outstanding tokens' permission claims (FR-AUTH-024). */
  async bumpPermissionVersion(userId: string): Promise<number> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { permissionVersion: { increment: 1 } },
      select: { permissionVersion: true },
    });
    return user.permissionVersion;
  }
}
