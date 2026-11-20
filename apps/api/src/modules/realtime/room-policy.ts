import type { PrismaClient } from '@fos/db';
import type { PlatformPermission, RestaurantPermission } from '@fos/shared';
import type { RoomAuthorizer, SocketSubject } from '../../platform/realtime/socket-server';
import type { IamService, ResolvedPermissions } from '../iam';
import { ACTIVE_DELIVERY } from '../partners';

/** Order rooms stay open this long after the order ends (FR-RT-011). */
const AFTER_END_MS = 30 * 60_000;
const ENDED = ['DELIVERED', 'CANCELLED', 'REJECTED', 'FAILED'];

/** SRS §13.3: which rooms a socket may join. Unknown and forbidden look the same. */
export class RoomPolicy implements RoomAuthorizer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly iam: IamService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private platform(p: ResolvedPermissions, permission: PlatformPermission) {
    return p.platform.includes(permission);
  }

  private inScope(
    p: ResolvedPermissions,
    branch: { id: string; restaurantId: string },
    permission: RestaurantPermission,
  ) {
    return p.restaurants.some(
      (g) =>
        g.restaurantId === branch.restaurantId &&
        (g.allBranches || g.branchIds.includes(branch.id)) &&
        g.permissions.includes(permission),
    );
  }

  private partnerId(userId: string) {
    return this.prisma.deliveryPartner
      .findUnique({ where: { userId }, select: { id: true, onboardingStatus: true } })
      .then((p) => (p?.onboardingStatus === 'APPROVED' ? p.id : null));
  }

  async autoRooms(s: SocketSubject): Promise<string[]> {
    if (s.app === 'DELIVERY') {
      const partnerId = await this.partnerId(s.userId);
      if (!partnerId) return [];
      const active = await this.prisma.delivery.findFirst({
        where: { partnerId, status: { in: [...ACTIVE_DELIVERY] } },
        select: { id: true },
      });
      return [`partner:${partnerId}`, ...(active ? [`delivery:${active.id}`] : [])];
    }
    if (s.app === 'RESTAURANT') {
      const p = await this.iam.load(s.userId);
      if (!p.restaurants.length) return [];
      const branches = await this.prisma.branch.findMany({
        where: { restaurantId: { in: p.restaurants.map((g) => g.restaurantId) }, deletedAt: null },
        select: { id: true, restaurantId: true },
      });
      return branches
        .filter((b) =>
          p.restaurants.some(
            (g) =>
              g.restaurantId === b.restaurantId && (g.allBranches || g.branchIds.includes(b.id)),
          ),
        )
        .map((b) => `branch:${b.id}:status`);
    }
    return [];
  }

  async authorize(s: SocketSubject, r: { type: string; id?: string }): Promise<string | null> {
    switch (`${s.app}:${r.type}`) {
      case 'CUSTOMER:order': {
        if (!r.id) return null;
        const o = await this.prisma.order.findFirst({
          where: { id: r.id, userId: s.userId },
          select: { status: true, updatedAt: true },
        });
        if (!o) return null;
        if (ENDED.includes(o.status) && this.now().getTime() - o.updatedAt.getTime() > AFTER_END_MS)
          return null;
        return `order:${r.id}`;
      }
      case 'RESTAURANT:branch-orders':
      case 'RESTAURANT:branch-kds': {
        if (!r.id) return null;
        const branch = await this.prisma.branch.findFirst({
          where: { id: r.id, deletedAt: null },
          select: { id: true, restaurantId: true },
        });
        if (!branch) return null;
        const kds = r.type === 'branch-kds';
        const p = await this.iam.load(s.userId);
        if (!this.inScope(p, branch, kds ? 'rest.kds:view' : 'rest.order:read')) return null;
        return `branch:${branch.id}:${kds ? 'kds' : 'orders'}`;
      }
      case 'RESTAURANT:order': {
        if (!r.id) return null;
        const o = await this.prisma.order.findUnique({
          where: { id: r.id },
          select: { branch: { select: { id: true, restaurantId: true } } },
        });
        if (!o) return null;
        const p = await this.iam.load(s.userId);
        return this.inScope(p, o.branch, 'rest.order:read') ? `order:${r.id}` : null;
      }
      case 'DELIVERY:delivery': {
        if (!r.id) return null;
        const partnerId = await this.partnerId(s.userId);
        if (!partnerId) return null;
        const d = await this.prisma.delivery.findFirst({
          where: { id: r.id, partnerId, status: { in: [...ACTIVE_DELIVERY] } },
          select: { id: true },
        });
        return d ? `delivery:${d.id}` : null;
      }
      case 'ADMIN:ops':
        return this.platform(await this.iam.load(s.userId), 'ops:monitor') ? 'admin:ops' : null;
      case 'ADMIN:zone': {
        if (!r.id || !this.platform(await this.iam.load(s.userId), 'ops:monitor')) return null;
        const z = await this.prisma.zone.findFirst({
          where: { id: r.id, deletedAt: null },
          select: { id: true },
        });
        return z ? `admin:zone:${z.id}` : null;
      }
      case 'ADMIN:order': {
        if (!r.id || !this.platform(await this.iam.load(s.userId), 'order:read:any')) return null;
        const o = await this.prisma.order.findUnique({ where: { id: r.id }, select: { id: true } });
        return o ? `order:${o.id}` : null;
      }
      default:
        return null;
    }
  }
}
