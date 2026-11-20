/**
 * Deterministic development seed for the pilot city (Bengaluru).
 * All people, phone numbers and restaurants are fictional. Phone numbers use
 * the +91 90000 00xxx block and emails use example.com (RFC 2606).
 * Amounts are paise. Values for fees/taxes/commission are the approved
 * defaults from SRS §18 (tax rates are placeholders pending legal review).
 */

export type LngLat = readonly [lng: number, lat: number];

export const ZONES = [
  {
    key: 'blr-south',
    name: 'Bengaluru South (Koramangala–HSR)',
    city: 'Bengaluru',
    // Closed ring, lng/lat. Shares its northern edge with blr-east.
    ring: [
      [77.6, 12.9],
      [77.66, 12.9],
      [77.66, 12.95],
      [77.6, 12.95],
      [77.6, 12.9],
    ] as LngLat[],
  },
  {
    key: 'blr-east',
    name: 'Bengaluru East (Indiranagar)',
    city: 'Bengaluru',
    ring: [
      [77.62, 12.95],
      [77.67, 12.95],
      [77.67, 13.0],
      [77.62, 13.0],
      [77.62, 12.95],
    ] as LngLat[],
  },
] as const;

export type ZoneKey = (typeof ZONES)[number]['key'];

export const CUISINES = [
  ['biryani', 'Biryani'],
  ['north-indian', 'North Indian'],
  ['south-indian', 'South Indian'],
  ['chinese', 'Chinese'],
  ['pizza', 'Pizza'],
  ['italian', 'Italian'],
  ['desserts', 'Desserts'],
  ['bakery', 'Bakery'],
  ['healthy', 'Healthy'],
  ['salads', 'Salads'],
  ['beverages', 'Beverages'],
  ['snacks', 'Snacks'],
] as const;

export const STAFF_USERS = [
  { key: 'superadmin', fullName: 'Meera Iyer', phone: '+919000000001', email: 'superadmin@example.com', roles: ['SUPER_ADMIN'] },
  { key: 'admin', fullName: 'Arjun Nair', phone: '+919000000002', email: 'admin@example.com', roles: ['ADMIN'] },
  { key: 'support', fullName: 'Kavya Reddy', phone: '+919000000003', email: 'support@example.com', roles: ['SUPPORT_AGENT'] },
] as const;

export const CUSTOMERS = [
  {
    key: 'asha',
    fullName: 'Asha Rao',
    phone: '+919000000101',
    email: 'asha@example.com',
    vegOnly: false,
    addresses: [
      { label: 'HOME', line1: 'Flat 302, Lakeview Residency', line2: '5th Cross, 6th Block', area: 'Koramangala', pincode: '560095', at: [77.6245, 12.9352] as LngLat, isDefault: true },
      { label: 'WORK', line1: 'Floor 4, Orbit Tech Park', line2: '100 Feet Road', area: 'Indiranagar', pincode: '560038', at: [77.6412, 12.9719] as LngLat, isDefault: false },
    ],
  },
  {
    key: 'rahul',
    fullName: 'Rahul Verma',
    phone: '+919000000102',
    email: 'rahul@example.com',
    vegOnly: true,
    addresses: [
      { label: 'HOME', line1: 'House 18, 2nd Main', line2: 'Sector 2', area: 'HSR Layout', pincode: '560102', at: [77.6387, 12.9116] as LngLat, isDefault: true },
    ],
  },
] as const;

type Marker = 'VEG' | 'NON_VEG' | 'EGG';
type Tag = 'VEGAN' | 'JAIN' | 'GLUTEN_FREE' | 'DAIRY_FREE' | 'SPICY' | 'KETO' | 'HIGH_PROTEIN';
type AllergenName = 'GLUTEN' | 'EGGS' | 'FISH' | 'PEANUTS' | 'SOY' | 'MILK' | 'TREE_NUTS' | 'SESAME' | 'MUSTARD' | 'CRUSTACEANS';

