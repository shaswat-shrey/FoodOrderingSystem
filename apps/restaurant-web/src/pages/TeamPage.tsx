import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RestaurantRole } from '@fos/api-client';
import { Alert, Button, EmptyState, Spinner } from '@fos/ui';
import { Field, Section, Select, ServerError } from '../components/fields';
import { ROLE_LABEL } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

/** FR-RSTAFF-001/002: team list, invitations, role and access changes. */
export function TeamPage() {
  const { restaurant, can } = useWorkspace();
  const qc = useQueryClient();
  const rid = restaurant?.id;
  const members = useQuery({
    queryKey: ['team', rid],
    queryFn: () => merchant.staff.members(rid!),
    enabled: Boolean(rid && can('rest.staff:read')),
  });
  const invites = useQuery({
    queryKey: ['team', rid, 'invites'],
    queryFn: () => merchant.staff.invitations(rid!),
    enabled: Boolean(rid && can('rest.staff:read')),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['team', rid] });
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<RestaurantRole>('KITCHEN');
  const invite = useMutation({
    mutationFn: () =>
      merchant.staff.invite(rid!, {
        phone: phone.startsWith('+91') ? phone : `+91${phone}`,
        role,
        allBranches: true,
      }),
    onSuccess: () => {
      setPhone('');
      void refresh();
    },
  });
  const change = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
  });
  if (!restaurant) return null;
  if (!can('rest.staff:read'))
    return <EmptyState title="Ask your manager for access to the team page" />;
  if (!members.data) return <Spinner />;
  const manage = can('rest.staff:manage');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Team</h1>
      {manage && (
        <Section title="Invite someone">
          <form
            className="grid gap-2 md:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <Field
              label="Mobile number"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ''))}
              placeholder="98XXXXXXXX"
            />
            <Select
              label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as RestaurantRole)}
            >
              {(['MANAGER', 'ORDER_MANAGER', 'KITCHEN', 'STAFF'] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
            <div className="flex items-end">
              <Button type="submit" loading={invite.isPending}>
                Send invitation
              </Button>
            </div>
          </form>
          {invite.isSuccess && (
            <Alert tone="success" className="mt-2">
              Invitation sent by SMS.
            </Alert>
          )}
          <ServerError error={invite.error} />
        </Section>
      )}
      <Section title="Members">
        <ServerError error={change.error} />
        <ul className="divide-y divide-gray-100">
          {members.data.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p className="font-medium">
                  {m.name}{' '}
                  {m.status === 'SUSPENDED' && (
                    <span className="text-xs text-danger-600">suspended</span>
                  )}
                </p>
                <p className="text-sm text-gray-600">
                  {ROLE_LABEL[m.role]} · {m.phone ?? m.email} ·{' '}
                  {m.allBranches ? 'All outlets' : m.branches.map((b) => b.name).join(', ')}
                </p>
              </div>
              {manage && m.role !== 'OWNER' && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      change.mutate(() =>
                        merchant.staff.update(rid!, m.id, {
                          status: m.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
                        }),
                      )
                    }
                  >
                    {m.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (window.confirm(`Remove ${m.name} from the team?`))
                        change.mutate(() => merchant.staff.remove(rid!, m.id));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>
      {invites.data && invites.data.length > 0 && (
        <Section title="Pending invitations">
          <ul className="divide-y divide-gray-100 text-sm">
            {invites.data.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <span>
                  {i.phone ?? i.email} · {ROLE_LABEL[i.role]}
                </span>
                {manage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => change.mutate(() => merchant.staff.revoke(rid!, i.id))}
                  >
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
