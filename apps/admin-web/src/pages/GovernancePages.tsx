import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AdminStaffRole } from '@fos/api-client';
import { cn } from '@fos/ui';
import {
  ActionDialog,
  Badge,
  Empty,
  Field,
  Filters,
  Json,
  Loader,
  Options,
  PageHeader,
  Pager,
  Section,
  Select,
  Table,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime, label } from '../lib/format';
import { usePermissions } from '../lib/permissions';

/* ------------------------------ review moderation ------------------------------ */

export function ReviewsPage() {
  const [status, setStatus] = useState<'OPEN' | 'UPHELD' | 'DISMISSED'>('OPEN');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['reviews', status, page],
    queryFn: () => admin.reviews.reports({ status, page }),
  });
  return (
    <div>
      <PageHeader
        title="Review moderation"
        subtitle="Reviews customers or restaurants reported, most-reported first."
      />
      <Filters>
        <Select
          label="Reports"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <Options values={['OPEN', 'UPHELD', 'DISMISSED']} />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No reported reviews.</Empty>
          ) : (
            <>
              <ul className="space-y-3">
                {p.data.map((r) => (
                  <li key={r.id} className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-semibold">
                            {'★'.repeat(r.rating)}
                            {'☆'.repeat(Math.max(0, 5 - r.rating))}
                          </span>
                          <Badge value={r.status} />
                          <span className="text-gray-500">
                            {label(r.targetType)} · {r.restaurant?.brandName ?? ''}{' '}
                            {r.branch ? `(${r.branch.name})` : ''}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">
                          {r.text ?? <em>No text</em>}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          by {r.author?.fullName ?? 'a customer'} · {dateTime(r.createdAt)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {r.status !== 'HIDDEN' && (
                          <ActionDialog
                            label="Hide"
                            variant="danger"
                            title="Hide review"
                            description="Upholds the reports; the rating is recomputed without it."
                            confirmLabel="Hide review"
                            onConfirm={(reason) => admin.reviews.moderate(r.id, 'hide', reason)}
                          />
                        )}
                        <ActionDialog
                          label={r.status === 'HIDDEN' ? 'Restore' : 'Dismiss reports'}
                          title={r.status === 'HIDDEN' ? 'Restore review' : 'Keep review visible'}
                          description="Dismisses the reports."
                          confirmLabel={r.status === 'HIDDEN' ? 'Restore' : 'Dismiss'}
                          onConfirm={(reason) => admin.reviews.moderate(r.id, 'unhide', reason)}
                        />
                      </div>
                    </div>
                    <div className="mt-2 rounded bg-gray-50 p-2 text-xs text-gray-700">
                      {r.reports.count} report{r.reports.count === 1 ? '' : 's'}:{' '}
                      {Object.entries(r.reports.reasons)
                        .map(([k, n]) => `${label(k)} ×${n}`)
                        .join(', ')}
                      {r.reports.latest
                        .filter((x) => x.note)
                        .map((x, i) => (
                          <div key={i} className="mt-1 italic">
                            “{x.note}”
                          </div>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </div>
  );
}

/* ------------------------------ roles and admins ------------------------------ */

const STAFF: AdminStaffRole[] = ['SUPPORT_AGENT', 'ADMIN', 'SUPER_ADMIN'];

function GrantRole() {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{ id: string; fullName: string } | null>(null);
  const [role, setRole] = useState<AdminStaffRole>('SUPPORT_AGENT');
  const found = useQuery({
    queryKey: ['users', 'grant-search', search],
    queryFn: () => admin.users.list({ q: search.trim(), pageSize: 5 }),
    enabled: search.trim().length >= 2,
  });
  return (
    <ActionDialog
      label="Grant staff role"
      variant="primary"
      title="Grant a staff role"
      description="Takes effect on the user’s next request. Staff need a verified email for their second sign-in factor."
      confirmLabel="Grant role"
      ready={picked !== null}
      onConfirm={(reason) => admin.users.grantRole(picked!.id, role, reason)}
      onDone={() => {
        setPicked(null);
        setSearch('');
      }}
    >
      {picked ? (
        <p className="text-sm">
          User: <span className="font-medium">{picked.fullName}</span>{' '}
          <button
            type="button"
            className="text-brand-700 underline"
            onClick={() => setPicked(null)}
          >
            change
          </button>
        </p>
      ) : (
        <>
          <Field
            label="Find user"
            type="search"
            placeholder="Name, phone or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {found.data && (
            <ul className="divide-y divide-gray-100 rounded border border-gray-200 text-sm">
              {found.data.data.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left hover:bg-gray-50"
                    onClick={() => setPicked({ id: u.id, fullName: u.fullName })}
                  >
                    {u.fullName} <span className="text-gray-500">{u.email ?? u.phone}</span>
                  </button>
                </li>
              ))}
              {found.data.data.length === 0 && (
                <li className="px-2 py-1.5 text-gray-500">No match.</li>
              )}
            </ul>
          )}
        </>
      )}
      <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as AdminStaffRole)}>
        <Options values={STAFF} />
      </Select>
    </ActionDialog>
  );
}