export interface SeedOption {
  name: string;
  price: number;
  marker: Marker;
  isDefault?: boolean;
}
export interface SeedGroup {
  key: string;
  name: string;
  min: number;
  max: number;
  options: SeedOption[];
}
export interface SeedItem {
  name: string;
  description: string;
  price: number;
  discounted?: number;
  marker: Marker;
  category: string;
  bestseller?: boolean;
  recommended?: boolean;
  special?: boolean;
  spice?: number;
  tags?: Tag[];
  allergens?: AllergenName[];
  variants?: { name: string; price: number; isDefault?: boolean }[];
  groups?: string[];
}
export interface SeedBranch {
  name: string;
  zone: ZoneKey;
  line1: string;
  area: string;
  pincode: string;
  at: LngLat;
  radiusM: number;
  prepMinutes: number;
  minOrder: number;
  priceForTwo: number;
  packaging: { mode: 'NONE' | 'PER_ITEM' | 'PER_ORDER'; amount: number };
  /** [opens, closes] in branch-local HH:MM, applied every day. */
  hours: [string, string][];
}
export interface SeedRestaurant {
  slug: string;
  brandName: string;
  legalName: string;
  description: string;
  cuisines: string[];
  pureVeg: boolean;
  owner: { fullName: string; phone: string; email: string };
  fssai: string;
  gstin: string;
  branches: SeedBranch[];
  categories: string[];
  groups: SeedGroup[];
  items: SeedItem[];
}

const SPICE: SeedGroup = {
  key: 'spice',
  name: 'Spice level',
  min: 1,
  max: 1,
  options: [
    { name: 'Mild', price: 0, marker: 'VEG' },
    { name: 'Medium', price: 0, marker: 'VEG', isDefault: true },
    { name: 'Hot', price: 0, marker: 'VEG' },
  ],
};

