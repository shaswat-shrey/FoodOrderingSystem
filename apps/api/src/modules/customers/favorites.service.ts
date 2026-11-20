import type { PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { branchCard, isListed, toCard, type BranchRepository, type MenuService } from '../catalog';
import type { DiscoveryService } from '../discovery';
import type { LatLng } from '../geo';

/** FR-FAV-001…003: idempotent favourites, listed with serviceability at the customer's location. */
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly discovery: DiscoveryService,
    private readonly branches: BranchRepository,
    private readonly menus: MenuService,
    private readonly clock: Clock,
  ) {}

  /** Serviceable branch per restaurant at `point` (empty when the point is outside every zone). */
  private async serviceableHere(point: LatLng | null, userId: string) {
    if (!point)
      return new Map<string, Awaited<ReturnType<DiscoveryService['candidates']>>['list'][number]>();
    try {
      const { list } = await this.discovery.candidates(point, userId);
      return new Map(list.map((c) => [c.entry.restaurantId, c]));
    } catch (error) {
      if (error instanceof AppError && error.code === 'LOCATION_NOT_SERVICEABLE') return new Map();
      throw error;
    }
  }

  /** Any listed branch, for showing a favourite that doesn't deliver here. */
  private async anyBranch(restaurantId: string) {
    const ids = await this.prisma.branch.findMany({
      where: { restaurantId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const loaded = await this.branches.load(
      ids.map((i) => i.id),
      this.clock.now(),
    );
    return [...loaded.values()].find(isListed) ?? null;
  }

  async listRestaurants(userId: string, point: LatLng | null) {
    const favorites = await this.prisma.favoriteRestaurant.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const here = await this.serviceableHere(point, userId);
    const results = [];
    for (const f of favorites) {
      const c = here.get(f.restaurantId);
      if (c) {
        results.push({
          restaurantId: f.restaurantId,
          serviceable: c.info.serviceable,
          card: c.card,
        });
        continue;
      }
      const branch = await this.anyBranch(f.restaurantId);
      results.push({
        restaurantId: f.restaurantId,
        serviceable: false,
        card: branch ? branchCard(branch, { isFavorite: true }) : null, // null: restaurant no longer listed
      });
    }
    return results;
  }

  async addRestaurant(userId: string, restaurantId: string): Promise<void> {
    const listed = await this.prisma.restaurant.count({
      where: { id: restaurantId, onboardingStatus: 'APPROVED', status: 'ACTIVE' },
    });
    if (!listed) throw new AppError('NOT_FOUND', { message: "We couldn't find that restaurant." });
    await this.prisma.favoriteRestaurant.upsert({
      where: { userId_restaurantId: { userId, restaurantId } },
      create: { userId, restaurantId },
      update: {},
    });
  }

  async removeRestaurant(userId: string, restaurantId: string): Promise<void> {
    await this.prisma.favoriteRestaurant.deleteMany({ where: { userId, restaurantId } });
  }

  async listItems(userId: string, point: LatLng | null) {
    const favorites = await this.prisma.favoriteItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        foodItem: {
          select: {
            id: true,
            name: true,
            restaurantId: true,
            deletedAt: true,
            dietaryMarker: true,
          },
        },
      },
    });
    const here = await this.serviceableHere(point, userId);
    const now = this.clock.now();
    const results = [];
    for (const f of favorites) {
      const c = here.get(f.foodItem.restaurantId);
      const raw = c ? await this.menus.raw(c.branch) : null;
      const item = raw?.items.find((i) => i.id === f.foodItemId);
      results.push({
        itemId: f.foodItemId,
        name: f.foodItem.name,
        dietaryMarker: f.foodItem.dietaryMarker,
        restaurantId: f.foodItem.restaurantId,
        // Available to order here and now, or why not (FR-FAV-003).
        serviceable: Boolean(c && item),
        item:
          c && item
            ? toCard(
                item,
                {
                  acceptingOrders: c.branch.computed.acceptingOrders,
                  opensAt: c.branch.computed.opensAt,
                },
                now,
              )
            : null,
        branchId: c?.branch.id ?? null,
      });
    }
    return results;
  }

  async addItem(userId: string, foodItemId: string): Promise<void> {
    const exists = await this.prisma.foodItem.count({
      where: {
        id: foodItemId,
        deletedAt: null,
        isHidden: false,
        restaurant: { onboardingStatus: 'APPROVED', status: 'ACTIVE' },
      },
    });
    if (!exists) throw new AppError('ITEM_NOT_FOUND');
    await this.prisma.favoriteItem.upsert({
      where: { userId_foodItemId: { userId, foodItemId } },
      create: { userId, foodItemId },
      update: {},
    });
  }

  async removeItem(userId: string, foodItemId: string): Promise<void> {
    await this.prisma.favoriteItem.deleteMany({ where: { userId, foodItemId } });
  }
}
