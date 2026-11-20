import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { AdminPolygon, AdminZone } from '@fos/api-client';
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
  TextArea,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime, rupees, toPaise } from '../lib/format';
import { usePermissions } from '../lib/permissions';

/** Parses a GeoJSON Polygon typed by an admin; returns an error message instead when invalid. */
export function parsePolygon(text: string): AdminPolygon | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'This isn’t valid JSON.';
  }
  const v = value as { type?: unknown; coordinates?: unknown };
  if (v?.type !== 'Polygon' || !Array.isArray(v.coordinates))
    return 'Enter a GeoJSON object with "type": "Polygon" and "coordinates".';
  return { type: 'Polygon', coordinates: v.coordinates as AdminPolygon['coordinates'] };
}

const SAMPLE = JSON.stringify(
  {
    type: 'Polygon',
    coordinates: [
      [
        [77.6, 12.92],
        [77.64, 12.92],
        [77.64, 12.95],
        [77.6, 12.95],
        [77.6, 12.92],
      ],
    ],
  },
  null,
  2,
);

export function ZonesPage() {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [city, setCity] = useState('');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ name: '', city: '', radius: '', polygon: SAMPLE });
  const poly = parsePolygon(form.polygon);
  const q = useQuery({
    queryKey: ['zones', status, city, page],
    queryFn: () =>
      admin.zones.list({
        status: (status || undefined) as AdminZone['status'] | undefined,
        city: city.trim() || undefined,
        page,
      }),
  });
  return (
    <div>
      <PageHeader
        title="Zones"
        subtitle="Delivery areas; active zones never overlap."
        actions={
          can('zone:write') && (
            <ActionDialog
              label="New zone"
              variant="primary"
              title="Create a zone"
              confirmLabel="Create zone"
              ready={form.name.trim() !== '' && form.city.trim() !== '' && typeof poly !== 'string'}
              onConfirm={(reason) =>
                admin.zones.create({
                  name: form.name.trim(),
                  city: form.city.trim(),
                  polygon: poly as AdminPolygon,
                  reason,
                  ...(form.radius ? { maxDeliveryRadiusM: Number(form.radius) } : {}),
                })
              }
              onDone={(z) => navigate(`/zones/${z.id}`)}
            >
              <Field
                label="Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Field
                label="City"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
              />
              <Field
                label="Max delivery radius (m, optional)"
                type="number"
                min={500}
                max={15000}
                value={form.radius}
                onChange={(e) => setForm({ ...form, radius: e.target.value })}
              />
              <TextArea
                label="Boundary (GeoJSON Polygon, [lng, lat])"
                rows={8}
                className="font-mono"
                value={form.polygon}
                onChange={(e) => setForm({ ...form, polygon: e.target.value })}
                hint={
                  typeof poly === 'string' ? poly : 'Closed ring: the last point repeats the first.'
                }
              />
            </ActionDialog>
          )
        }
      />
      <Filters>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={['ACTIVE', 'SUSPENDED', 'INACTIVE']} any="Any status" />
        </Select>
        <Field label="City" value={city} onChange={(e) => setCity(e.target.value)} />
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No zones.</Empty>
          ) : (
            <>
              <Table head={['Zone', 'City', 'Status', 'Area', 'Outlets', 'Surge', 'Rain mode']}>
                {p.data.map((z) => (
                  <tr key={z.id}>
                    <td>
                      <Link
                        className="font-medium text-brand-700 hover:underline"
                        to={`/zones/${z.id}`}
                      >
                        {z.name}
                      </Link>
                    </td>
                    <td>{z.city}</td>
                    <td>
                      <Badge value={z.status} />
                    </td>
                    <td>{z.areaKm2} km²</td>
                    <td>{z.branchCount}</td>
                    <td>{z.surge.active ? rupees(z.surge.amount) : '—'}</td>
                    <td>{z.rainMode ? 'On' : 'Off'}</td>
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

function ZoneEditor({ z }: { z: AdminZone }) {
  const [form, setForm] = useState({
    name: z.name,
    city: z.city,
    radius: String(z.maxDeliveryRadiusM),
    rainMode: z.rainMode,
    polygon: JSON.stringify(z.polygon, null, 2),
  });
  const poly = parsePolygon(form.polygon);
  const polygonChanged = form.polygon !== JSON.stringify(z.polygon, null, 2);
  return (
    <Section title="Edit zone">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label="City"
          value={form.city}
          onChange={(e) => setForm({ ...form, city: e.target.value })}
        />
        <Field
          label="Max delivery radius (m)"
          type="number"
          min={500}
          max={15000}
          value={form.radius}
          onChange={(e) => setForm({ ...form, radius: e.target.value })}
        />
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.rainMode}
          onChange={(e) => setForm({ ...form, rainMode: e.target.checked })}
        />
        Rain mode (slower ETAs, rain bonus for partners)
      </label>
      <div className="mt-3">
        <TextArea
          label="Boundary (GeoJSON Polygon, [lng, lat])"
          rows={10}
          className="font-mono"
          value={form.polygon}
          onChange={(e) => setForm({ ...form, polygon: e.target.value })}
          hint={typeof poly === 'string' ? poly : undefined}
        />
      </div>
      <div className="mt-3">
        <ActionDialog
          label="Save zone"
          variant="primary"
          confirmLabel="Save"
          disabled={typeof poly === 'string'}
          onConfirm={(reason) =>
            admin.zones.update(z.id, {
              reason,
              ...(form.name.trim() !== z.name ? { name: form.name.trim() } : {}),
              ...(form.city.trim() !== z.city ? { city: form.city.trim() } : {}),
              ...(Number(form.radius) !== z.maxDeliveryRadiusM
                ? { maxDeliveryRadiusM: Number(form.radius) }
                : {}),
              ...(form.rainMode !== z.rainMode ? { rainMode: form.rainMode } : {}),
              ...(polygonChanged && typeof poly !== 'string' ? { polygon: poly } : {}),
            })
          }
        />
      </div>
    </Section>
  );
}

export function ZonePage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['zones', id], queryFn: () => admin.zones.get(id) });
  const [surge, setSurge] = useState({ amount: '', until: '', label: '' });
  const surgePaise = toPaise(surge.amount);
  return (
    <Loader query={q}>
      {(z) => (
        <div className="space-y-4">
          <PageHeader
            back={{ to: '/zones', label: 'Zones' }}
            title={z.name}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={z.status} /> {z.city} · {z.areaKm2} km² · {z.branchCount} outlets
              </span>
            }
            actions={
              can('zone:ops') && (
                <>
                  <ActionDialog
                    label="Set surge"
                    title="Zone surge fee"
                    description="Added to delivery fees in this zone (capped by the fee schedule). ₹0 clears it."
                    confirmLabel="Set surge"
                    ready={Number.isFinite(surgePaise) && surgePaise >= 0}
                    onConfirm={(reason) =>
                      admin.zones.setSurge(id, {
                        amount: surgePaise,
                        reason,
                        ...(surge.until ? { until: new Date(surge.until).toISOString() } : {}),
                        ...(surge.label.trim() ? { label: surge.label.trim() } : {}),
                      })
                    }
                  >
                    <Field
                      label="Amount (₹)"
                      inputMode="decimal"
                      value={surge.amount}
                      onChange={(e) => setSurge({ ...surge, amount: e.target.value })}
                    />
                    <Field
                      label="Until"
                      type="datetime-local"
                      value={surge.until}
                      onChange={(e) => setSurge({ ...surge, until: e.target.value })}
                    />
                    <Field
                      label="Label shown to customers"
                      value={surge.label}
                      onChange={(e) => setSurge({ ...surge, label: e.target.value })}
                    />
                  </ActionDialog>
                  {z.status === 'ACTIVE' ? (
                    <ActionDialog
                      label="Suspend zone"
                      variant="danger"
                      description="Outlets in this zone stop taking orders."
                      confirmLabel="Suspend"
                      onConfirm={(reason) => admin.zones.setStatus(id, 'suspend', reason)}
                    />
                  ) : (
                    <ActionDialog
                      label="Activate zone"
                      confirmLabel="Activate"
                      onConfirm={(reason) => admin.zones.setStatus(id, 'activate', reason)}
                    />
                  )}
                </>
              )
            }
          />
          {z.suspensionReason && (
            <Alert tone="warning" title="Suspended">
              {z.suspensionReason}
            </Alert>
          )}
          <Section title="Details">
            <Facts
              items={[
                ['Max delivery radius', `${(z.maxDeliveryRadiusM / 1000).toFixed(1)} km`],
                ['Rain mode', z.rainMode ? 'On' : 'Off'],
                [
                  'Surge',
                  z.surge.active
                    ? `${rupees(z.surge.amount)} until ${dateTime(z.surge.until)}${z.surge.reason ? ` (${z.surge.reason})` : ''}`
                    : 'None',
                ],
                ['Updated', dateTime(z.updatedAt)],
              ]}
            />
          </Section>
          {can('zone:write') && <ZoneEditor key={z.updatedAt} z={z} />}
        </div>
      )}
    </Loader>
  );
}