export const RESTAURANTS: SeedRestaurant[] = [
  {
    slug: 'saffron-handi-biryani',
    brandName: 'Saffron Handi Biryani',
    legalName: 'Saffron Handi Foods Private Limited',
    description: 'Slow-cooked dum biryanis and kebabs.',
    cuisines: ['biryani', 'north-indian'],
    pureVeg: false,
    owner: { fullName: 'Imran Sheikh', phone: '+919000000201', email: 'imran.owner@example.com' },
    fssai: '11223344556601',
    gstin: '29ABCDE1234F1Z5',
    branches: [
      { name: 'Koramangala', zone: 'blr-south', line1: '12, 80 Feet Road, 4th Block', area: 'Koramangala', pincode: '560034', at: [77.6241, 12.935], radiusM: 6000, prepMinutes: 25, minOrder: 14900, priceForTwo: 60000, packaging: { mode: 'PER_ORDER', amount: 2000 }, hours: [['11:30', '23:30']] },
      { name: 'Indiranagar', zone: 'blr-east', line1: '45, 12th Main, HAL 2nd Stage', area: 'Indiranagar', pincode: '560038', at: [77.6408, 12.9712], radiusM: 5000, prepMinutes: 25, minOrder: 14900, priceForTwo: 60000, packaging: { mode: 'PER_ORDER', amount: 2000 }, hours: [['11:30', '23:30']] },
    ],
    categories: ['Biryani', 'Kebabs', 'Sides', 'Desserts'],
    groups: [
      SPICE,
      { key: 'biryani-addons', name: 'Add-ons', min: 0, max: 3, options: [
        { name: 'Extra raita', price: 3000, marker: 'VEG' },
        { name: 'Boiled egg', price: 2500, marker: 'EGG' },
        { name: 'Mirchi ka salan', price: 4000, marker: 'VEG' },
      ] },
    ],
    items: [
      { name: 'Chicken Dum Biryani', description: 'Basmati rice and bone-in chicken slow-cooked in a sealed handi.', price: 32900, marker: 'NON_VEG', category: 'Biryani', bestseller: true, recommended: true, spice: 2, allergens: ['MILK'], variants: [{ name: 'Regular', price: 32900, isDefault: true }, { name: 'Family pack (serves 3)', price: 79900 }], groups: ['spice', 'biryani-addons'] },
      { name: 'Mutton Biryani', description: 'Tender mutton pieces layered with saffron rice.', price: 42900, marker: 'NON_VEG', category: 'Biryani', bestseller: true, spice: 2, allergens: ['MILK'], groups: ['spice', 'biryani-addons'] },
      { name: 'Paneer Biryani', description: 'Cottage cheese cubes marinated in yogurt and spices.', price: 27900, marker: 'VEG', category: 'Biryani', spice: 2, allergens: ['MILK'], groups: ['spice', 'biryani-addons'] },
      { name: 'Egg Biryani', description: 'Two masala-fried eggs in fragrant biryani rice.', price: 24900, marker: 'EGG', category: 'Biryani', allergens: ['EGGS'], groups: ['spice'] },
      { name: 'Chicken Seekh Kebab', description: 'Minced chicken skewers off the charcoal grill.', price: 26900, discounted: 22900, marker: 'NON_VEG', category: 'Kebabs', special: true, spice: 2, tags: ['HIGH_PROTEIN'] },
      { name: 'Hara Bhara Kebab', description: 'Spinach and green pea patties.', price: 19900, marker: 'VEG', category: 'Kebabs', tags: ['JAIN'] },
      { name: 'Burani Raita', description: 'Garlic-tempered yogurt.', price: 7900, marker: 'VEG', category: 'Sides', allergens: ['MILK'] },
      { name: 'Double Ka Meetha', description: 'Hyderabadi bread pudding with dry fruits.', price: 12900, marker: 'VEG', category: 'Desserts', allergens: ['GLUTEN', 'MILK', 'TREE_NUTS'] },
    ],
  },
  {
    slug: 'banana-leaf-udupi-kitchen',
    brandName: 'Banana Leaf Udupi Kitchen',
    legalName: 'Banana Leaf Hospitality LLP',
    description: 'Pure vegetarian South Indian breakfast and meals.',
    cuisines: ['south-indian', 'beverages'],
    pureVeg: true,
    owner: { fullName: 'Lakshmi Bhat', phone: '+919000000202', email: 'lakshmi.owner@example.com' },
    fssai: '11223344556602',
    gstin: '29ABCDE1234F2Z4',
    branches: [
      { name: 'HSR Layout', zone: 'blr-south', line1: '7, 27th Main, Sector 1', area: 'HSR Layout', pincode: '560102', at: [77.6386, 12.9121], radiusM: 5000, prepMinutes: 15, minOrder: 9900, priceForTwo: 30000, packaging: { mode: 'PER_ITEM', amount: 500 }, hours: [['07:00', '11:30'], ['12:00', '22:30']] },
      { name: 'Indiranagar', zone: 'blr-east', line1: '201, CMH Road', area: 'Indiranagar', pincode: '560038', at: [77.6395, 12.9784], radiusM: 4000, prepMinutes: 15, minOrder: 9900, priceForTwo: 30000, packaging: { mode: 'PER_ITEM', amount: 500 }, hours: [['07:00', '22:30']] },
    ],
    categories: ['Breakfast', 'Meals', 'Beverages'],
    groups: [
      { key: 'dosa-extras', name: 'Extras', min: 0, max: 2, options: [
        { name: 'Extra chutney', price: 1500, marker: 'VEG' },
        { name: 'Butter on top', price: 2000, marker: 'VEG' },
      ] },
    ],
    items: [
      { name: 'Masala Dosa', description: 'Crisp rice crepe with spiced potato filling, sambar and chutney.', price: 9900, marker: 'VEG', category: 'Breakfast', bestseller: true, recommended: true, tags: ['GLUTEN_FREE'], groups: ['dosa-extras'] },
      { name: 'Idli Vada Combo', description: 'Two idlis and one medu vada.', price: 8900, marker: 'VEG', category: 'Breakfast', bestseller: true, tags: ['GLUTEN_FREE'] },
      { name: 'Rava Idli', description: 'Semolina idlis with cashew and curry leaves.', price: 7900, marker: 'VEG', category: 'Breakfast', allergens: ['GLUTEN', 'TREE_NUTS', 'MILK'] },
      { name: 'South Indian Thali', description: 'Rice, sambar, rasam, two curries, curd and payasam.', price: 19900, marker: 'VEG', category: 'Meals', special: true, allergens: ['MILK'] },
      { name: 'Bisi Bele Bath', description: 'Spiced lentil rice with ghee and boondi.', price: 12900, marker: 'VEG', category: 'Meals', allergens: ['MILK'] },
      { name: 'Filter Coffee', description: 'Decoction coffee with frothy milk.', price: 4900, marker: 'VEG', category: 'Beverages', bestseller: true, allergens: ['MILK'], variants: [{ name: 'Regular', price: 4900, isDefault: true }, { name: 'Large', price: 6900 }] },
    ],
  },
  {
    slug: 'clay-oven-chronicles',
    brandName: 'Clay Oven Chronicles',
    legalName: 'Clay Oven Chronicles Private Limited',
    description: 'North Indian curries, breads and tandoori platters.',
    cuisines: ['north-indian'],
    pureVeg: false,
    owner: { fullName: 'Gurpreet Singh', phone: '+919000000203', email: 'gurpreet.owner@example.com' },
    fssai: '11223344556603',
    gstin: '29ABCDE1234F3Z3',
    branches: [
      { name: 'Koramangala', zone: 'blr-south', line1: '88, 1st Cross, 5th Block', area: 'Koramangala', pincode: '560095', at: [77.6152, 12.9301], radiusM: 6000, prepMinutes: 25, minOrder: 19900, priceForTwo: 70000, packaging: { mode: 'PER_ORDER', amount: 2500 }, hours: [['12:00', '15:30'], ['19:00', '23:30']] },
    ],
    categories: ['Starters', 'Main Course', 'Breads'],
    groups: [SPICE],
    items: [
      { name: 'Butter Chicken', description: 'Tandoori chicken in a tomato, butter and cream gravy.', price: 34900, marker: 'NON_VEG', category: 'Main Course', bestseller: true, recommended: true, allergens: ['MILK', 'TREE_NUTS'], variants: [{ name: 'Half', price: 22900 }, { name: 'Full', price: 34900, isDefault: true }] },
      { name: 'Paneer Tikka', description: 'Charred cottage cheese with peppers and onions.', price: 27900, marker: 'VEG', category: 'Starters', bestseller: true, spice: 2, allergens: ['MILK'], groups: ['spice'] },
      { name: 'Dal Makhani', description: 'Black lentils simmered overnight with butter.', price: 23900, marker: 'VEG', category: 'Main Course', allergens: ['MILK'] },
      { name: 'Tandoori Chicken', description: 'Yogurt and spice marinated chicken from the clay oven.', price: 32900, marker: 'NON_VEG', category: 'Starters', spice: 2, tags: ['HIGH_PROTEIN', 'GLUTEN_FREE'], groups: ['spice'], variants: [{ name: 'Half', price: 21900 }, { name: 'Full', price: 32900, isDefault: true }] },
      { name: 'Butter Naan', description: 'Leavened bread brushed with butter.', price: 6900, marker: 'VEG', category: 'Breads', allergens: ['GLUTEN', 'MILK'] },
      { name: 'Garlic Naan', description: 'Naan topped with garlic and coriander.', price: 7900, marker: 'VEG', category: 'Breads', allergens: ['GLUTEN', 'MILK'] },
    ],
  },
  {
    slug: 'lantern-lane-wok',
    brandName: 'Lantern Lane Wok',
    legalName: 'Lantern Lane Foods LLP',
    description: 'Indo-Chinese noodles, rice and starters.',
    cuisines: ['chinese'],
    pureVeg: false,
    owner: { fullName: 'Kenji Lepcha', phone: '+919000000204', email: 'kenji.owner@example.com' },
    fssai: '11223344556604',
    gstin: '29ABCDE1234F4Z2',
    branches: [
      { name: 'Indiranagar', zone: 'blr-east', line1: '3, Double Road', area: 'Indiranagar', pincode: '560038', at: [77.6455, 12.9683], radiusM: 5000, prepMinutes: 20, minOrder: 14900, priceForTwo: 50000, packaging: { mode: 'PER_ORDER', amount: 1500 }, hours: [['12:00', '23:00']] },
    ],
    categories: ['Starters', 'Noodles & Rice'],
    groups: [
      SPICE,
      { key: 'protein', name: 'Choose protein', min: 1, max: 1, options: [
        { name: 'Vegetable', price: 0, marker: 'VEG', isDefault: true },
        { name: 'Egg', price: 3000, marker: 'EGG' },
        { name: 'Chicken', price: 6000, marker: 'NON_VEG' },
      ] },
    ],
    items: [
      { name: 'Hakka Noodles', description: 'Wok-tossed noodles with vegetables.', price: 18900, marker: 'VEG', category: 'Noodles & Rice', bestseller: true, allergens: ['GLUTEN', 'SOY'], groups: ['spice'] },
      { name: 'Chicken Fried Rice', description: 'Smoky wok-fried rice with chicken and spring onions.', price: 22900, marker: 'NON_VEG', category: 'Noodles & Rice', recommended: true, allergens: ['SOY', 'EGGS'] },
      { name: 'Chilli Paneer', description: 'Crisp paneer tossed with peppers in chilli sauce.', price: 23900, marker: 'VEG', category: 'Starters', spice: 3, tags: ['SPICY'], allergens: ['MILK', 'SOY'], groups: ['spice'] },
      { name: 'Dragon Chicken', description: 'Fiery chicken strips with cashews.', price: 26900, marker: 'NON_VEG', category: 'Starters', spice: 3, tags: ['SPICY'], allergens: ['TREE_NUTS', 'SOY'] },
      { name: 'Schezwan Fried Rice', description: 'Fried rice in hot Schezwan sauce — choose your protein.', price: 19900, marker: 'VEG', category: 'Noodles & Rice', spice: 3, allergens: ['SOY'], groups: ['protein'] },
    ],
  },
  {
    slug: 'ember-and-crust-pizzeria',
    brandName: 'Ember & Crust Pizzeria',
    legalName: 'Ember and Crust Private Limited',
    description: 'Wood-fired pizzas and pastas.',
    cuisines: ['pizza', 'italian'],
    pureVeg: false,
    owner: { fullName: 'Sarah Fernandes', phone: '+919000000205', email: 'sarah.owner@example.com' },
    fssai: '11223344556605',
    gstin: '29ABCDE1234F5Z1',
    branches: [
      { name: 'Koramangala', zone: 'blr-south', line1: '22, 7th Block', area: 'Koramangala', pincode: '560095', at: [77.6271, 12.9363], radiusM: 7000, prepMinutes: 20, minOrder: 19900, priceForTwo: 80000, packaging: { mode: 'PER_ITEM', amount: 1000 }, hours: [['12:00', '23:59']] },
    ],
    categories: ['Pizzas', 'Pasta'],
    groups: [
      { key: 'crust', name: 'Crust', min: 1, max: 1, options: [
        { name: 'Classic hand-tossed', price: 0, marker: 'VEG', isDefault: true },
        { name: 'Thin crust', price: 0, marker: 'VEG' },
        { name: 'Cheese burst', price: 9900, marker: 'VEG' },
      ] },
      { key: 'toppings', name: 'Extra toppings', min: 0, max: 5, options: [
        { name: 'Extra cheese', price: 6000, marker: 'VEG' },
        { name: 'Jalapeños', price: 4000, marker: 'VEG' },
        { name: 'Olives', price: 4000, marker: 'VEG' },
        { name: 'Mushrooms', price: 4500, marker: 'VEG' },
      ] },
      { key: 'meat-toppings', name: 'Meat toppings', min: 0, max: 2, options: [
        { name: 'Pepperoni', price: 8000, marker: 'NON_VEG' },
        { name: 'Grilled chicken', price: 7000, marker: 'NON_VEG' },
      ] },
    ],
    items: [
      { name: 'Margherita', description: 'San Marzano tomato, mozzarella and basil.', price: 29900, marker: 'VEG', category: 'Pizzas', bestseller: true, allergens: ['GLUTEN', 'MILK'], variants: [{ name: 'Medium (10")', price: 29900, isDefault: true }, { name: 'Large (12")', price: 44900 }], groups: ['crust', 'toppings'] },
      { name: 'Farmhouse', description: 'Onion, capsicum, tomato and mushroom.', price: 36900, marker: 'VEG', category: 'Pizzas', allergens: ['GLUTEN', 'MILK'], variants: [{ name: 'Medium (10")', price: 36900, isDefault: true }, { name: 'Large (12")', price: 52900 }], groups: ['crust', 'toppings'] },
      { name: 'Pepperoni Feast', description: 'Double pepperoni and mozzarella.', price: 44900, marker: 'NON_VEG', category: 'Pizzas', recommended: true, allergens: ['GLUTEN', 'MILK'], variants: [{ name: 'Medium (10")', price: 44900, isDefault: true }, { name: 'Large (12")', price: 62900 }], groups: ['crust', 'toppings', 'meat-toppings'] },
      { name: 'Penne Arrabbiata', description: 'Penne in spicy tomato sauce.', price: 27900, marker: 'VEG', category: 'Pasta', tags: ['SPICY'], allergens: ['GLUTEN'] },
      { name: 'Spaghetti Carbonara', description: 'Egg, parmesan and black pepper.', price: 34900, marker: 'EGG', category: 'Pasta', allergens: ['GLUTEN', 'EGGS', 'MILK'] },
    ],
  },
  {
    slug: 'sugar-spoon-desserts',
    brandName: 'Sugar Spoon Desserts',
    legalName: 'Sugar Spoon Bakers',
    description: 'Cakes, brownies and shakes.',
    cuisines: ['desserts', 'bakery', 'beverages'],
    pureVeg: false,
    owner: { fullName: 'Ananya Ghosh', phone: '+919000000206', email: 'ananya.owner@example.com' },
    fssai: '11223344556606',
    gstin: '29ABCDE1234F6Z0',
    branches: [
      { name: 'HSR Layout', zone: 'blr-south', line1: '15, 19th Main, Sector 4', area: 'HSR Layout', pincode: '560102', at: [77.6452, 12.9153], radiusM: 6000, prepMinutes: 10, minOrder: 9900, priceForTwo: 40000, packaging: { mode: 'PER_ITEM', amount: 1000 }, hours: [['11:00', '23:59']] },
    ],
    categories: ['Cakes', 'Brownies', 'Shakes'],
    groups: [],
    items: [
      { name: 'Chocolate Truffle Pastry', description: 'Dark chocolate ganache layers.', price: 14900, marker: 'EGG', category: 'Cakes', bestseller: true, allergens: ['GLUTEN', 'EGGS', 'MILK'] },
      { name: 'Eggless Red Velvet Pastry', description: 'Cream cheese frosting, no egg.', price: 15900, marker: 'VEG', category: 'Cakes', allergens: ['GLUTEN', 'MILK'] },
      { name: 'Walnut Brownie', description: 'Fudgy brownie with toasted walnuts.', price: 12900, marker: 'EGG', category: 'Brownies', recommended: true, allergens: ['GLUTEN', 'EGGS', 'TREE_NUTS', 'MILK'] },
      { name: 'Cold Coffee Shake', description: 'Blended coffee with ice cream.', price: 16900, marker: 'VEG', category: 'Shakes', allergens: ['MILK'], variants: [{ name: 'Regular', price: 16900, isDefault: true }, { name: 'Large', price: 21900 }] },
    ],
  },
  {
    slug: 'leaf-ledger-bowls',
    brandName: 'Leaf Ledger Bowls',
    legalName: 'Leaf Ledger Wellness Private Limited',
    description: 'Vegan and high-protein bowls.',
    cuisines: ['healthy', 'salads'],
    pureVeg: true,
    owner: { fullName: 'Rohan Mehta', phone: '+919000000207', email: 'rohan.owner@example.com' },
    fssai: '11223344556607',
    gstin: '29ABCDE1234F7Z9',
    branches: [
      { name: 'Indiranagar', zone: 'blr-east', line1: '9, 100 Feet Road', area: 'Indiranagar', pincode: '560038', at: [77.6501, 12.9752], radiusM: 5000, prepMinutes: 12, minOrder: 14900, priceForTwo: 55000, packaging: { mode: 'PER_ORDER', amount: 1500 }, hours: [['09:00', '22:00']] },
    ],
    categories: ['Bowls', 'Salads'],
    groups: [
      { key: 'dressing', name: 'Dressing', min: 1, max: 1, options: [
        { name: 'Lemon herb', price: 0, marker: 'VEG', isDefault: true },
        { name: 'Peanut sesame', price: 0, marker: 'VEG' },
        { name: 'Tahini', price: 2000, marker: 'VEG' },
      ] },
    ],
    items: [
      { name: 'Quinoa Power Bowl', description: 'Quinoa, chickpeas, roasted veggies, hummus.', price: 32900, marker: 'VEG', category: 'Bowls', bestseller: true, tags: ['VEGAN', 'HIGH_PROTEIN', 'DAIRY_FREE'], allergens: ['SESAME'], groups: ['dressing'] },
      { name: 'Tofu Teriyaki Bowl', description: 'Glazed tofu, brown rice, edamame.', price: 34900, marker: 'VEG', category: 'Bowls', recommended: true, tags: ['VEGAN', 'HIGH_PROTEIN'], allergens: ['SOY', 'SESAME'], groups: ['dressing'] },
      { name: 'Greek Salad', description: 'Cucumber, tomato, olives and feta.', price: 27900, marker: 'VEG', category: 'Salads', tags: ['GLUTEN_FREE', 'KETO'], allergens: ['MILK'], groups: ['dressing'] },
    ],
  },
  {
    slug: 'kettle-and-kulhad',
    brandName: 'Kettle & Kulhad',
    legalName: 'Kettle and Kulhad Retail',
    description: 'Chai, snacks and quick bites.',
    cuisines: ['beverages', 'snacks'],
    pureVeg: true,
    owner: { fullName: 'Vikram Joshi', phone: '+919000000208', email: 'vikram.owner@example.com' },
    fssai: '11223344556608',
    gstin: '29ABCDE1234F8Z8',
    branches: [
      { name: 'Koramangala', zone: 'blr-south', line1: '5, Jyoti Nivas College Road', area: 'Koramangala', pincode: '560095', at: [77.6201, 12.9256], radiusM: 4000, prepMinutes: 8, minOrder: 0, priceForTwo: 25000, packaging: { mode: 'NONE', amount: 0 }, hours: [['07:00', '22:00']] },
    ],
    categories: ['Chai', 'Snacks'],
    groups: [
      { key: 'sugar', name: 'Sugar', min: 1, max: 1, options: [
        { name: 'Regular sugar', price: 0, marker: 'VEG', isDefault: true },
        { name: 'Less sugar', price: 0, marker: 'VEG' },
        { name: 'No sugar', price: 0, marker: 'VEG' },
      ] },
    ],
    items: [
      { name: 'Masala Chai', description: 'Ginger and cardamom spiced tea.', price: 3900, marker: 'VEG', category: 'Chai', bestseller: true, allergens: ['MILK'], groups: ['sugar'], variants: [{ name: 'Cup', price: 3900, isDefault: true }, { name: 'Flask (serves 4)', price: 14900 }] },
      { name: 'Lemon Ginger Tea', description: 'No-milk tea with lemon and ginger.', price: 4900, marker: 'VEG', category: 'Chai', tags: ['VEGAN', 'DAIRY_FREE'], groups: ['sugar'] },
      { name: 'Vada Pav', description: 'Spiced potato fritter in a soft bun.', price: 5900, marker: 'VEG', category: 'Snacks', special: true, allergens: ['GLUTEN'] },
      { name: 'Samosa (2 pcs)', description: 'Crisp pastry with spiced potato and peas.', price: 4900, marker: 'VEG', category: 'Snacks', allergens: ['GLUTEN'] },
    ],
  },
];

