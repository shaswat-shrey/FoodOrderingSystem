import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ItemDetails } from '@fos/api-client';
import { Alert, Button, DietaryMarker, ErrorState, Spinner } from '@fos/ui';
import { customer } from '../lib/customer';
import { rupees } from '../lib/format';
import { Dialog, QuantityStepper, ServerError } from './ui';

type Group = ItemDetails['customizationGroups'][number];

const minFor = (g: Group) => Math.max(g.minSelect, g.required ? 1 : 0);

function hint(g: Group) {
  const min = minFor(g);
  if (min > 0 && min === g.maxSelect) return `Required · choose ${min}`;
  if (min > 0) return `Required · choose ${min}–${g.maxSelect}`;
  return g.maxSelect === 1 ? 'Optional · choose up to 1' : `Optional · choose up to ${g.maxSelect}`;
}

/** UI-DS-004 CustomizationSheet: variants, option groups with min/max rules, live price. */
export function ItemSheet({
  branchId,
  itemId,
  onClose,
  onAdd,
}: {
  branchId: string;
  itemId: string;
  onClose: () => void;
  onAdd: (body: {
    variantId?: string;
    optionIds: string[];
    quantity: number;
    instructions?: string;
  }) => Promise<boolean>;
}) {
  const item = useQuery({
    queryKey: ['item', branchId, itemId],
    queryFn: () => customer.branches.item(branchId, itemId),
  });
  return (
    <Dialog title={item.data?.name ?? 'Customise'} onClose={onClose}>
      {item.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner label="Loading options" />
        </div>
      ) : item.isError ? (
        <ErrorState title="Couldn’t load this dish" description={item.error.message} />
      ) : (
        <Customise item={item.data} onAdd={onAdd} onClose={onClose} />
      )}
    </Dialog>
  );
}

function Customise({
  item,
  onAdd,
  onClose,
}: {
  item: ItemDetails;
  onAdd: Parameters<typeof ItemSheet>[0]['onAdd'];
  onClose: () => void;
}) {
  const [variantId, setVariantId] = useState<string | undefined>(
    (item.variants.find((v) => v.isDefault) ?? item.variants[0])?.id,
  );
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      item.customizationGroups.map((g) => [
        g.id,
        g.options.filter((o) => o.isDefault && o.available).map((o) => o.id),
      ]),
    ),
  );
  const [quantity, setQuantity] = useState(1);
  const [instructions, setInstructions] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const groups = item.customizationGroups.filter((g) => !g.variantId || g.variantId === variantId);
  const variant = item.variants.find((v) => v.id === variantId);
  const optionTotal = groups.reduce(
    (sum, g) =>
      sum +
      g.options
        .filter((o) => selected[g.id]?.includes(o.id))
        .reduce((s, o) => s + o.priceDeltaAmount, 0),
    0,
  );
  const unit = (variant?.priceAmount ?? item.priceAmount) + optionTotal;

  function toggle(g: Group, optionId: string) {
    setErrors((e) => ({ ...e, [g.id]: '' }));
    setSelected((cur) => {
      const now = cur[g.id] ?? [];
      if (g.maxSelect === 1) return { ...cur, [g.id]: [optionId] };
      return {
        ...cur,
        [g.id]: now.includes(optionId) ? now.filter((id) => id !== optionId) : [...now, optionId],
      };
    });
  }

  async function submit() {
    const problems: Record<string, string> = {};
    for (const g of groups) {
      const count = selected[g.id]?.length ?? 0;
      const min = minFor(g);
      if (count < min) problems[g.id] = `Choose at least ${min} for ${g.name}.`;
      else if (count > g.maxSelect) problems[g.id] = `Choose up to ${g.maxSelect} for ${g.name}.`;
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const added = await onAdd({
        ...(variantId ? { variantId } : {}),
        optionIds: groups.flatMap((g) => selected[g.id] ?? []),
        quantity,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      if (added) onClose();
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  const problemList = Object.values(errors).filter(Boolean);
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <DietaryMarker type={item.dietaryMarker} className="mt-1" />
        <div>
          {item.description && <p className="text-sm text-gray-600">{item.description}</p>}
          {item.allergenWarnings.length > 0 && (
            <p className="mt-1 text-xs text-warning-600">
              Contains: {item.allergenWarnings.join(', ')}
            </p>
          )}
        </div>
      </div>

      {item.variants.length > 0 && (
        <fieldset>
          <legend className="font-semibold text-gray-900">Size</legend>
          <p className="text-xs text-gray-500">Required · choose 1</p>
          <div className="mt-1 space-y-1">
            {item.variants.map((v) => (
              <label key={v.id} className="flex min-h-11 items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="variant"
                    className="h-5 w-5"
                    checked={variantId === v.id}
                    onChange={() => setVariantId(v.id)}
                  />
                  {v.name}
                </span>
                <span className="tabular-nums text-gray-700">{rupees(v.priceAmount)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {groups.map((g) => {
        const chosen = selected[g.id] ?? [];
        const radio = g.maxSelect === 1;
        return (
          <fieldset
            key={g.id}
            aria-invalid={Boolean(errors[g.id]) || undefined}
            aria-describedby={`hint-${g.id}`}
          >
            <legend className="font-semibold text-gray-900">{g.name}</legend>
            <p
              id={`hint-${g.id}`}
              className={errors[g.id] ? 'text-xs text-danger-600' : 'text-xs text-gray-500'}
            >
              {errors[g.id] || hint(g)}
            </p>
            <div className="mt-1 space-y-1">
              {g.options.map((o) => (
                <label key={o.id} className="flex min-h-11 items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <input
                      type={radio ? 'radio' : 'checkbox'}
                      name={`group-${g.id}`}
                      className="h-5 w-5"
                      checked={chosen.includes(o.id)}
                      disabled={
                        !o.available ||
                        (!radio && !chosen.includes(o.id) && chosen.length >= g.maxSelect)
                      }
                      onChange={() => toggle(g, o.id)}
                    />
                    <DietaryMarker type={o.dietaryMarker} size="sm" />
                    {o.name}
                    {!o.available && <span className="text-xs text-gray-500">(unavailable)</span>}
                  </span>
                  {o.priceDeltaAmount !== 0 && (
                    <span className="tabular-nums text-gray-700">
                      +{rupees(o.priceDeltaAmount)}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}

      <label className="block text-sm">
        <span className="font-medium text-gray-800">Cooking instructions (optional)</span>
        <textarea
          value={instructions}
          maxLength={250}
          onChange={(e) => setInstructions(e.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base"
          rows={2}
        />
      </label>

      {problemList.length > 0 && (
        <Alert tone="error" title="Please complete your choices">
          <ul className="list-disc pl-5">
            {problemList.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      <ServerError error={failure} />

      <div className="sticky bottom-0 flex items-center gap-3 bg-white pb-1 pt-2">
        <QuantityStepper value={quantity} onChange={setQuantity} label={item.name} min={1} />
        <Button className="flex-1" size="lg" loading={busy} onClick={() => void submit()}>
          Add item · {rupees(unit * quantity)}
        </Button>
      </div>
    </div>
  );
}
