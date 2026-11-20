import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomizationGroup, OptionInput } from '@fos/api-client';
import { Alert, Button, DietaryMarker, EmptyState, Spinner } from '@fos/ui';
import { Field, Section, ServerError } from '../components/fields';
import { fromPaise, rupees, toPaise } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

/**
 * BR-MENU-003: 0 ≤ minimum ≤ maximum, maximum ≥ 1, and the maximum can't be more
 * than the number of options once the group has some. Returns the problem, if any.
 */
export function groupRuleProblem(min: number, max: number, optionCount: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return 'Use whole numbers.';
  if (min < 0) return 'The minimum can’t be below 0.';
  if (max < 1) return 'The maximum must be at least 1.';
  if (min > max) return 'The minimum can’t be more than the maximum.';
  if (optionCount > 0 && max > optionCount)
    return `The maximum can’t be more than the number of options (${optionCount}).`;
  return null;
}

/** FR-MENU-004 (API-RMENU-017…022): reusable option groups with their rules and options. */
export function OptionGroupsPage() {
  const { restaurant, can } = useWorkspace();
  const qc = useQueryClient();
  const rid = restaurant?.id ?? '';
  const menu = useQuery({
    queryKey: ['menu', rid, 'all'],
    queryFn: () => merchant.menu.get(rid),
    enabled: Boolean(rid),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['menu'] });
  if (!restaurant) return null;
  if (!menu.data) return <Spinner />;
  const write = can('rest.menu:write');
  const groups = menu.data.customizationGroups;
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to="/menu" className="text-brand-700 underline">
          ← Back to menu
        </Link>
      </p>
      <h1 className="text-2xl font-bold">Option groups</h1>
      <p className="text-sm text-gray-600">
        Groups like “Spice level” or “Extras” can be added to many dishes. Customers must choose at
        least the minimum and at most the maximum.
      </p>
      {write && <NewGroup restaurantId={rid} onSaved={refresh} />}
      {groups.length === 0 && <EmptyState title="No option groups yet" />}
      {groups.map((g) => (
        <GroupCard
          key={`${g.id}-${g.minSelect}-${g.maxSelect}-${g.name}`}
          group={g}
          restaurantId={rid}
          editable={write}
          onSaved={refresh}
        />
      ))}
    </div>
  );
}