/** Restaurant staff besides owners (demonstrates scoped roles). */
export const RESTAURANT_STAFF = [
  { fullName: 'Deepa Kulkarni', phone: '+919000000301', email: 'deepa.manager@example.com', restaurant: 'saffron-handi-biryani', role: 'MANAGER', branches: null },
  { fullName: 'Suresh Kumar', phone: '+919000000302', email: 'suresh.kitchen@example.com', restaurant: 'saffron-handi-biryani', role: 'KITCHEN', branches: ['Koramangala'] },
] as const;

export const PARTNERS = [
  { fullName: 'Manjunath Gowda', phone: '+919000000401', vehicle: 'MOTORCYCLE', reg: 'KA01AB1234', zone: 'blr-south', at: [77.628, 12.933] as LngLat },
  { fullName: 'Ravi Shankar', phone: '+919000000402', vehicle: 'SCOOTER', reg: 'KA03CD5678', zone: 'blr-south', at: [77.637, 12.914] as LngLat },
  { fullName: 'Pooja Hegde', phone: '+919000000403', vehicle: 'E_BIKE', reg: null, zone: 'blr-south', at: [77.619, 12.927] as LngLat },
  { fullName: 'Abdul Rahman', phone: '+919000000404', vehicle: 'MOTORCYCLE', reg: 'KA05EF9012', zone: 'blr-east', at: [77.642, 12.97] as LngLat },
  { fullName: 'Santosh Patil', phone: '+919000000405', vehicle: 'SCOOTER', reg: 'KA04GH3456', zone: 'blr-east', at: [77.651, 12.976] as LngLat },
  { fullName: 'Nisha Thomas', phone: '+919000000406', vehicle: 'BICYCLE', reg: null, zone: 'blr-east', at: [77.638, 12.979] as LngLat },
] as const;

