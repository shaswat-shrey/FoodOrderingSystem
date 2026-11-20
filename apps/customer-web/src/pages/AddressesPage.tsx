import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address } from '@fos/api-client';
import { Button, EmptyState, ErrorState, Spinner } from '@fos/ui';
import { AddressForm } from '../components/AddressForm';
import { ConfirmDialog, PageTitle } from '../components/account-ui';
import { Dialog, ServerError } from '../components/ui';
import { customer } from '../lib/customer';

const LABEL: Record<Address['label'], string> = { HOME: 'Home', WORK: 'Work', OTHER: 'Other' };
const addressesKey = ['addresses'];

/** Saved addresses: list, add, edit, delete, default (FR-ADDR-001…005). */
export function AddressesPage() {
  const qc = useQueryClient();
  const addresses = useQuery({
    queryKey: [...addressesKey, null],
    queryFn: () => customer.addresses.list(),
  });
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const [removing, setRemoving] = useState<Address | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: addressesKey });

  async function makeDefault(a: Address) {
    setBusy(a.id);
    setError(null);
    try {
      await customer.addresses.setDefault(a.id);
      qc.setQueryData<Address[]>([...addressesKey, null], (list) =>
        list?.map((x) => ({ ...x, isDefault: x.id === a.id })),
      );
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function remove(a: Address) {
    setBusy(a.id);
    setError(null);
    try {
      await customer.addresses.remove(a.id);
      setRemoving(null);
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageTitle aside={<Button onClick={() => setEditing('new')}>Add address</Button>}>
        Addresses
      </PageTitle>
      {!removing && <ServerError error={error} />}
      {addresses.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner label="Loading addresses" />
        </div>
      ) : addresses.isError ? (
        <ErrorState
          title="Couldn’t load your addresses"
          description={addresses.error.message}
          action={<Button onClick={() => void addresses.refetch()}>Try again</Button>}
        />
      ) : addresses.data.length === 0 ? (
        <EmptyState title="No saved addresses" description="Save an address to check out faster." />
      ) : (
        <ul className="space-y-3" aria-label="Saved addresses">
          {addresses.data.map((a) => (
            <li
              key={a.id}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
              aria-label={`${LABEL[a.label]}: ${a.line1}`}
            >
              <div className="flex items-center gap-2">
                <p className="font-semibold text-gray-900">{a.customLabel ?? LABEL[a.label]}</p>
                {a.isDefault && (
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800">
                    Default
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-700">
                {[a.line1, a.line2, a.landmark, a.area, a.city, a.pincode]
                  .filter(Boolean)
                  .join(', ')}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(a)}>
                  Edit
                </Button>
                {!a.isDefault && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === a.id && !removing}
                    onClick={() => void makeDefault(a)}
                  >
                    Set as default
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    setRemoving(a);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <Dialog
          title={editing === 'new' ? 'Add address' : 'Edit address'}
          onClose={() => setEditing(null)}
        >
          <AddressForm
            address={editing === 'new' ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              refresh();
            }}
          />
        </Dialog>
      )}
      {removing && (
        <ConfirmDialog
          title="Delete this address?"
          confirmLabel="Delete address"
          busy={busy === removing.id}
          error={error}
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        >
          <p>
            {removing.line1}, {removing.area} will be removed from your saved addresses.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
