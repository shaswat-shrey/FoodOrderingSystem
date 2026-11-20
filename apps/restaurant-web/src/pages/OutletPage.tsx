import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Slot } from '@fos/api-client';
import { Alert, Button, EmptyState, Spinner } from '@fos/ui';
import { Section, ServerError } from '../components/fields';
import { WEEKDAYS } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

const PAUSE = [15, 30, 45, 60];

/** FR-REST-012…018: status with its reason, open/close/pause, prep time and hours. */
export function OutletPage() {
  const { branchId, can } = useWorkspace();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['branch', branchId, 'status'],
    queryFn: () => merchant.branch.status(branchId!),
    enabled: Boolean(branchId),
    refetchInterval: 30_000,
  });
  const settings = useQuery({
    queryKey: ['branch', branchId, 'settings'],
    queryFn: () => merchant.branch.settings(branchId!),
    enabled: Boolean(branchId),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['branch', branchId] });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
  });
  if (!branchId) return <EmptyState title="No outlet selected" />;
  if (!status.data || !settings.data) return <Spinner />;
  const s = status.data;
  const canStatus = can('rest.branch:status');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{settings.data.name}</h1>
      <Section title="Status">
        <p
          className={`text-lg font-semibold ${s.acceptingOrders ? 'text-green-700' : 'text-gray-800'}`}
        >
          {s.label}
        </p>
        <ServerError error={act.error} />
        {canStatus && (
          <div className="mt-3 flex flex-wrap gap-2">
            {s.online ? (
              <Button
                variant="secondary"
                onClick={() => act.mutate(() => merchant.branch.close(branchId))}
              >
                Go offline for today
              </Button>
            ) : (
              <Button onClick={() => act.mutate(() => merchant.branch.open(branchId))}>
                Go online
              </Button>
            )}
            {s.pausedUntil ? (
              <Button onClick={() => act.mutate(() => merchant.branch.resume(branchId))}>
                Resume orders
              </Button>
            ) : (
              PAUSE.map((m) => (
                <Button
                  key={m}
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    act.mutate(() =>
                      merchant.branch.pause(branchId, { minutes: m, reason: 'BUSY_KITCHEN' }),
                    )
                  }
                >
                  Pause {m} min
                </Button>
              ))
            )}
          </div>
        )}
      </Section>
      {can('rest.branch:update') && (
        <PrepTime
          branchId={branchId}
          current={settings.data.defaultPrepMinutes}
          rush={s.rush?.extraMinutes ?? 0}
          onSaved={refresh}
        />
      )}
      <Hours
        branchId={branchId}
        initial={settings.data.hours}
        editable={can('rest.branch:hours')}
        onSaved={refresh}
      />
    </div>
  );
}

function PrepTime({
  branchId,
  current,
  rush,
  onSaved,
}: {
  branchId: string;
  current: number;
  rush: number;
  onSaved: () => void;
}) {
  const [prep, setPrep] = useState(current);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof merchant.branch.prepTime>[1]) =>
      merchant.branch.prepTime(branchId, body),
    onSuccess: onSaved,
  });
  return (
    <Section title="Preparation time">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block font-medium">Default (minutes)</span>
          <input
            type="number"
            min={5}
            max={90}
            value={prep}
            onChange={(e) => setPrep(Number(e.target.value))}
            className="mt-1 h-11 w-24 rounded-md border border-gray-300 px-2"
          />
        </label>
        <Button variant="secondary" onClick={() => save.mutate({ defaultPrepMinutes: prep })}>
          Save
        </Button>
        <span className="ml-4 text-sm font-medium">Rush:</span>
        {[0, 10, 20, 30].map((m) => (
          <Button
            key={m}
            size="sm"
            variant={rush === m ? 'primary' : 'secondary'}
            onClick={() => save.mutate({ rush: { extraMinutes: m, forMinutes: 60 } })}
          >
            {m === 0 ? 'Off' : `+${m} min (1 h)`}
          </Button>
        ))}
      </div>
      <ServerError error={save.error} />
    </Section>
  );
}

/** Weekly hours editor: up to three slots per day, slots may pass midnight (BR-REST-003). */
export function Hours({
  branchId,
  initial,
  editable,
  onSaved,
}: {
  branchId: string;
  initial: Slot[];
  editable: boolean;
  onSaved: () => void;
}) {
  const [slots, setSlots] = useState<Slot[]>(initial);
  const save = useMutation({
    mutationFn: () => merchant.branch.hours(branchId, slots),
    onSuccess: onSaved,
  });
  const set = (i: number, patch: Partial<Slot>) =>
    setSlots((all) => all.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  return (
    <Section
      title="Opening hours"
      aside={
        editable && (
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
            Save hours
          </Button>
        )
      }
    >
      {save.isSuccess && <Alert tone="success">Hours saved.</Alert>}
      <ServerError error={save.error} />
      <table className="w-full text-sm">
        <tbody>
          {WEEKDAYS.map((day, weekday) => {
            const own = slots.map((s, i) => ({ s, i })).filter((x) => x.s.weekday === weekday);
            return (
              <tr key={day} className="border-t border-gray-100 align-top">
                <th scope="row" className="w-16 py-2 text-left font-medium">
                  {day}
                </th>
                <td className="py-2">
                  {own.length === 0 && <span className="text-gray-500">Closed</span>}
                  {own.map(({ s, i }) => (
                    <span key={i} className="mr-3 inline-flex items-center gap-1">
                      <input
                        aria-label={`${day} opens`}
                        type="time"
                        disabled={!editable}
                        value={s.opensAt}
                        onChange={(e) => set(i, { opensAt: e.target.value })}
                        className="h-9 rounded border border-gray-300 px-1"
                      />
                      –
                      <input
                        aria-label={`${day} closes`}
                        type="time"
                        disabled={!editable}
                        value={s.closesAt}
                        onChange={(e) => set(i, { closesAt: e.target.value })}
                        className="h-9 rounded border border-gray-300 px-1"
                      />
                      {editable && (
                        <button
                          type="button"
                          aria-label={`Remove ${day} slot`}
                          className="px-1 text-gray-500"
                          onClick={() => setSlots((all) => all.filter((_, n) => n !== i))}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {editable && own.length < 3 && (
                    <button
                      type="button"
                      className="text-brand-700 underline"
                      onClick={() =>
                        setSlots((all) => [
                          ...all,
                          { weekday, opensAt: '11:00', closesAt: '23:00' },
                        ])
                      }
                    >
                      Add slot
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}
