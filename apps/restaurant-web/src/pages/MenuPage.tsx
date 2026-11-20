import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MenuItem } from '@fos/api-client';
import { Button, DietaryMarker, EmptyState, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/fields';
import { rupees } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

/** FR-MENU-001…008: categories, dishes and per-outlet availability. */
export function MenuPage() {
  const { restaurant, branchId, can } = useWorkspace();
  const qc = useQueryClient();
  const key = ['menu', restaurant?.id, branchId];
  const menu = useQuery({
    queryKey: key,
    queryFn: () => merchant.menu.get(restaurant!.id, branchId ?? undefined),
    enabled: Boolean(restaurant),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['menu'] });
  const [newCategory, setNewCategory] = useState('');
  const addCategory = useMutation({
    mutationFn: () => merchant.menu.createCategory(restaurant!.id, newCategory),
    onSuccess: () => {
      setNewCategory('');
      void refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (i: MenuItem) =>
      merchant.menu.setAvailability(
        branchId!,
        i.id,
        !(i.available ?? true),
        i.available === false ? undefined : 'END_OF_DAY',
      ),
    onSuccess: refresh,
  });
  if (!restaurant) return null;
  if (menu.isLoading || !menu.data) return <Spinner />;
  const write = can('rest.menu:write');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Menu</h1>
      <ServerError error={toggle.error ?? addCategory.error} />
      {write && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addCategory.mutate();
          }}
        >
          <div className="flex-1">
            <Field
              label="New category"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="e.g. Biryani"
            />
          </div>
          <Button
            type="submit"
            disabled={newCategory.trim().length < 2}
            loading={addCategory.isPending}
          >
            Add
          </Button>
        </form>
      )}
      {menu.data.categories.length === 0 && (
        <EmptyState title="Your menu is empty" description="Add a category, then your dishes." />
      )}
      {menu.data.categories.map((c) => (
        <Section key={c.id} title={`${c.name}${c.isActive ? '' : ' (hidden)'}`}>
          <ul className="divide-y divide-gray-100">
            {c.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-2">
                <div className="flex items-center gap-2">
                  <DietaryMarker type={i.dietaryMarker} />
                  <span className={i.available === false ? 'text-gray-400 line-through' : ''}>
                    {i.name}
                  </span>
                  <span className="text-sm text-gray-600">
                    {i.discountedPriceAmount ? (
                      <>
                        <s>{rupees(i.basePriceAmount)}</s> {rupees(i.discountedPriceAmount)}
                      </>
                    ) : (
                      rupees(i.basePriceAmount)
                    )}
                  </span>
                  {i.isHidden && <span className="text-xs text-gray-500">hidden</span>}
                </div>
                {branchId && can('rest.menu:availability') && (
                  <Button
                    size="sm"
                    variant={i.available === false ? 'primary' : 'secondary'}
                    loading={toggle.isPending && toggle.variables?.id === i.id}
                    onClick={() => toggle.mutate(i)}
                  >
                    {i.available === false ? 'Back in stock' : 'Out of stock today'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {write && <NewItem restaurantId={restaurant.id} categoryId={c.id} onSaved={refresh} />}
        </Section>
      ))}
    </div>
  );
}

function NewItem({
  restaurantId,
  categoryId,
  onSaved,
}: {
  restaurantId: string;
  categoryId: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [marker, setMarker] = useState<'VEG' | 'NON_VEG' | 'EGG'>('VEG');
  const [photo, setPhoto] = useState<File | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const item = await merchant.menu.createItem(restaurantId, {
        categoryId,
        name,
        basePriceAmount: Math.round(Number(price) * 100),
        dietaryMarker: marker,
      });
      if (photo) {
        const f = await merchant.upload(photo, 'FOOD_IMAGE', photo.name);
        await merchant.menu.addImage(restaurantId, item.id, f.id);
      }
      return item;
    },
    onSuccess: () => {
      setOpen(false);
      setName('');
      setPrice('');
      setPhoto(null);
      onSaved();
    },
  });
  if (!open)
    return (
      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        + Add dish
      </Button>
    );
  return (
    <form
      className="mt-3 grid gap-2 md:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field label="Dish name" value={name} onChange={(e) => setName(e.target.value)} required />
      <Field
        label="Price (₹)"
        type="number"
        min={1}
        step="0.01"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        required
      />
      <Select
        label="Type"
        value={marker}
        onChange={(e) => setMarker(e.target.value as typeof marker)}
      >
        <option value="VEG">Veg</option>
        <option value="NON_VEG">Non-veg</option>
        <option value="EGG">Egg</option>
      </Select>
      <label className="block text-sm">
        <span className="font-medium">Photo</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="mt-2 block text-sm"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </label>
      <div className="md:col-span-4">
        <ServerError error={create.error} />
      </div>
      <div className="flex gap-2 md:col-span-4">
        <Button type="submit" loading={create.isPending}>
          Save dish
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