function StaffList() {
  const { can } = usePermissions();
  const [role, setRole] = useState<AdminStaffRole>('ADMIN');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['users', 'staff', role, page],
    queryFn: () => admin.users.list({ role, page }),
  });
  return (
    <Section title="Staff" aside={can('iam:assign') && <GrantRole />}>
      <div className="mb-3 max-w-xs">
        <Select
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as AdminStaffRole)}
        >
          <Options values={STAFF} />
        </Select>
      </div>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>Nobody holds this role.</Empty>
          ) : (
            <>
              <Table head={['Name', 'Email', 'Roles', 'Status', '']}>
                {p.data.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link className="text-brand-700 hover:underline" to={`/users/${u.id}`}>
                        {u.fullName}
                      </Link>
                    </td>
                    <td>{u.email ?? '—'}</td>
                    <td>{u.roles.map(label).join(', ')}</td>
                    <td>
                      <Badge value={u.status} />
                    </td>
                    <td>
                      {can('iam:assign') && (
                        <ActionDialog
                          label={`Revoke ${label(role).toLowerCase()}`}
                          variant="danger"
                          title={`Revoke ${label(role).toLowerCase()} from ${u.fullName}`}
                          confirmLabel="Revoke"
                          onConfirm={(reason) => admin.users.revokeRole(u.id, role, reason)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </Section>
  );
}

export function RolesPage() {
  const roles = useQuery({ queryKey: ['iam', 'roles'], queryFn: () => admin.iam.roles() });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Roles & admins"
        subtitle="Nobody changes their own roles; only super admins grant super admin."
      />
      <StaffList />
      <Section title="Roles">
        <Loader query={roles}>
          {(list) => (
            <Table head={['Role', 'Holders', 'Permissions', '']}>
              {list.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="font-medium">{r.name}</span>
                    <div className="font-mono text-xs text-gray-500">{r.key}</div>
                    {r.description && <div className="text-xs text-gray-500">{r.description}</div>}
                  </td>
                  <td>{r.userCount}</td>
                  <td>
                    {open === r.id ? (
                      <ul className="grid grid-cols-1 gap-x-4 font-mono text-xs sm:grid-cols-2">
                        {r.permissions.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    ) : (
                      `${r.permissions.length} permissions`
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={cn('text-sm text-brand-700 underline')}
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                    >
                      {open === r.id ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Loader>
      </Section>
    </div>
  );
}

/* ------------------------------ audit log ------------------------------ */

export function AuditPage() {
  const [f, setF] = useState({
    action: '',
    targetType: '',
    targetId: '',
    actor: '',
    sensitivity: '',
    from: '',
    to: '',
  });
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['audit', f, page],
    queryFn: () =>
      admin.audit.list({
        action: f.action.trim() || undefined,
        targetType: f.targetType.trim() || undefined,
        targetId: f.targetId.trim() || undefined,
        actor: f.actor.trim() || undefined,
        sensitivity: (f.sensitivity || undefined) as 'NORMAL' | 'HIGH' | undefined,
        from: f.from ? new Date(f.from).toISOString() : undefined,
        to: f.to ? new Date(f.to).toISOString() : undefined,
        page,
      }),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value });
    setPage(1);
  };
  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Every admin action, newest first. ★ actions are high sensitivity."
      />
      <Filters>
        <Field
          label="Action (prefix)"
          placeholder="admin.refund"
          value={f.action}
          onChange={set('action')}
        />
        <Field
          label="Target type"
          placeholder="order, user, refund…"
          value={f.targetType}
          onChange={set('targetType')}
        />
        <Field label="Target id" value={f.targetId} onChange={set('targetId')} />
        <Field label="Actor (user id)" value={f.actor} onChange={set('actor')} />
        <Select label="Sensitivity" value={f.sensitivity} onChange={set('sensitivity')}>
          <Options values={['NORMAL', 'HIGH']} any="Any" />
        </Select>
        <Field label="From" type="date" value={f.from} onChange={set('from')} />
        <Field label="To" type="date" value={f.to} onChange={set('to')} />
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No audit entries match.</Empty>
          ) : (
            <>
              <Table head={['When', 'Action', 'Actor', 'Target', 'Reason', 'Before', 'After']}>
                {p.data.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap">{dateTime(a.createdAt)}</td>
                    <td>
                      <span className="font-mono text-xs">{a.action}</span>
                      {a.sensitivity === 'HIGH' && <Badge value="HIGH" className="ml-1" />}
                    </td>
                    <td>
                      {a.actor?.fullName ?? 'system'}
                      <div className="text-xs text-gray-500">
                        {a.actorRoles.map(label).join(', ')}
                      </div>
                    </td>
                    <td>
                      {a.target.type}
                      <div className="font-mono text-xs text-gray-500">
                        {a.target.id.slice(0, 13)}
                      </div>
                    </td>
                    <td>{a.reason ?? '—'}</td>
                    <td>
                      <Json value={a.before} />
                    </td>
                    <td>
                      <Json value={a.after} />
                    </td>
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

/* ------------------------------ failed jobs ------------------------------ */

const QUEUES = [
  'notifications',
  'orders',
  'dispatch',
  'payments',
  'refunds',
  'tracking',
  'payouts',
  'analytics',
  'maintenance',
  'files',
  'reports',
];

export function JobsPage() {
  const [queue, setQueue] = useState('');
  const q = useQuery({
    queryKey: ['jobs', queue],
    queryFn: () => admin.jobs.failed(queue || undefined),
  });
  return (
    <div>
      <PageHeader title="Failed jobs" subtitle="Background jobs that ran out of retries." />
      <Filters>
        <Select label="Queue" value={queue} onChange={(e) => setQueue(e.target.value)}>
          <option value="">All queues</option>
          {QUEUES.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Select>
      </Filters>
      <Loader query={q}>
        {(list) =>
          list.length === 0 ? (
            <Empty>No failed jobs.</Empty>
          ) : (
            <Table head={['Failed', 'Queue', 'Job', 'Attempts', 'Error', 'Data', '']}>
              {list.map((j) => (
                <tr key={`${j.queue}:${j.id}`}>
                  <td className="whitespace-nowrap">{dateTime(j.failedAt)}</td>
                  <td>{j.queue}</td>
                  <td>
                    {j.name}
                    <div className="font-mono text-xs text-gray-500">{j.id}</div>
                  </td>
                  <td>{j.attemptsMade}</td>
                  <td className="max-w-xs text-xs text-red-700">{j.failedReason ?? '—'}</td>
                  <td>
                    <Json value={j.data} />
                  </td>
                  <td>
                    <ActionDialog
                      label="Retry"
                      title={`Retry ${j.name}`}
                      confirmLabel="Retry job"
                      onConfirm={(reason) => admin.jobs.retry(j.queue, j.id, reason)}
                    />
                  </td>
                </tr>
              ))}
            </Table>
          )
        }
      </Loader>
    </div>
  );
}
