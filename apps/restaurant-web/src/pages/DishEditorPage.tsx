import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Allergen,
  CustomizationGroup,
  ItemInput,
  ManagedMenu,
  MenuItem,
  MenuTag,
} from '@fos/api-client';
import { Alert, Button, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/fields';
import { fromPaise, isVersionConflict, label, rupees, toPaise } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

export const TAGS: MenuTag[] = [
  'VEGAN',
  'JAIN',
  'GLUTEN_FREE',
  'DAIRY_FREE',
  'SPICY',
  'KETO',
  'HIGH_PROTEIN',
];
export const ALLERGENS: Allergen[] = [
  'GLUTEN',
  'CRUSTACEANS',
  'EGGS',
  'FISH',
  'PEANUTS',
  'SOY',
  'MILK',
  'TREE_NUTS',
  'CELERY',
  'MUSTARD',
  'SESAME',
  'SULPHITES',
  'LUPIN',
  'MOLLUSCS',
];
const FLAGS = [
  ['isBestseller', 'Bestseller'],
  ['isRecommended', 'Recommended'],
  ['isTodaysSpecial', 'Today’s special'],
  ['isFeatured', 'Featured'],
  ['isHidden', 'Hidden from customers'],
] as const;
export const MAX_PHOTOS = 5;

/** FR-MENU-002…006 (API-RMENU-008…016): every field of one dish, its photos, variants and add-ons. */
export function DishEditorPage() {
  const { itemId = '' } = useParams();
  const { restaurant, can } = useWorkspace();
  const qc = useQueryClient();
  const rid = restaurant?.id ?? '';
  const key = ['menu', 'item', rid, itemId];
  const item = useQuery({
    queryKey: key,
    queryFn: () => merchant.menu.item(rid, itemId),
    enabled: Boolean(rid && itemId),
  });
  const menu = useQuery({
    queryKey: ['menu', rid, 'all'],
    queryFn: () => merchant.menu.get(rid),
    enabled: Boolean(rid),
  });
  // Bumped to throw away unsaved edits (after a save, or when reloading after a conflict).
  const [formKey, setFormKey] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const update = (next: MenuItem) => {
    qc.setQueryData(key, next);
    void qc.invalidateQueries({ queryKey: ['menu', rid] });
  };

  if (!restaurant) return null;
  if (item.isError) return <ServerError error={item.error} />;
  if (!item.data || !menu.data) return <Spinner />;
  const write = can('rest.menu:write');
  const d = item.data;

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to="/menu" className="text-brand-700 underline">
          ← Back to menu
        </Link>
      </p>
      <h1 className="text-2xl font-bold">{d.name}</h1>
      <DishDetails
        key={formKey}
        item={d}
        categories={menu.data.categories}
        restaurantId={rid}
        editable={write}
        justSaved={justSaved}
        onSaved={(next) => {
          update(next);
          setJustSaved(true);
          setFormKey((n) => n + 1);
        }}
        onReload={async () => {
          await item.refetch();
          setJustSaved(false);
          setFormKey((n) => n + 1);
        }}
      />
      <Photos item={d} restaurantId={rid} editable={write} onChange={update} />
      <Variants item={d} restaurantId={rid} editable={write} onChange={update} />
      <AttachGroups
        key={`groups-${d.version}`}
        item={d}
        groups={menu.data.customizationGroups}
        restaurantId={rid}
        editable={write}
        onChange={update}
      />
      {write && <DeleteDish restaurantId={rid} item={d} />}
    </div>
  );
}

type Form = {
  categoryId: string;
  name: string;
  description: string;
  price: string;
  offer: string;
  dietaryMarker: ItemInput['dietaryMarker'];
  spiceLevel: string;
  servingSize: string;
  prepMinutes: string;
  calories: string;
  packaging: string;
  tags: MenuTag[];
  allergens: Allergen[];
  ingredients: string;
} & Record<(typeof FLAGS)[number][0], boolean>;

