import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fos/ui';
import { Section, ServerError } from '../components/ui';
import { day, rupees, STAGE_LABEL } from '../lib/format';
import { partner } from '../lib/partner';

/** API-DPDEL-013 (FR-DEL-037): past trips. */
export function HistoryPage() {
  const trips = useQuery({
    queryKey: ['partner', 'history'],
    queryFn: () => partner.deliveries.history({ limit: 50 }),
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Trips</h1>
      {trips.isPending && <Spinner />}
      <ServerError error={trips.error} />
      {trips.data && (
        <Section title={`${trips.data.length} recent`}>
          {trips.data.length === 0 ? (
            <p className="text-sm text-gray-600">No trips yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {trips.data.map((t) => (
                <li key={t.id} className="flex justify-between gap-2 py-2">
                  <span>
                    <span className="block text-gray-900">{t.restaurant}</span>
                    <span className="text-xs text-gray-500">
                      {day(t.date)} · {t.orderNumber} · {STAGE_LABEL[t.status] ?? t.status}
                      {t.distanceKm != null && ` · ${t.distanceKm} km`}
                    </span>
                  </span>
                  <span className="font-medium">{rupees(t.earning)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
