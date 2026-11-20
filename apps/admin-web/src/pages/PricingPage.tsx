import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  ActionDialog,
  Badge,
  Empty,
  Field,
  Loader,
  Options,
  PageHeader,
  Select,
  Table,
  Tabs,
  TextArea,
} from '../components/ui';
import { admin } from '../lib/admin';
import { bps, dateTime, label, rupees, toPaise } from '../lib/format';
import { usePermissions } from '../lib/permissions';

type Unit = 'paise' | 'm' | 'min';
interface Spec {
  key: string;
  label: string;
  unit: Unit;
}

const FEE_FIELDS: Spec[] = [
  { key: 'platformFeeAmount', label: 'Platform fee (₹)', unit: 'paise' },
  { key: 'smallOrderThresholdAmount', label: 'Small-order threshold (₹)', unit: 'paise' },
  { key: 'smallOrderFeeAmount', label: 'Small-order fee (₹)', unit: 'paise' },
  { key: 'perKmBeyondSlabsAmount', label: 'Per km beyond slabs (₹)', unit: 'paise' },
  { key: 'packagingCapPerItemAmount', label: 'Packaging cap per item (₹)', unit: 'paise' },
  { key: 'packagingCapPerOrderAmount', label: 'Packaging cap per order (₹)', unit: 'paise' },
  { key: 'surgeCapAmount', label: 'Surge cap (₹)', unit: 'paise' },
];
const PAY_FIELDS: Spec[] = [
  { key: 'baseAmount', label: 'Base pay (₹)', unit: 'paise' },
  { key: 'perKmAmount', label: 'Per km (₹)', unit: 'paise' },
  { key: 'freeKmM', label: 'Distance included (m)', unit: 'm' },
  { key: 'waitAfterMinutes', label: 'Wait pay after (min)', unit: 'min' },
  { key: 'perWaitMinuteAmount', label: 'Per wait minute (₹)', unit: 'paise' },
  { key: 'waitCapAmount', label: 'Wait pay cap (₹)', unit: 'paise' },
  { key: 'rainBonusAmount', label: 'Rain bonus (₹, 0 or 10–30)', unit: 'paise' },
  { key: 'cancellationMinAmount', label: 'Minimum on cancellation (₹)', unit: 'paise' },
];

const show = (unit: Unit, v: number) =>
  unit === 'paise' ? rupees(v) : unit === 'm' ? `${v} m` : `${v} min`;
const toText = (unit: Unit, v: number | undefined) =>
  v === undefined ? '' : unit === 'paise' ? String(v / 100) : String(v);
const fromText = (unit: Unit, s: string) => (unit === 'paise' ? toPaise(s) : Number(s));

/** Number inputs for a new version, prefilled from the version in effect. */
function useNumbers(specs: Spec[], current?: Record<string, unknown>) {
  const [values, setValues] = useState<Record<string, string>>({});
  const text = (s: Spec) => values[s.key] ?? toText(s.unit, current?.[s.key] as number | undefined);
  const body = Object.fromEntries(specs.map((s) => [s.key, fromText(s.unit, text(s))]));
  const ok = Object.values(body).every((v) => Number.isFinite(v) && v >= 0);
  const fields = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {specs.map((s) => (
        <Field
          key={s.key}
          label={s.label}
          inputMode="decimal"
          value={text(s)}
          onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
        />
      ))}
    </div>
  );
  return { body, ok, fields };
}

function EffectiveFrom({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field
      label="Effective from (optional, default now)"
      type="datetime-local"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
const when = (v: string) => (v ? { effectiveFrom: new Date(v).toISOString() } : {});

function Versions<T extends { id: string; state: string; effectiveFrom: string }>({
  query,
  head,
  row,
  action,
}: {
  query: UseQueryResult<T[]>;
  head: string[];
  row: (r: T) => ReactNode[];
  action?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {action && <div className="flex justify-end">{action}</div>}
      <Loader query={query}>
        {(list) =>
          list.length === 0 ? (
            <Empty>No versions yet.</Empty>
          ) : (
            <Table head={['State', 'Effective from', ...head]}>
              {list.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Badge value={r.state} />
                  </td>
                  <td>{dateTime(r.effectiveFrom)}</td>
                  {row(r).map((c, i) => (
                    <td key={i}>{c}</td>
                  ))}
                </tr>
              ))}
            </Table>
          )
        }
      </Loader>
    </div>
  );
}