function NewGroup({ restaurantId, onSaved }: { restaurantId: string; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [min, setMin] = useState('0');
  const [max, setMax] = useState('1');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      merchant.menu.createGroup(restaurantId, {
        name: name.trim(),
        minSelect: Number(min),
        maxSelect: Number(max),
      }),
    onSuccess: () => {
      setName('');
      setMin('0');
      setMax('1');
      onSaved();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p =
      name.trim().length < 2
        ? 'Enter a group name.'
        : groupRuleProblem(Number(min), Number(max), 0);
    setProblem(p);
    if (!p) create.mutate();
  };
  return (
    <Section title="New option group">
      <form onSubmit={submit} noValidate className="grid items-end gap-2 md:grid-cols-4">
        <Field label="Group name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label="Minimum choices"
          type="number"
          min={0}
          value={min}
          onChange={(e) => setMin(e.target.value)}
        />
        <Field
          label="Maximum choices"
          type="number"
          min={1}
          value={max}
          onChange={(e) => setMax(e.target.value)}
        />
        <Button type="submit" loading={create.isPending}>
          Create group
        </Button>
      </form>
      {problem && (
        <Alert tone="error" className="mt-2">
          {problem}
        </Alert>
      )}
      <ServerError error={create.error} />
    </Section>
  );
}

function GroupCard({
  group,
  restaurantId,
  editable,
  onSaved,
}: {
  group: CustomizationGroup;
  restaurantId: string;
  editable: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [min, setMin] = useState(String(group.minSelect));
  const [max, setMax] = useState(String(group.maxSelect));
  const problem = groupRuleProblem(Number(min), Number(max), group.options.length);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: onSaved,
  });
  const dirty =
    name !== group.name || Number(min) !== group.minSelect || Number(max) !== group.maxSelect;
  const attached = group.attachedTo ?? 0;
  return (
    <section
      aria-label={`Option group ${group.name}`}
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-base font-semibold">
        {group.name}{' '}
        <span className="text-sm font-normal text-gray-600">
          {group.minSelect >= 1 ? 'Required' : 'Optional'} · on {attached} dish
          {attached === 1 ? '' : 'es'}
        </span>
      </h2>
      {editable && (
        <div className="mt-2 grid items-end gap-2 md:grid-cols-4">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Field
            label="Minimum choices"
            type="number"
            min={0}
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
          <Field
            label="Maximum choices"
            type="number"
            min={1}
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!dirty || Boolean(problem) || name.trim().length < 2}
            loading={act.isPending}
            onClick={() =>
              act.mutate(() =>
                merchant.menu.updateGroup(restaurantId, group.id, {
                  name: name.trim(),
                  minSelect: Number(min),
                  maxSelect: Number(max),
                }),
              )
            }
          >
            Save rules
          </Button>
        </div>
      )}
      {editable && problem && (
        <p role="alert" className="mt-1 text-sm text-danger-600">
          {problem}
        </p>
      )}
      <ul className="mt-3 divide-y divide-gray-100" aria-label={`${group.name} options`}>
        {group.options.map((o) => (
          <OptionRow
            key={`${o.id}-${o.name}-${o.priceDeltaAmount}-${o.dietaryMarker}`}
            option={o}
            editable={editable}
            busy={act.isPending}
            onSave={(body) =>
              act.mutate(() => merchant.menu.updateOption(restaurantId, group.id, o.id, body))
            }
            onRemove={() =>
              act.mutate(() => merchant.menu.deleteOption(restaurantId, group.id, o.id))
            }
          />
        ))}
        {group.options.length === 0 && (
          <li className="py-2 text-sm text-gray-600">No options yet; add at least one.</li>
        )}
      </ul>
      {editable && (
        <NewOption
          busy={act.isPending}
          onAdd={(body) => act.mutate(() => merchant.menu.addOption(restaurantId, group.id, body))}
        />
      )}
      <ServerError error={act.error} />
      {editable && (
        <div className="mt-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={attached > 0 || act.isPending}
            onClick={() => act.mutate(() => merchant.menu.deleteGroup(restaurantId, group.id))}
          >
            Delete group
          </Button>
          {attached > 0 && (
            <span className="ml-2 text-xs text-gray-600">
              Remove it from its dishes before deleting.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function OptionRow({
  option,
  editable,
  busy,
  onSave,
  onRemove,
}: {
  option: CustomizationGroup['options'][number];
  editable: boolean;
  busy: boolean;
  onSave: (body: Partial<OptionInput>) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(option.name);
  const [price, setPrice] = useState(fromPaise(option.priceDeltaAmount));
  const dirty = name !== option.name || toPaise(price || '0') !== option.priceDeltaAmount;
  if (!editable)
    return (
      <li className="flex items-center gap-2 py-2 text-sm">
        <DietaryMarker type={option.dietaryMarker} />
        {option.name} · +{rupees(option.priceDeltaAmount)}
      </li>
    );
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <DietaryMarker type={option.dietaryMarker} />
      <input
        aria-label={`${option.name} name`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-9 w-40 rounded border border-gray-300 px-2"
      />
      <input
        aria-label={`${option.name} extra price (₹)`}
        type="number"
        min={0}
        step="0.01"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        className="h-9 w-24 rounded border border-gray-300 px-2"
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!dirty || busy || !name.trim()}
        onClick={() => onSave({ name: name.trim(), priceDeltaAmount: toPaise(price || '0')! })}
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
        Remove
      </Button>
    </li>
  );
}

function NewOption({ busy, onAdd }: { busy: boolean; onAdd: (o: OptionInput) => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [marker, setMarker] = useState<OptionInput['dietaryMarker']>('VEG');
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd({
          name: name.trim(),
          priceDeltaAmount: toPaise(price || '0')!,
          dietaryMarker: marker,
        });
        setName('');
        setPrice('');
      }}
    >
      <label className="text-sm">
        <span className="block font-medium">Option</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 h-9 w-40 rounded border border-gray-300 px-2"
        />
      </label>
      <label className="text-sm">
        <span className="block font-medium">Extra price (₹)</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="mt-1 h-9 w-24 rounded border border-gray-300 px-2"
        />
      </label>
      <label className="text-sm">
        <span className="block font-medium">Type</span>
        <select
          value={marker}
          onChange={(e) => setMarker(e.target.value as OptionInput['dietaryMarker'])}
          className="mt-1 h-9 rounded border border-gray-300 px-2"
        >
          <option value="VEG">Veg</option>
          <option value="NON_VEG">Non-veg</option>
          <option value="EGG">Egg</option>
        </select>
      </label>
      <Button type="submit" size="sm" variant="secondary" disabled={busy || !name.trim()}>
        Add option
      </Button>
    </form>
  );
}
