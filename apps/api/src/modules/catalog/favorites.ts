import type { PrismaClient } from '@fos/db';

/** Which of these restaurants the user has favourited (FR-DISC-001 `isFavorite`). */
export async function favoriteRestaurantIds(
  prisma: PrismaClient,
  userId: string,
  restaurantIds: string[],
): Promise<Set<string>> {
  if (restaurantIds.length === 0) return new Set();
  const rows = await prisma.favoriteRestaurant.findMany({
    where: { userId, restaurantId: { in: restaurantIds } },
    select: { restaurantId: true },
  });
  return new Set(rows.map((r) => r.restaurantId));
}