function toForm(i: MenuItem): Form {
  return {
    categoryId: i.categoryId,
    name: i.name,
    description: i.description ?? '',
    price: fromPaise(i.basePriceAmount),
    offer: fromPaise(i.discountedPriceAmount),
    dietaryMarker: i.dietaryMarker,
    spiceLevel: i.spiceLevel == null ? '' : String(i.spiceLevel),
    servingSize: i.servingSize ?? '',
    prepMinutes: i.prepMinutes == null ? '' : String(i.prepMinutes),
    calories: i.calories == null ? '' : String(i.calories),
    packaging: fromPaise(i.packagingFeeAmount),
    tags: i.tags ?? [],
    allergens: i.allergens ?? [],
    ingredients: (i.ingredients ?? []).join(', '),
    isBestseller: i.isBestseller,
    isRecommended: i.isRecommended,
    isTodaysSpecial: i.isTodaysSpecial,
    isFeatured: i.isFeatured,
    isHidden: i.isHidden,
  };
}

const num = (s: string) => (s.trim() === '' ? null : Number(s));

/** Client checks mirror BR-MENU-002 (price range, offer below price); the API checks again. */
export function checkDish(f: Form): string[] {
  const problems: string[] = [];
  const price = toPaise(f.price);
  const offer = toPaise(f.offer);
  if (f.name.trim().length < 2) problems.push('Enter a dish name.');
  if (price == null || !(price >= 100 && price <= 10_000_000))
    problems.push('Price must be between ₹1 and ₹1,00,000.');
  if (offer != null && price != null && offer >= price)
    problems.push('The offer price must be lower than the price.');
  return problems;
}