function FeeSchedules({ canWrite }: { canWrite: boolean }) {
  const q = useQuery({
    queryKey: ['pricing', 'fees'],
    queryFn: () => admin.pricing.feeSchedules(),
  });
  const current = q.data?.find((f) => f.state === 'IN_EFFECT' && !f.zoneId);
  const nums = useNumbers(FEE_FIELDS, current as unknown as Record<string, unknown>);
  const [zoneId, setZoneId] = useState('');
  const [from, setFrom] = useState('');
  const [slabs, setSlabs] = useState<string | null>(null);
  const slabText =
    slabs ?? JSON.stringify(current?.slabs ?? [{ fromM: 0, toM: 3000, feeAmount: 2500 }], null, 1);
  let parsedSlabs: unknown = null;
  try {
    parsedSlabs = JSON.parse(slabText);
  } catch {
    parsedSlabs = null;
  }
  return (
    <Versions
      query={q}
      head={['Zone', 'Platform fee', 'Small order', 'Surge cap', 'Slabs']}
      row={(f) => [
        f.zoneId ? f.zoneId.slice(0, 8) : 'Default',
        rupees(f.platformFeeAmount),
        `${rupees(f.smallOrderFeeAmount)} under ${rupees(f.smallOrderThresholdAmount)}`,
        rupees(f.surgeCapAmount),
        f.slabs
          .map((s) => `${s.fromM / 1000}–${s.toM / 1000} km: ${rupees(s.feeAmount)}`)
          .join('; '),
      ]}
      action={
        canWrite && (
          <ActionDialog
            label="New fee schedule"
            variant="primary"
            title="New fee schedule version"
            description="Versions are never edited; a new one takes over from its start time."
            confirmLabel="Create version"
            ready={nums.ok && Array.isArray(parsedSlabs)}
            onConfirm={(reason) =>
              admin.pricing.createFeeSchedule({
                ...nums.body,
                slabs: parsedSlabs,
                zoneId: zoneId.trim() || null,
                reason,
                ...when(from),
              })
            }
          >
            <Field
              label="Zone id (blank = default)"
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value)}
            />
            {nums.fields}
            <TextArea
              label="Distance slabs (JSON; metres and paise)"
              rows={5}
              value={slabText}
              onChange={(e) => setSlabs(e.target.value)}
              hint={
                Array.isArray(parsedSlabs)
                  ? 'Contiguous from 0 m.'
                  : 'This isn’t a valid JSON list.'
              }
            />
            <EffectiveFrom value={from} onChange={setFrom} />
          </ActionDialog>
        )
      }
    />
  );
}

const COMPONENTS = [
  'FOOD',
  'PACKAGING',
  'DELIVERY_FEE',
  'PLATFORM_FEE',
  'SMALL_ORDER_FEE',
  'SURGE_FEE',
];

function TaxRules({ canWrite }: { canWrite: boolean }) {
  const q = useQuery({ queryKey: ['pricing', 'tax'], queryFn: () => admin.pricing.taxRules() });
  const [f, setF] = useState({
    component: 'FOOD',
    taxCode: 'GST',
    rate: '',
    collectedBy: 'RESTAURANT',
    from: '',
  });
  const rate = Math.round(Number(f.rate) * 100);
  return (
    <Versions
      query={q}
      head={['Component', 'Tax', 'Rate', 'Collected by']}
      row={(t) => [label(t.component), t.taxCode, bps(t.rateBps), label(t.collectedBy)]}
      action={
        canWrite && (
          <ActionDialog
            label="New tax rule"
            variant="primary"
            confirmLabel="Create rule"
            ready={f.rate !== '' && rate >= 0 && rate <= 2800}
            onConfirm={(reason) =>
              admin.pricing.createTaxRule({
                component: f.component,
                taxCode: f.taxCode,
                rateBps: rate,
                collectedBy: f.collectedBy,
                reason,
                ...when(f.from),
              })
            }
          >
            <Select
              label="Component"
              value={f.component}
              onChange={(e) => setF({ ...f, component: e.target.value })}
            >
              <Options values={COMPONENTS} />
            </Select>
            <Select
              label="Tax"
              value={f.taxCode}
              onChange={(e) => setF({ ...f, taxCode: e.target.value })}
            >
              <Options values={['GST', 'CGST', 'SGST', 'IGST']} />
            </Select>
            <Field
              label="Rate (%)"
              inputMode="decimal"
              value={f.rate}
              onChange={(e) => setF({ ...f, rate: e.target.value })}
              hint="0–28%"
            />
            <Select
              label="Collected by"
              value={f.collectedBy}
              onChange={(e) => setF({ ...f, collectedBy: e.target.value })}
            >
              <Options values={['RESTAURANT', 'PLATFORM']} />
            </Select>
            <EffectiveFrom value={f.from} onChange={(from) => setF({ ...f, from })} />
          </ActionDialog>
        )
      }
    />
  );
}