export const FEE_SCHEDULE = {
  platformFeeAmount: 500,
  smallOrderThresholdAmount: 14900,
  smallOrderFeeAmount: 1500,
  perKmBeyondSlabsAmount: 800,
  packagingCapPerItemAmount: 1000,
  packagingCapPerOrderAmount: 5000,
  surgeCapAmount: 4000,
  slabs: [
    { fromM: 0, toM: 2000, feeAmount: 1900 },
    { fromM: 2000, toM: 4000, feeAmount: 2900 },
    { fromM: 4000, toM: 6000, feeAmount: 3900 },
    { fromM: 6000, toM: 8000, feeAmount: 4900 },
  ],
};

/** Placeholder rates — legal/tax review required before launch (OD-06). */
export const TAX_RULES = [
  { component: 'FOOD', rateBps: 500, collectedBy: 'PLATFORM' },
  { component: 'PACKAGING', rateBps: 500, collectedBy: 'PLATFORM' },
  { component: 'DELIVERY_FEE', rateBps: 1800, collectedBy: 'PLATFORM' },
  { component: 'PLATFORM_FEE', rateBps: 1800, collectedBy: 'PLATFORM' },
  { component: 'SMALL_ORDER_FEE', rateBps: 1800, collectedBy: 'PLATFORM' },
  { component: 'SURGE_FEE', rateBps: 1800, collectedBy: 'PLATFORM' },
] as const;

