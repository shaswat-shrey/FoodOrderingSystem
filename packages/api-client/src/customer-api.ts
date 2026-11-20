import type {
  CreateAddressBody,
  DiscoveryListQuery,
  SearchQuery,
  UpdateAddressBody,
} from '@fos/validation';
import type { ApiClient } from './client';

/* Response shapes of the Phase 5 customer APIs (SRS §14: API-GEO, ADDR, REST, MENU, DISC, SRCH, FAV, USER). */

export interface LatLng {
  lat: number;
  lng: number;
}
export type DietaryMarker = 'VEG' | 'NON_VEG' | 'EGG';
export type ServiceabilityReason =
  'OUTSIDE_ZONE' | 'OUTSIDE_RADIUS' | 'BRANCH_CLOSED' | 'BRANCH_PAUSED' | 'ZONE_SUSPENDED';

export interface GeoAddress extends LatLng {
  formatted: string;
  line2: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string | null;
}
export interface PlaceSuggestion {
  placeId: string;
  title: string;
  subtitle: string;
  distanceM: number | null;
}
export interface Eta {
  minMinutes: number;
  maxMinutes: number;
}
export interface DeliveryInfo {
  serviceable: boolean;
  reason: ServiceabilityReason | null;
  distanceKm: number;
  eta: Eta;
  deliveryFeeAmount: number;
  surge: { amount: number; reason: string | null };
  minOrderAmount: number;
  maxOrderAmount: number | null;
  smallOrderThresholdAmount: number;
  smallOrderFeeAmount: number;
  platformFeeAmount: number;
}
export interface Serviceability {
  serviceable: boolean;
  reason: ServiceabilityReason | null;
  zone: { id: string; name: string; city: string } | null;
  branch: DeliveryInfo | null;
}
export interface Rating {
  average: number | null;
  count: number;
  isNew: boolean;
}
export interface BranchStatus {
  state: 'OPEN' | 'CLOSING_SOON' | 'CLOSED' | 'PAUSED' | 'UNAVAILABLE';
  acceptingOrders: boolean;
  reason: string | null;
  opensAt: string | null;
  lastOrderAt: string | null;
}
export interface BranchCard {
  branchId: string;
  restaurantId: string;
  restaurantName: string;
  branchName: string;
  slug: string;
  area: string;
  logoUrl: string | null;
  coverUrl: string | null;
  cuisines: string[];
  rating: Rating;
  priceForTwoAmount: number | null;
  pureVeg: boolean;
  status: BranchStatus;
  delivery: Pick<
    DeliveryInfo,
    'serviceable' | 'reason' | 'distanceKm' | 'eta' | 'deliveryFeeAmount' | 'surge'
  > | null;
  bestOffer: string | null;
  isFavorite: boolean;
}
export interface WeeklyHours {
  timezone: string;
  today: { weekday: number; name: string; slots: { opensAt: string; closesAt: string }[] };
  week: { weekday: number; name: string; slots: { opensAt: string; closesAt: string }[] }[];
  upcomingHolidays: { startsAt: string; endsAt: string; reason: string | null }[];
}
export interface BranchPage extends BranchCard {
  description: string | null;
  address: {
    line1: string;
    line2: string | null;
    area: string;
    city: string;
    state: string;
    pincode: string;
  };
  location: LatLng;
  fssaiNumber: string | null;
  minOrderAmount: number;
  maxOrderAmount: number | null;
  hours: WeeklyHours;
  offers: unknown[];
  deliveryDetails: DeliveryInfo | null;
}
export interface ItemCard {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceAmount: number;
  originalPriceAmount: number | null;
  dietaryMarker: DietaryMarker;
  tags: string[];
  spiceLevel: number | null;
  isBestseller: boolean;
  isRecommended: boolean;
  isTodaysSpecial: boolean;
  customizable: boolean;
  available: boolean;
  unavailableReason: 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'BRANCH_CLOSED' | null;
  availableAt: string | null;
}
export interface Menu {
  branchId: string;
  menuVersion: number;
  vegOnly: boolean;
  sections: { key: string; title: string; itemIds: string[] }[];
  categories: { id: string; name: string; description: string | null; items: ItemCard[] }[];
}
export interface ItemDetails extends ItemCard {
  images: string[];
  servingSize: string | null;
  prepMinutes: number | null;
  ingredients: string[];
  allergens: string[];
  allergenWarnings: string[];
  variants: { id: string; name: string; priceAmount: number; isDefault: boolean }[];
  customizationGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    required: boolean;
    variantId: string | null;
    options: {
      id: string;
      name: string;
      priceDeltaAmount: number;
      dietaryMarker: DietaryMarker;
      isDefault: boolean;
      available: boolean;
    }[];
  }[];
}
export interface DishResult {
  item: ItemCard;
  branch: { branchId: string; restaurantName: string; eta: Eta };
}
export interface HomeFeed {
  zone: { id: string; name: string };
  banners: { id: string; title: string; imageUrl: string | null; targetRoute: string }[];
  cuisines: { slug: string; name: string; restaurantCount: number }[];
  sections: (
    | { key: string; title: string; type: 'restaurants'; restaurants: BranchCard[] }
    | { key: string; title: string; type: 'items'; items: DishResult[] }
  )[];
  orderAgain: BranchCard[];
}
export interface SearchResults {
  restaurants: BranchCard[];
  dishes: DishResult[];
  cuisines: { slug: string; name: string; restaurantCount: number }[];
}
export interface Address {
  id: string;
  label: 'HOME' | 'WORK' | 'OTHER';
  customLabel: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  location: LatLng;
  contactName: string;
  contactPhone: string;
  instructions: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  serviceability?: {
    serviceable: boolean;
    reason: ServiceabilityReason | null;
    distanceKm: number | null;
  };
}
export interface Preferences {
  vegOnlyDefault: boolean;
  dietaryTags: string[];
  allergens: string[];
}