function DishDetails({
  item,
  categories,
  restaurantId,
  editable,
  justSaved,
  onSaved,
  onReload,
}: {
  item: MenuItem;
  categories: ManagedMenu['categories'];
  restaurantId: string;
  editable: boolean;
  justSaved: boolean;
  onSaved: (i: MenuItem) => void;
  onReload: () => Promise<void>;
}) {
  const [f, setF] = useState<Form>(() => toForm(item));
  const [problems, setProblems] = useState<string[]>([]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = <T extends string>(k: 'tags' | 'allergens', v: T) =>
    setF((x) => {
      const list = x[k] as string[];
      return { ...x, [k]: list.includes(v) ? list.filter((t) => t !== v) : [...list, v] };
    });
  const save = useMutation({
    mutationFn: () =>
      merchant.menu.updateItem(
        restaurantId,
        item.id,
        {
          categoryId: f.categoryId,
          name: f.name.trim(),
          description: f.description.trim() || null,
          basePriceAmount: toPaise(f.price),
          discountedPriceAmount: toPaise(f.offer),
          dietaryMarker: f.dietaryMarker,
          spiceLevel: num(f.spiceLevel),
          servingSize: f.servingSize.trim() || null,
          prepMinutes: num(f.prepMinutes),
          calories: num(f.calories),
          packagingFeeAmount: toPaise(f.packaging),
          tags: f.tags,
          allergens: f.allergens,
          ingredients: f.ingredients
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          ...Object.fromEntries(FLAGS.map(([k]) => [k, f[k]])),
        },
        item.version,
      ),
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = checkDish(f);
    setProblems(p);
    if (p.length === 0) save.mutate();
  };
  const conflict = save.isError && isVersionConflict(save.error);

  return (
    <Section title="Details">
      <form onSubmit={submit} noValidate className="space-y-4">
        <fieldset disabled={!editable} className="grid gap-3 md:grid-cols-2">
          <Field label="Dish name" value={f.name} onChange={(e) => set('name', e.target.value)} />
          <Select
            label="Category"
            value={f.categoryId}
            onChange={(e) => set('categoryId', e.target.value)}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <label className="block text-sm md:col-span-2">
            <span className="font-medium text-gray-800">Description</span>
            <textarea
              value={f.description}
              maxLength={1000}
              onChange={(e) => set('description', e.target.value)}
              className="mt-1 block min-h-20 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <Field
            label="Price (₹)"
            type="number"
            min={1}
            step="0.01"
            value={f.price}
            onChange={(e) => set('price', e.target.value)}
          />
          <Field
            label="Offer price (₹)"
            hint="Optional; must be lower than the price."
            type="number"
            min={1}
            step="0.01"
            value={f.offer}
            onChange={(e) => set('offer', e.target.value)}
          />
          <Select
            label="Veg / non-veg"
            value={f.dietaryMarker}
            onChange={(e) => set('dietaryMarker', e.target.value as Form['dietaryMarker'])}
          >
            <option value="VEG">Veg</option>
            <option value="NON_VEG">Non-veg</option>
            <option value="EGG">Egg</option>
          </Select>
          <Select
            label="Spice level"
            value={f.spiceLevel}
            onChange={(e) => set('spiceLevel', e.target.value)}
          >
            <option value="">Not shown</option>
            <option value="0">Not spicy</option>
            <option value="1">Mild</option>
            <option value="2">Medium</option>
            <option value="3">Hot</option>
          </Select>
          <Field
            label="Serving size"
            placeholder="e.g. Serves 2"
            value={f.servingSize}
            onChange={(e) => set('servingSize', e.target.value)}
          />
          <Field
            label="Prep time (minutes)"
            type="number"
            min={1}
            max={120}
            value={f.prepMinutes}
            onChange={(e) => set('prepMinutes', e.target.value)}
          />
          <Field
            label="Calories (kcal)"
            type="number"
            min={0}
            value={f.calories}
            onChange={(e) => set('calories', e.target.value)}
          />
          <Field
            label="Packaging fee (₹)"
            hint="Leave empty to use the outlet’s fee."
            type="number"
            min={0}
            step="0.01"
            value={f.packaging}
            onChange={(e) => set('packaging', e.target.value)}
          />
          <Field
            label="Ingredients"
            hint="Separate with commas."
            value={f.ingredients}
            onChange={(e) => set('ingredients', e.target.value)}
          />
          <CheckList
            legend="Dietary tags"
            all={TAGS}
            chosen={f.tags}
            onToggle={(v) => toggle('tags', v)}
          />
          <CheckList
            legend="Allergens"
            all={ALLERGENS}
            chosen={f.allergens}
            onToggle={(v) => toggle('allergens', v)}
          />
          <fieldset className="md:col-span-2">
            <legend className="text-sm font-medium text-gray-800">Labels</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {FLAGS.map(([k, text]) => (
                <label key={k} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={f[k]}
                    onChange={(e) => set(k, e.target.checked)}
                  />
                  {text}
                </label>
              ))}
            </div>
          </fieldset>
        </fieldset>
        {problems.length > 0 && (
          <Alert tone="error" title="Check these fields">
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        {conflict ? (
          <Alert tone="warning" title="This dish was changed elsewhere">
            Someone else saved this dish after you opened it. Reload to see the latest version, then
            make your changes again.
            <div className="mt-2">
              <Button size="sm" variant="secondary" onClick={() => void onReload()}>
                Reload dish
              </Button>
            </div>
          </Alert>
        ) : (
          <ServerError error={save.error} />
        )}
        {justSaved && !save.isError && <Alert tone="success">Dish saved.</Alert>}
        {editable && (
          <Button type="submit" loading={save.isPending}>
            Save dish
          </Button>
        )}
      </form>
    </Section>
  );
}

function CheckList<T extends string>({
  legend,
  all,
  chosen,
  onToggle,
}: {
  legend: string;
  all: T[];
  chosen: T[];
  onToggle: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {all.map((v) => (
          <label key={v} className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={chosen.includes(v)} onChange={() => onToggle(v)} />
            {label(v)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Photos({
  item,
  restaurantId,
  editable,
  onChange,
}: {
  item: MenuItem;
  restaurantId: string;
  editable: boolean;
  onChange: (i: MenuItem) => void;
}) {
  const act = useMutation({
    mutationFn: (fn: () => Promise<MenuItem>) => fn(),
    onSuccess: onChange,
  });
  const ids = item.images.map((i) => i.id);
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    act.mutate(() => merchant.menu.reorderImages(restaurantId, item.id, next));
  };
  const upload = (file: File) =>
    act.mutate(async () => {
      const f = await merchant.upload(file, 'FOOD_IMAGE', file.name);
      return merchant.menu.addImage(restaurantId, item.id, f.id);
    });
  return (
    <Section title={`Photos (${item.images.length} of ${MAX_PHOTOS})`}>
      <p className="mb-2 text-sm text-gray-600">The first photo is the one customers see first.</p>
      {item.images.length === 0 && <p className="text-sm text-gray-600">No photos yet.</p>}
      <ol className="flex flex-wrap gap-3">
        {item.images.map((img, n) => (
          <li key={img.id} className="w-36 rounded-lg border border-gray-200 p-2">
            {img.urls?.thumb || img.urls?.card ? (
              <img
                src={img.urls.thumb ?? img.urls.card}
                alt={`${item.name}, photo ${n + 1}`}
                className="h-24 w-full rounded object-cover"
              />
            ) : (
              <div className="flex h-24 items-center justify-center rounded bg-gray-100 text-xs text-gray-500">
                Processing…
              </div>
            )}
            {editable && (
              <div className="mt-2 flex justify-between gap-1">
                <button
                  type="button"
                  className="px-1 text-sm disabled:opacity-40"
                  aria-label={`Move photo ${n + 1} earlier`}
                  disabled={n === 0 || act.isPending}
                  onClick={() => move(n, n - 1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="text-sm text-danger-600 underline"
                  aria-label={`Remove photo ${n + 1}`}
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate(() => merchant.menu.removeImage(restaurantId, item.id, img.id))
                  }
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="px-1 text-sm disabled:opacity-40"
                  aria-label={`Move photo ${n + 1} later`}
                  disabled={n === item.images.length - 1 || act.isPending}
                  onClick={() => move(n, n + 1)}
                >
                  →
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {editable && item.images.length < MAX_PHOTOS && (
        <label className="mt-3 block text-sm">
          <span className="font-medium">Add a photo</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="mt-1 block text-sm"
            disabled={act.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
              e.target.value = '';
            }}
          />
        </label>
      )}
      <ServerError error={act.error} />
    </Section>
  );
}

/** BR-MENU-004: when a dish has variants, exactly one is the default. */
function Variants({
  item,
  restaurantId,
  editable,
  onChange,
}: {
  item: MenuItem;
  restaurantId: string;
  editable: boolean;
  onChange: (i: MenuItem) => void;
}) {
  const act = useMutation({
    mutationFn: (fn: () => Promise<MenuItem>) => fn(),
    onSuccess: onChange,
  });
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const paise = toPaise(price);
    if (!name.trim() || paise == null) return;
    act.mutate(async () => {
      const next = await merchant.menu.addVariant(restaurantId, item.id, {
        name: name.trim(),
        priceAmount: paise,
        ...(makeDefault ? { isDefault: true } : {}),
      });
      setName('');
      setPrice('');
      setMakeDefault(false);
      return next;
    });
  };
  return (
    <Section title="Variants">
      <p className="mb-2 text-sm text-gray-600">
        Sizes or portions with their own price, like Half and Full. One variant is always the
        default; choose another default to change it.
      </p>
      {item.variants.length === 0 ? (
        <p className="text-sm text-gray-600">This dish has one size at its main price.</p>
      ) : (
        <ul className="divide-y divide-gray-100" aria-label="Variants">
          {item.variants.map((v) => (
            <VariantRow
              key={`${v.id}-${v.name}-${v.priceAmount}`}
              variant={v}
              editable={editable}
              busy={act.isPending}
              onSave={(body) =>
                act.mutate(() => merchant.menu.updateVariant(restaurantId, item.id, v.id, body))
              }
              onRemove={() =>
                act.mutate(() => merchant.menu.deleteVariant(restaurantId, item.id, v.id))
              }
            />
          ))}
        </ul>
      )}
      <ServerError error={act.error} />
      {editable && (
        <form onSubmit={add} className="mt-3 grid items-end gap-2 md:grid-cols-4">
          <Field label="Variant name" value={name} onChange={(e) => setName(e.target.value)} />
          <Field
            label="Variant price (₹)"
            type="number"
            min={1}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <label className="inline-flex h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={makeDefault || item.variants.length === 0}
              disabled={item.variants.length === 0}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            Make it the default
          </label>
          <Button type="submit" variant="secondary" disabled={!name.trim() || !price}>
            Add variant
          </Button>
        </form>
      )}
    </Section>
  );
}

function VariantRow({
  variant,
  editable,
  busy,
  onSave,
  onRemove,
}: {
  variant: MenuItem['variants'][number];
  editable: boolean;
  busy: boolean;
  onSave: (body: { name?: string; priceAmount?: number; isDefault?: boolean }) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(variant.name);
  const [price, setPrice] = useState(fromPaise(variant.priceAmount));
  const dirty = name !== variant.name || toPaise(price) !== variant.priceAmount;
  return (
    <li className="flex flex-wrap items-center gap-2 py-2" aria-label={`Variant ${variant.name}`}>
      {editable ? (
        <>
          <input
            aria-label={`${variant.name} name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-40 rounded border border-gray-300 px-2 text-sm"
          />
          <input
            aria-label={`${variant.name} price (₹)`}
            type="number"
            min={1}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="h-9 w-28 rounded border border-gray-300 px-2 text-sm"
          />
        </>
      ) : (
        <span>
          {variant.name} · {rupees(variant.priceAmount)}
        </span>
      )}
      {variant.isDefault ? (
        <span className="rounded-full bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-800">
          Default
        </span>
      ) : (
        editable && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onSave({ isDefault: true })}
          >
            Make default
          </Button>
        )
      )}
      {editable && (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty || busy || toPaise(price) == null}
            onClick={() => onSave({ name: name.trim(), priceAmount: toPaise(price)! })}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        </>
      )}
    </li>
  );
}

/** FR-MENU-004: reusable option groups on this dish, for every variant or only some. */
function AttachGroups({
  item,
  groups,
  restaurantId,
  editable,
  onChange,
}: {
  item: MenuItem;
  groups: CustomizationGroup[];
  restaurantId: string;
  editable: boolean;
  onChange: (i: MenuItem) => void;
}) {
  const linkKey = (groupId: string, variantId: string | null) => `${groupId}:${variantId ?? ''}`;
  const [links, setLinks] = useState<Set<string>>(
    () => new Set(item.customizationGroups.map((l) => linkKey(l.groupId, l.variantId))),
  );
  const save = useMutation({
    mutationFn: () =>
      merchant.menu.attachGroups(
        restaurantId,
        item.id,
        [...links].map((k) => {
          const [groupId, variantId] = k.split(':');
          return { groupId: groupId!, variantId: variantId || null };
        }),
      ),
    onSuccess: onChange,
  });
  const flip = (k: string) =>
    setLinks((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const scopes: { id: string | null; name: string }[] = [
    { id: null, name: 'All variants' },
    ...item.variants.map((v) => ({ id: v.id, name: v.name })),
  ];
  return (
    <Section
      title="Add-ons and choices"
      aside={
        <Link to="/menu/groups" className="text-sm text-brand-700 underline">
          Manage option groups
        </Link>
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm text-gray-600">
          No option groups yet. Create groups like “Spice level” or “Extras” first.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li key={g.id}>
              <fieldset disabled={!editable || g.options.length === 0}>
                <legend className="text-sm font-medium">
                  {g.name}{' '}
                  <span className="font-normal text-gray-600">
                    (choose {g.minSelect}–{g.maxSelect}, {g.options.length} options)
                  </span>
                </legend>
                <div className="mt-1 flex flex-wrap gap-x-4">
                  {(item.variants.length ? scopes : scopes.slice(0, 1)).map((s) => (
                    <label key={s.id ?? 'all'} className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={links.has(linkKey(g.id, s.id))}
                        onChange={() => flip(linkKey(g.id, s.id))}
                      />
                      {item.variants.length ? s.name : 'On this dish'}
                    </label>
                  ))}
                </div>
              </fieldset>
            </li>
          ))}
        </ul>
      )}
      <ServerError error={save.error} />
      {save.isSuccess && <Alert tone="success">Add-ons saved.</Alert>}
      {editable && groups.length > 0 && (
        <Button
          className="mt-3"
          variant="secondary"
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save add-ons
        </Button>
      )}
    </Section>
  );
}

function DeleteDish({ restaurantId, item }: { restaurantId: string; item: MenuItem }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const del = useMutation({
    mutationFn: () => merchant.menu.deleteItem(restaurantId, item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['menu'] });
      void navigate('/menu');
    },
  });
  return (
    <Section title="Delete dish">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Delete “{item.name}”? Customers will no longer see it.</span>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>
            Yes, delete
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Delete this dish
        </Button>
      )}
      <ServerError error={del.error} />
    </Section>
  );
}