function CommissionPlans({ canWrite }: { canWrite: boolean }) {
  const q = useQuery({
    queryKey: ['pricing', 'commission'],
    queryFn: () => admin.pricing.commissionPlans(),
  });
  const [f, setF] = useState({ name: '', rate: '', from: '' });
  const rate = Math.round(Number(f.rate) * 100);
  return (
    <Versions
      query={q}
      head={['Plan', 'Rate']}
      row={(c) => [c.name, bps(c.rateBps)]}
      action={
        canWrite && (
          <ActionDialog
            label="New commission plan"
            variant="primary"
            description="The default rate for restaurants without their own override."
            confirmLabel="Create plan"
            ready={f.name.trim() !== '' && f.rate !== '' && rate >= 0 && rate <= 5000}
            onConfirm={(reason) =>
              admin.pricing.createCommissionPlan({
                name: f.name.trim(),
                rateBps: rate,
                reason,
                ...when(f.from),
              })
            }
          >
            <Field
              label="Name"
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
            <Field
              label="Rate (%)"
              inputMode="decimal"
              value={f.rate}
              onChange={(e) => setF({ ...f, rate: e.target.value })}
              hint="0–50%"
            />
            <EffectiveFrom value={f.from} onChange={(from) => setF({ ...f, from })} />
          </ActionDialog>
        )
      }
    />
  );
}

function PayPlans({ canWrite }: { canWrite: boolean }) {
  const q = useQuery({ queryKey: ['pricing', 'pay'], queryFn: () => admin.pricing.payPlans() });
  const current = q.data?.find((p) => p.state === 'IN_EFFECT' && !p.zoneId);
  const nums = useNumbers(PAY_FIELDS, current as unknown as Record<string, unknown>);
  const [zoneId, setZoneId] = useState('');
  const [from, setFrom] = useState('');
  return (
    <Versions
      query={q}
      head={['Zone', ...PAY_FIELDS.slice(0, 4).map((s) => s.label.replace(/ \(.*\)/, ''))]}
      row={(p) => [
        p.zoneId ? p.zoneId.slice(0, 8) : 'Default',
        ...PAY_FIELDS.slice(0, 4).map((s) =>
          show(s.unit, (p as unknown as Record<string, number>)[s.key] ?? 0),
        ),
      ]}
      action={
        canWrite && (
          <ActionDialog
            label="New pay plan"
            variant="primary"
            title="New partner pay plan version"
            confirmLabel="Create version"
            ready={nums.ok}
            onConfirm={(reason) =>
              admin.pricing.createPayPlan({
                ...nums.body,
                zoneId: zoneId.trim() || null,
                reason,
                ...when(from),
              })
            }
          >
            <Field
              label="Zone id (blank = default)"
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value)}
            />
            {nums.fields}
            <EffectiveFrom value={from} onChange={setFrom} />
          </ActionDialog>
        )
      }
    />
  );
}

type Tab = 'fees' | 'tax' | 'commission' | 'pay';

export function PricingPage() {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const tab = (
    ['fees', 'tax', 'commission', 'pay'].includes(params.get('tab') ?? '')
      ? params.get('tab')
      : 'fees'
  ) as Tab;
  return (
    <div>
      <PageHeader
        title="Pricing plans"
        subtitle="Effective-dated: a change is a new version, never an edit."
      />
      <Tabs
        tabs={[
          { key: 'fees', label: 'Fee schedules' },
          { key: 'tax', label: 'Tax rules' },
          { key: 'commission', label: 'Commission plans' },
          { key: 'pay', label: 'Partner pay plans' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t })}
      />
      {tab === 'fees' && <FeeSchedules canWrite={can('pricing:write')} />}
      {tab === 'tax' && <TaxRules canWrite={can('pricing:write')} />}
      {tab === 'commission' && <CommissionPlans canWrite={can('commission:write')} />}
      {tab === 'pay' && <PayPlans canWrite={can('earnings:config')} />}
    </div>
  );
}
