import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { AdminCoupon, AdminCouponFields } from '@fos/api-client';
import { Alert } from '@fos/ui';
import {
  ActionDialog,
  Badge,
  Empty,
  Facts,
  Field,
  Filters,
  Loader,
  Options,
  PageHeader,
  Pager,
  Section,
  Select,
  Table,
} from '../components/ui';
import { admin } from '../lib/admin';
import { bps, dateTime, label, rupees, toPaise } from '../lib/format';
import { usePermissions } from '../lib/permissions';

function describeValue(c: Pick<AdminCoupon, 'discountType' | 'value' | 'maxDiscountAmount'>) {
  if (c.discountType === 'FREE_DELIVERY') return 'Free delivery';
  if (c.discountType === 'PERCENT')
    return `${bps(c.value)} off${c.maxDiscountAmount ? ` up to ${rupees(c.maxDiscountAmount)}` : ''}`;
  return `${rupees(c.value)} off`;
}

export function CouponsPage() {
  const { can } = usePermissions();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['coupons', search, status, page],
    queryFn: () =>
      admin.coupons.list({
        q: search.trim() || undefined,
        status: (status || undefined) as AdminCoupon['status'] | undefined,
        page,
      }),
  });
  return (
    <div>
      <PageHeader
        title="Coupons"
        actions={
          can('coupon:write') && (
            <Link
              to="/coupons/new"
              className="inline-flex h-9 items-center rounded-lg bg-brand-700 px-3 text-sm font-medium text-white hover:bg-brand-800"
            >
              New coupon
            </Link>
          )
        }
      />
      <Filters>
        <Field
          label="Search"
          type="search"
          placeholder="Code or description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={['ACTIVE', 'DRAFT', 'INACTIVE']} any="Any status" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No coupons.</Empty>
          ) : (
            <>
              <Table head={['Code', 'Offer', 'Status', 'Used', 'Valid', 'Funding']}>
                {p.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link
                        to={`/coupons/${c.id}`}
                        className="font-mono font-medium text-brand-700 hover:underline"
                      >
                        {c.code}
                      </Link>
                      <div className="text-xs text-gray-500">{c.description}</div>
                    </td>
                    <td>{describeValue(c)}</td>
                    <td>
                      <Badge value={c.status} />
                    </td>
                    <td>
                      {c.usedCount}
                      {c.usageLimitTotal ? ` / ${c.usageLimitTotal}` : ''}
                    </td>
                    <td>
                      {dateTime(c.startsAt)} – {dateTime(c.endsAt)}
                    </td>
                    <td>{label(c.funding)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </div>
  );
}

const ids = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const local = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : '');
const rupeeText = (p: number | null | undefined) => (p == null ? '' : String(p / 100));

interface Form {
  code: string;
  description: string;
  discountType: AdminCouponFields['discountType'];
  value: string;
  maxDiscount: string;
  minSubtotal: string;
  startsAt: string;
  endsAt: string;
  usageLimitTotal: string;
  usageLimitPerUser: string;
  userSegment: AdminCouponFields['userSegment'];
  userIds: string;
  payment: string;
  funding: AdminCouponFields['funding'];
  restaurantShare: string;
  restaurantIds: string;
  zoneIds: string;
  stackable: boolean;
  visibility: AdminCouponFields['visibility'];
  status: 'DRAFT' | 'ACTIVE';
}

function toForm(c?: AdminCoupon): Form {
  return {
    code: c?.code ?? '',
    description: c?.description ?? '',
    discountType: c?.discountType ?? 'FLAT',
    value: c ? (c.discountType === 'PERCENT' ? String(c.value / 100) : rupeeText(c.value)) : '',
    maxDiscount: rupeeText(c?.maxDiscountAmount),
    minSubtotal: rupeeText(c?.minSubtotalAmount ?? 0),
    startsAt: local(c?.startsAt),
    endsAt: local(c?.endsAt),
    usageLimitTotal: c?.usageLimitTotal ? String(c.usageLimitTotal) : '',
    usageLimitPerUser: String(c?.usageLimitPerUser ?? 1),
    userSegment: c?.userSegment ?? 'ALL',
    userIds: (c?.userIds ?? []).join(', '),
    payment: c?.paymentMethodRestriction ?? '',
    funding: c?.funding ?? 'PLATFORM',
    restaurantShare: c ? String(c.restaurantShareBps / 100) : '0',
    restaurantIds: (c?.restaurantIds ?? []).join(', '),
    zoneIds: (c?.zoneIds ?? []).join(', '),
    stackable: c?.stackableWithPromotion ?? false,
    visibility: c?.visibility ?? 'PUBLIC',
    status: c?.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
  };
}