export const PAY_PLAN = {
  baseAmount: 2500,
  perKmAmount: 600,
  freeKmM: 2000,
  waitAfterMinutes: 10,
  perWaitMinuteAmount: 100,
  waitCapAmount: 3000,
  rainBonusAmount: 2000,
  cancellationMinAmount: 1500,
};

/** Platform settings (`cfg.*`) with approved defaults (SRS §18). */
export const SETTINGS: Record<string, unknown> = {
  'auth.accessTokenTtlSeconds': 900,
  'auth.refreshGraceSeconds': 10,
  'auth.maxSessionsPerApp': 10,
  'auth.lockoutFailures': 5,
  'auth.lockoutMinutes': 15,
  'otp.ttlSeconds': 300,
  'otp.maxAttempts': 5,
  'otp.resendCooldownSeconds': 30,
  'checkout.sessionTtlSeconds': 600,
  'order.paymentTtlSeconds': 900,
  'order.acceptTimeoutSeconds': 300,
  'order.acceptReminderSeconds': 120,
  'order.autoPreparingSeconds': 60,
  'order.maxOrderAmount': 1000000,
  'cancellation.freeWindowAfterAcceptSeconds': 60,
  'cancellation.acceptedFeeBps': 5000,
  'cod.maxOrderAmount': 150000,
  'cod.refusalBlockThreshold': 2,
  'dispatch.offerTimeoutSeconds': 30,
  'dispatch.roundRadiiM': [3000, 5000, 8000],
  'dispatch.offersPerRound': 5,
  'dispatch.leadBufferMinutes': 5,
  'dispatch.noPartnerCancelAfterMinutes': 30,
  'partner.cashCapAmount': 300000,
  'partner.locationMaxAgeSeconds': 60,
  'partner.locationMaxAccuracyM': 100,
  'support.refundLimitAmount': 50000,
  'review.windowDays': 7,
  'cart.expiryDays': 7,
};

