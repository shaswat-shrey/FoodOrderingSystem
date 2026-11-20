import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { AdminUserStatus } from '@fos/api-client';
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
import { dateTime, label, rupees, toPaise } from '../lib/format';
import { usePermissions } from '../lib/permissions';

const USER_STATUSES: AdminUserStatus[] = [
  'ACTIVE',
  'PENDING_VERIFICATION',
  'SUSPENDED',
  'DEACTIVATED',
  'ANONYMIZED',
];
const ROLES = [
  'CUSTOMER',
  'RESTAURANT_OWNER',
  'DELIVERY_PARTNER',
  'SUPPORT_AGENT',
  'ADMIN',
  'SUPER_ADMIN',
];

export function UsersPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['users', search, status, role, page],
    queryFn: () =>
      admin.users.list({
        q: search.trim() || undefined,
        status: (status || undefined) as AdminUserStatus | undefined,
        role: role || undefined,
        page,
      }),
  });
  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Contact details are masked; reveal them from a user’s page."
      />
      <Filters>
        <Field
          label="Search"
          type="search"
          placeholder="Name, phone or email"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={USER_STATUSES} any="Any status" />
        </Select>
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          <Options values={ROLES} any="Any role" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No users match.</Empty>
          ) : (
            <>
              <Table head={['Name', 'Phone', 'Email', 'Roles', 'Status', 'Joined']}>
                {p.data.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link
                        to={`/users/${u.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {u.fullName}
                      </Link>
                    </td>
                    <td>{u.phone ?? '—'}</td>
                    <td>{u.email ?? '—'}</td>
                    <td>{u.roles.map(label).join(', ')}</td>
                    <td>
                      <Badge value={u.status} />
                    </td>
                    <td>{dateTime(u.createdAt)}</td>
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

export function UserPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['users', id], queryFn: () => admin.users.get(id) });
  const [revealed, setRevealed] = useState<{ phone: string | null; email: string | null } | null>(
    null,
  );
  const [until, setUntil] = useState('');
  const [amount, setAmount] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const paise = toPaise(amount);

  return (
    <Loader query={q}>
      {(u) => (
        <div className="space-y-4">
          <PageHeader
            back={{ to: '/users', label: 'Users' }}
            title={u.fullName}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={u.status} /> {u.roles.map(label).join(', ')} · joined{' '}
                {dateTime(u.createdAt)}
              </span>
            }
            actions={
              <>
                {u.status === 'SUSPENDED' ? (
                  <ActionDialog
                    label="Lift suspension"
                    confirmLabel="Lift suspension"
                    onConfirm={(reason) => admin.users.unsuspend(id, reason)}
                  />
                ) : (
                  <ActionDialog
                    label="Suspend"
                    variant="danger"
                    title={`Suspend ${u.fullName}`}
                    description="Blocks sign-in, ends every session and takes a partner offline."
                    confirmLabel="Suspend"
                    disabled={u.status === 'ANONYMIZED'}
                    onConfirm={(reason) =>
                      admin.users.suspend(
                        id,
                        reason,
                        until ? new Date(until).toISOString() : undefined,
                      )
                    }
                  >
                    <Field
                      label="Until (optional)"
                      type="datetime-local"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  </ActionDialog>
                )}
                <ActionDialog
                  label="Sign out everywhere"
                  confirmLabel="Sign out everywhere"
                  onConfirm={(reason) => admin.users.logoutAll(id, reason)}
                  onDone={(r) => setMessage(`${r.sessionsRevoked} sessions ended.`)}
                />
              </>
            }
          />
          {message && <Alert tone="success">{message}</Alert>}
          {u.suspension && (
            <Alert tone="warning" title="Suspended">
              {u.suspension.reason ?? 'No reason recorded'}
              {u.suspension.until ? ` · until ${dateTime(u.suspension.until)}` : ''}
            </Alert>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Section
              title="Contact"
              aside={
                can('pii:reveal') &&
                !revealed && (
                  <ActionDialog
                    label="Reveal"
                    title="Reveal contact details"
                    description="Unmasked phone and email are shown once and the view is audited."
                    confirmLabel="Reveal"
                    onConfirm={(reason) => admin.users.revealPii(id, reason)}
                    onDone={(r) => setRevealed({ phone: r.phone, email: r.email })}
                  />
                )
              }
            >
              <Facts
                items={[
                  ['Phone', `${revealed?.phone ?? u.phone ?? '—'}${u.phoneVerified ? ' ✓' : ''}`],
                  ['Email', `${revealed?.email ?? u.email ?? '—'}${u.emailVerified ? ' ✓' : ''}`],
                  ['Active sessions', u.activeSessions],
                  ['Orders', `${u.orders.delivered} delivered of ${u.orders.total}`],
                  [
                    'Deletion scheduled',
                    u.deletionScheduledAt ? dateTime(u.deletionScheduledAt) : '—',
                  ],
                ]}
              />
            </Section>
            <Section
              title="Wallet"
              aside={
                can('wallet:adjust') && (
                  <ActionDialog
                    label="Adjust wallet"
                    title="Adjust wallet"
                    description="A positive amount credits the customer; a negative one debits."
                    confirmLabel="Post adjustment"
                    ready={Number.isFinite(paise) && paise !== 0}
                    onConfirm={(reason) =>
                      admin.users.adjustWallet(id, {
                        amount: paise,
                        reason,
                        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
                      })
                    }
                    onDone={(r) => {
                      setAmount('');
                      setMessage(`Wallet adjusted; balance ${rupees(r.availableAmount)}.`);
                    }}
                  >
                    <Field
                      label="Amount (₹)"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      hint="Up to ±₹10,000."
                    />
                    <Field
                      label="Credit expires (optional)"
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                    />
                  </ActionDialog>
                )
              }
            >
              <Facts
                items={[
                  ['Available', rupees(u.wallet.availableAmount)],
                  ['Held', rupees(u.wallet.heldAmount)],
                ]}
              />
            </Section>
            <Section
              title="Cash on delivery"
              aside={
                can('user:flags') && (
                  <ActionDialog
                    label={u.flags.codBlocked ? 'Allow COD' : 'Block COD'}
                    variant={u.flags.codBlocked ? 'secondary' : 'danger'}
                    confirmLabel={u.flags.codBlocked ? 'Allow COD' : 'Block COD'}
                    onConfirm={(reason) => admin.users.setCodBlock(id, !u.flags.codBlocked, reason)}
                  />
                )
              }
            >
              <Facts
                items={[
                  ['COD', u.flags.codBlocked ? 'Blocked' : 'Allowed'],
                  ['Refused COD orders', u.flags.codRefusalCount],
                ]}
              />
            </Section>
            <Section title="Linked accounts">
              <Facts
                items={[
                  [
                    'Delivery partner',
                    u.partner ? (
                      <Link
                        key="p"
                        className="text-brand-700 hover:underline"
                        to={`/partners/${u.partner.id}`}
                      >
                        {label(u.partner.onboardingStatus)} · {label(u.partner.status)}
                      </Link>
                    ) : (
                      '—'
                    ),
                  ],
                  ...u.restaurants.map(
                    (r) =>
                      [
                        `${label(r.role)} at`,
                        <Link
                          key={r.id}
                          className="text-brand-700 hover:underline"
                          to={`/restaurants/${r.id}`}
                        >
                          {r.brandName}
                        </Link>,
                      ] as [string, ReactNode],
                  ),
                ]}
              />
            </Section>
          </div>
        </div>
      )}
    </Loader>
  );
}