function toBody(f: Form) {
  const value =
    f.discountType === 'FREE_DELIVERY'
      ? 0
      : f.discountType === 'PERCENT'
        ? Math.round(Number(f.value) * 100)
        : toPaise(f.value);
  return {
    description: f.description.trim(),
    discountType: f.discountType,
    value,
    maxDiscountAmount:
      f.discountType === 'PERCENT' && f.maxDiscount ? toPaise(f.maxDiscount) : null,
    minSubtotalAmount: f.minSubtotal ? toPaise(f.minSubtotal) : 0,
    ...(f.startsAt ? { startsAt: new Date(f.startsAt).toISOString() } : {}),
    endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : '',
    usageLimitTotal: f.usageLimitTotal ? Number(f.usageLimitTotal) : null,
    usageLimitPerUser: Number(f.usageLimitPerUser) || 1,
    userSegment: f.userSegment,
    userIds: f.userSegment === 'TARGETED' ? ids(f.userIds) : [],
    paymentMethodRestriction: (f.payment || null) as AdminCouponFields['paymentMethodRestriction'],
    funding: f.funding,
    restaurantShareBps:
      f.funding === 'PLATFORM'
        ? 0
        : f.funding === 'RESTAURANT'
          ? 10_000
          : Math.round(Number(f.restaurantShare) * 100),
    restaurantIds: ids(f.restaurantIds),
    zoneIds: ids(f.zoneIds),
    stackableWithPromotion: f.stackable,
    visibility: f.visibility,
    status: f.status,
  };
}

function CouponForm({ coupon }: { coupon?: AdminCoupon }) {
  const navigate = useNavigate();
  const [f, setF] = useState<Form>(() => toForm(coupon));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const ready =
    f.description.trim() !== '' &&
    f.endsAt !== '' &&
    (coupon || /^[A-Za-z0-9]{4,20}$/.test(f.code));
  return (
    <Section title={coupon ? 'Edit terms' : 'Terms'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!coupon && (
          <Field
            label="Code"
            value={f.code}
            onChange={(e) => set('code', e.target.value.toUpperCase())}
            hint="4–20 letters and digits"
          />
        )}
        <Field
          label="Description"
          value={f.description}
          onChange={(e) => set('description', e.target.value)}
        />
        <Select
          label="Discount"
          value={f.discountType}
          onChange={(e) => set('discountType', e.target.value as Form['discountType'])}
        >
          <Options values={['FLAT', 'PERCENT', 'FREE_DELIVERY']} />
        </Select>
        {f.discountType !== 'FREE_DELIVERY' && (
          <Field
            label={f.discountType === 'PERCENT' ? 'Percent off' : 'Amount off (₹)'}
            inputMode="decimal"
            value={f.value}
            onChange={(e) => set('value', e.target.value)}
          />
        )}
        {f.discountType === 'PERCENT' && (
          <Field
            label="Maximum discount (₹)"
            inputMode="decimal"
            value={f.maxDiscount}
            onChange={(e) => set('maxDiscount', e.target.value)}
          />
        )}
        <Field
          label="Minimum order (₹)"
          inputMode="decimal"
          value={f.minSubtotal}
          onChange={(e) => set('minSubtotal', e.target.value)}
        />
        <Field
          label="Starts"
          type="datetime-local"
          value={f.startsAt}
          onChange={(e) => set('startsAt', e.target.value)}
        />
        <Field
          label="Ends"
          type="datetime-local"
          value={f.endsAt}
          onChange={(e) => set('endsAt', e.target.value)}
        />
        <Field
          label="Total uses (blank = unlimited)"
          type="number"
          min={1}
          value={f.usageLimitTotal}
          onChange={(e) => set('usageLimitTotal', e.target.value)}
        />
        <Field
          label="Uses per customer"
          type="number"
          min={1}
          max={100}
          value={f.usageLimitPerUser}
          onChange={(e) => set('usageLimitPerUser', e.target.value)}
        />
        <Select
          label="Customers"
          value={f.userSegment}
          onChange={(e) => set('userSegment', e.target.value as Form['userSegment'])}
        >
          <Options values={['ALL', 'NEW_USERS', 'TARGETED']} />
        </Select>
        {f.userSegment === 'TARGETED' && (
          <Field
            label="Customer ids"
            value={f.userIds}
            onChange={(e) => set('userIds', e.target.value)}
            hint="Comma-separated"
          />
        )}
        <Select
          label="Payment method"
          value={f.payment}
          onChange={(e) => set('payment', e.target.value)}
        >
          <Options values={['ONLINE', 'COD']} any="Any" />
        </Select>
        <Select
          label="Funded by"
          value={f.funding}
          onChange={(e) => set('funding', e.target.value as Form['funding'])}
        >
          <Options values={['PLATFORM', 'RESTAURANT', 'SHARED']} />
        </Select>
        {f.funding === 'SHARED' && (
          <Field
            label="Restaurant share (%)"
            inputMode="decimal"
            value={f.restaurantShare}
            onChange={(e) => set('restaurantShare', e.target.value)}
          />
        )}
        <Field
          label="Restaurant ids"
          value={f.restaurantIds}
          onChange={(e) => set('restaurantIds', e.target.value)}
          hint="Comma-separated; blank = all"
        />
        <Field
          label="Zone ids"
          value={f.zoneIds}
          onChange={(e) => set('zoneIds', e.target.value)}
          hint="Comma-separated; blank = all"
        />
        <Select
          label="Visibility"
          value={f.visibility}
          onChange={(e) => set('visibility', e.target.value as Form['visibility'])}
        >
          <Options values={['PUBLIC', 'HIDDEN']} />
        </Select>
        <Select
          label="Status"
          value={f.status}
          onChange={(e) => set('status', e.target.value as Form['status'])}
        >
          <Options values={['ACTIVE', 'DRAFT']} />
        </Select>
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={f.stackable}
            onChange={(e) => set('stackable', e.target.checked)}
          />
          Stacks with restaurant promotions
        </label>
      </div>
      <div className="mt-4">
        <ActionDialog
          label={coupon ? 'Save changes' : 'Create coupon'}
          variant="primary"
          size="md"
          confirmLabel={coupon ? 'Save' : 'Create'}
          disabled={!ready}
          onConfirm={(reason) =>
            coupon
              ? admin.coupons.update(coupon.id, { ...toBody(f), reason })
              : admin.coupons.create({ ...toBody(f), code: f.code, reason })
          }
          onDone={(c) => !coupon && navigate(`/coupons/${c.id}`)}
        />
      </div>
    </Section>
  );
}