export const FEATURE_FLAGS = [
  { key: 'auth.oauthGoogle', description: 'Google sign-in (CORE)', enabled: false },
  { key: 'payments.stripe', description: 'Stripe payment adapter (ADV)', enabled: false },
  { key: 'dispatch.batching', description: 'Two orders per partner trip (ADV)', enabled: false },
  { key: 'pickup.verifyCode', description: 'Require partner pickup code at handover', enabled: false },
] as const;

export const COUPONS = [
  { code: 'WELCOME50', description: '50% off your first order, up to ₹100', discountType: 'PERCENT', value: 5000, maxDiscountAmount: 10000, minSubtotalAmount: 14900, userSegment: 'NEW_USERS', usageLimitPerUser: 1, funding: 'PLATFORM' },
  { code: 'FLAT100', description: '₹100 off on orders above ₹499', discountType: 'FLAT', value: 10000, maxDiscountAmount: null, minSubtotalAmount: 49900, userSegment: 'ALL', usageLimitPerUser: 3, funding: 'PLATFORM' },
  { code: 'FREEDEL', description: 'Free delivery on orders above ₹199', discountType: 'FREE_DELIVERY', value: 0, maxDiscountAmount: null, minSubtotalAmount: 19900, userSegment: 'ALL', usageLimitPerUser: 5, funding: 'PLATFORM' },
] as const;

/** Platform-level ledger accounts created at bootstrap (ADR-011). */
export const PLATFORM_LEDGER_ACCOUNTS = [
  'PLATFORM_REVENUE_COMMISSION',
  'PLATFORM_REVENUE_FEES',
  'PLATFORM_PROMO_EXPENSE',
  'PLATFORM_REFUND_EXPENSE',
  'PLATFORM_DELIVERY_COST',
  'GATEWAY_CLEARING',
  'REFUND_CLEARING',
  'TAX_PAYABLE',
  'PAYOUT_CLEARING',
  'CASH_CLEARING',
  'BANK',
] as const;
