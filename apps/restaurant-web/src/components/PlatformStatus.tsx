import { useReadiness } from '@fos/api-client';
import { Button, Card, Spinner } from '@fos/ui';
import { api } from '../lib/api';

const LABEL = {
  ok: { text: 'All systems operational', tone: 'text-success-600' },
  degraded: { text: 'Running with reduced capacity', tone: 'text-warning-600' },
  unavailable: { text: 'Service unavailable', tone: 'text-danger-600' },
} as const;

/** Live platform status from GET /health/ready (API-SYS-002). */
export function PlatformStatus() {
  const { data, isPending, isError, refetch, isFetching } = useReadiness(api);

  return (
    <Card aria-live="polite">
      <h2 className="text-sm font-semibold text-gray-500">Platform status</h2>
      {isPending ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-gray-600">
          <Spinner label="Checking platform status" /> Checking…
        </p>
      ) : isError ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-sm text-danger-600">Can’t reach the server.</p>
          <Button size="sm" variant="secondary" loading={isFetching} onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <p className={`mt-2 text-base font-semibold ${LABEL[data.status].tone}`}>
            {LABEL[data.status].text}
          </p>
          <ul className="mt-3 space-y-1 text-sm text-gray-600">
            {Object.entries(data.checks).map(([name, check]) => (
              <li key={name} className="flex justify-between gap-4">
                <span>{name}</span>
                <span className={check.status === 'up' ? 'text-success-600' : 'text-danger-600'}>
                  {check.status}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