type Query = Record<string, string | number | boolean | undefined>;
const withLocation = (point: LatLng, extra: Query = {}) => ({
  lat: point.lat,
  lng: point.lng,
  ...extra,
});
/** Query strings carry comma-separated lists. */
const listQuery = (q: Partial<DiscoveryListQuery>): Query => ({
  ...q,
  cuisines: q.cuisines?.join(','),
});

/** Typed wrappers for the customer app (Phase 5 APIs). */
export function createCustomerApi(client: ApiClient) {
  return {
    geo: {
      autocomplete: (q: string, bias?: LatLng, sessionToken?: string) =>
        client.get<PlaceSuggestion[]>('/geo/autocomplete', { q, ...(bias ?? {}), sessionToken }),
      place: (placeId: string) =>
        client.get<GeoAddress>(`/geo/places/${encodeURIComponent(placeId)}`),
      reverse: (point: LatLng) =>
        client.get<{ address: GeoAddress | null; degraded: boolean }>(
          '/geo/reverse',
          withLocation(point),
        ),
      serviceability: (point: LatLng, branchId?: string) =>
        client.get<Serviceability>('/geo/serviceability', withLocation(point, { branchId })),
    },
    profile: {
      update: (body: { fullName?: string; locale?: string }) => client.patch('/me', body),
      preferences: () => client.get<Preferences>('/me/preferences'),
      updatePreferences: (body: Partial<Preferences>) =>
        client.patch<Preferences>('/me/preferences', body),
    },
    addresses: {
      list: (branchId?: string) => client.get<Address[]>('/me/addresses', { branchId }),
      create: (body: CreateAddressBody) => client.post<Address>('/me/addresses', body),
      update: (id: string, body: UpdateAddressBody) =>
        client.patch<Address>(`/me/addresses/${id}`, body),
      remove: (id: string) => client.delete<null>(`/me/addresses/${id}`),
      setDefault: (id: string) => client.post<Address>(`/me/addresses/${id}/default`),
    },
    discovery: {
      home: (point: LatLng, vegOnly?: boolean) =>
        client.get<HomeFeed>('/discovery/home', withLocation(point, { vegOnly })),
      restaurants: (point: LatLng, q: Partial<Omit<DiscoveryListQuery, 'lat' | 'lng'>> = {}) =>
        client.getPage<BranchCard[]>('/discovery/restaurants', withLocation(point, listQuery(q))),
      collection: (slug: string, point: LatLng, cursor?: string) =>
        client.getPage<{ slug: string; title: string; restaurants: BranchCard[] }>(
          `/discovery/collections/${slug}`,
          withLocation(point, { cursor }),
        ),
      cuisines: (point: LatLng) =>
        client.get<{ slug: string; name: string; restaurantCount: number }[]>(
          '/discovery/cuisines',
          withLocation(point),
        ),
    },
    branches: {
      page: (branchId: string, point?: LatLng) =>
        client.get<BranchPage>(`/branches/${branchId}`, point ? withLocation(point) : {}),
      deliveryInfo: (branchId: string, point: LatLng) =>
        client.get<DeliveryInfo>(`/branches/${branchId}/delivery-info`, withLocation(point)),
      menu: (branchId: string, vegOnly?: boolean) =>
        client.get<Menu>(`/branches/${branchId}/menu`, { vegOnly }),
      item: (branchId: string, itemId: string) =>
        client.get<ItemDetails>(`/branches/${branchId}/menu/items/${itemId}`),
    },
    search: {
      query: (q: SearchQuery) => client.getPage<SearchResults>('/search', q as unknown as Query),
      suggestions: (q: string, point: LatLng) =>
        client.get<
          (
            | { type: 'restaurant'; text: string; branchId: string }
            | { type: 'cuisine'; text: string; slug: string }
            | { type: 'dish'; text: string }
          )[]
        >('/search/suggestions', withLocation(point, { q })),
      history: () =>
        client.get<{ id: string; query: string; createdAt: string }[]>('/me/search-history'),
      clearHistory: () => client.delete<null>('/me/search-history'),
    },
    favorites: {
      restaurants: (point?: LatLng) =>
        client.get<{ restaurantId: string; serviceable: boolean; card: BranchCard | null }[]>(
          '/me/favorites/restaurants',
          point ? withLocation(point) : {},
        ),
      addRestaurant: (restaurantId: string) =>
        client.put<null>(`/me/favorites/restaurants/${restaurantId}`),
      removeRestaurant: (restaurantId: string) =>
        client.delete<null>(`/me/favorites/restaurants/${restaurantId}`),
      addItem: (itemId: string) => client.put<null>(`/me/favorites/items/${itemId}`),
      removeItem: (itemId: string) => client.delete<null>(`/me/favorites/items/${itemId}`),
    },
  };
}

export type CustomerApi = ReturnType<typeof createCustomerApi>;
