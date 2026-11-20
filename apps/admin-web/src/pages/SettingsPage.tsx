import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminSetting } from '@fos/api-client';
import { Alert, Button } from '@fos/ui';
import {
  ActionDialog,
  Empty,
  Field,
  Json,
  Loader,
  PageHeader,
  Pager,
  Table,
  TextArea,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime } from '../lib/format';
import { usePermissions } from '../lib/permissions';

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function History({ settingKey }: { settingKey: string }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['settings', settingKey, 'history', page],
    queryFn: () => admin.settings.history(settingKey, { page, pageSize: 10 }),
  });
  return (
    <Loader query={q}>
      {(p) =>
        p.data.length === 0 ? (
          <Empty>Never changed from the default.</Empty>
        ) : (
          <>
            <Table head={['When', 'By', 'From', 'To', 'Reason']}>
              {p.data.map((h) => (
                <tr key={h.id}>
                  <td>{dateTime(h.createdAt)}</td>
                  <td>{h.changedBy?.fullName ?? '—'}</td>
                  <td>
                    <Json value={h.oldValue} />
                  </td>
                  <td>
                    <Json value={h.newValue} />
                  </td>
                  <td>{h.reason ?? '—'}</td>
                </tr>
              ))}
            </Table>
            <Pager pagination={p.pagination} onPage={setPage} />
          </>
        )
      }
    </Loader>
  );
}

function SettingRow({ s, canWrite }: { s: AdminSetting; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(s.value, null, 2));
  const parsed = parse(text);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-gray-900">
            {s.key}
            {s.critical && (
              <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-800">
                critical
              </span>
            )}
          </p>
          <p className="text-sm text-gray-600">{s.description}</p>
          {!editing && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Json value={s.value} />
              {JSON.stringify(s.value) !== JSON.stringify(s.default) && (
                <span className="text-xs text-gray-500">default: {JSON.stringify(s.default)}</span>
              )}
            </div>
          )}
          {s.storedValueInvalid && (
            <Alert tone="warning" className="mt-1">
              The stored value no longer matches its schema; the default is in effect.
            </Alert>
          )}
          {s.updatedAt && (
            <p className="mt-1 text-xs text-gray-500">Updated {dateTime(s.updatedAt)}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide history' : 'History'}
          </Button>
          {canWrite && !editing && (
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Edit ${s.key}`}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 space-y-2">
          <TextArea
            label={`Value of ${s.key} (JSON)`}
            rows={Math.min(10, text.split('\n').length + 1)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            hint={parsed.ok ? undefined : 'This isn’t valid JSON.'}
          />
          <div className="flex gap-2">
            <ActionDialog
              label="Save"
              variant="primary"
              title={`Change ${s.key}`}
              description={
                s.critical ? 'A critical setting: only a super admin can change it.' : undefined
              }
              confirmLabel="Save setting"
              disabled={!parsed.ok}
              onConfirm={(reason) =>
                admin.settings.update(s.key, parsed.ok ? parsed.value : null, reason)
              }
              onDone={() => setEditing(false)}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(JSON.stringify(s.value, null, 2));
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {showHistory && (
        <div className="mt-2">
          <History settingKey={s.key} />
        </div>
      )}
    </li>
  );
}

export function SettingsPage() {
  const { can } = usePermissions();
  const [filter, setFilter] = useState('');
  const q = useQuery({ queryKey: ['settings'], queryFn: () => admin.settings.list() });
  return (
    <div>
      <PageHeader
        title="Platform settings"
        subtitle="Each change is validated, versioned and audited."
      />
      <div className="mb-3 max-w-sm">
        <Field
          label="Filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <Loader query={q}>
        {(list) => {
          const shown = list.filter((s) =>
            `${s.key} ${s.description}`.toLowerCase().includes(filter.trim().toLowerCase()),
          );
          return shown.length === 0 ? (
            <Empty>No settings match.</Empty>
          ) : (
            <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white px-4">
              {shown.map((s) => (
                <SettingRow
                  key={`${s.key}:${s.updatedAt ?? ''}`}
                  s={s}
                  canWrite={can('settings:write')}
                />
              ))}
            </ul>
          );
        }}
      </Loader>
    </div>
  );
}