export function NewCouponPage() {
  return (
    <div className="space-y-4">
      <PageHeader back={{ to: '/coupons', label: 'Coupons' }} title="New coupon" />
      <CouponForm />
    </div>
  );
}

export function CouponPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['coupons', id], queryFn: () => admin.coupons.get(id) });
  const redemptions = useQuery({
    queryKey: ['coupons', id, 'redemptions', page],
    queryFn: () => admin.coupons.redemptions(id, { page }),
  });
  return (
    <Loader query={q}>
      {(c) => (
        <div className="space-y-4">
          <PageHeader
            back={{ to: '/coupons', label: 'Coupons' }}
            title={c.code}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={c.status} /> {describeValue(c)} · version {c.version}
              </span>
            }
            actions={
              c.status !== 'INACTIVE' &&
              can('coupon:write') && (
                <ActionDialog
                  label="Deactivate"
                  variant="danger"
                  title={`Deactivate ${c.code}`}
                  description="Customers can no longer apply it; reserved uses are released."
                  confirmLabel="Deactivate"
                  onConfirm={(reason) => admin.coupons.deactivate(id, reason)}
                />
              )
            }
          />
          {c.stats && (
            <Section title="Usage">
              <Facts
                items={[
                  ['Redeemed', c.stats.redeemed],
                  ['Reserved', c.stats.reserved],
                  ['Released', c.stats.released],
                  ['Discount given', rupees(c.stats.discountGiven)],
                ]}
              />
            </Section>
          )}
          {c.status === 'INACTIVE' ? (
            <Alert tone="info">This coupon is inactive and can’t be edited.</Alert>
          ) : (
            can('coupon:write') && <CouponForm key={c.version} coupon={c} />
          )}
          <Section title="Redemptions">
            <Loader query={redemptions}>
              {(p) =>
                p.data.length === 0 ? (
                  <Empty>No redemptions yet.</Empty>
                ) : (
                  <>
                    <Table head={['Customer', 'Order', 'Discount', 'Status', 'When']}>
                      {p.data.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link
                              className="text-brand-700 hover:underline"
                              to={`/users/${r.customer.id}`}
                            >
                              {r.customer.fullName}
                            </Link>
                          </td>
                          <td>
                            {r.order ? (
                              <Link
                                className="text-brand-700 hover:underline"
                                to={`/orders/${r.order.id}`}
                              >
                                {r.order.number}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>{rupees(r.discountAmount)}</td>
                          <td>
                            <Badge value={r.status} />
                          </td>
                          <td>{dateTime(r.createdAt)}</td>
                        </tr>
                      ))}
                    </Table>
                    <Pager pagination={p.pagination} onPage={setPage} />
                  </>
                )
              }
            </Loader>
          </Section>
        </div>
      )}
    </Loader>
  );
}
