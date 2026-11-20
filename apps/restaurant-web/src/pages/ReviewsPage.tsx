import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { BranchReview, ReviewReportReason } from '@fos/api-client';
import { Alert, Button, EmptyState, Spinner } from '@fos/ui';
import { Select, ServerError } from '../components/fields';
import { day, label } from '../lib/format';
import { merchant } from '../lib/merchant';
import { useWorkspace } from '../lib/workspace';

const REASONS: [ReviewReportReason, string][] = [
  ['SPAM', 'Spam'],
  ['ABUSIVE', 'Abusive'],
  ['IRRELEVANT', 'Not about this restaurant'],
  ['FAKE', 'Looks fake'],
  ['OTHER', 'Other'],
];

/** FR-RREV-001…004 (API-RREV-001…004): reviews of the selected outlet, responses and reports. */
export function ReviewsPage() {
  const { branchId, can } = useWorkspace();
  const [rating, setRating] = useState('');
  const [responded, setResponded] = useState('');
  const filter = {
    ...(rating ? { rating: Number(rating) } : {}),
    ...(responded ? { responded: responded === 'yes' } : {}),
  };
  const reviews = useInfiniteQuery({
    queryKey: ['reviews', branchId, filter],
    queryFn: ({ pageParam }) =>
      merchant.reviews.list(branchId!, {
        ...filter,
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(branchId),
  });
  if (!branchId) return <EmptyState title="No outlet selected" />;
  if (!can('rest.review:read'))
    return <EmptyState title="Ask your manager for access to reviews" />;
  const list = reviews.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Reviews</h1>
      <div className="grid max-w-lg grid-cols-2 gap-2">
        <Select label="Rating" value={rating} onChange={(e) => setRating(e.target.value)}>
          <option value="">All ratings</option>
          {[5, 4, 3, 2, 1].map((r) => (
            <option key={r} value={r}>
              {r} ★
            </option>
          ))}
        </Select>
        <Select label="Response" value={responded} onChange={(e) => setResponded(e.target.value)}>
          <option value="">All reviews</option>
          <option value="no">Not responded</option>
          <option value="yes">Responded</option>
        </Select>
      </div>
      <ServerError error={reviews.error} />
      {reviews.isPending ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyState title="No reviews here yet" />
      ) : (
        <ul className="space-y-3">
          {list.map((r) => (
            <li key={r.id}>
              <ReviewCard review={r} canRespond={can('rest.review:respond')} />
            </li>
          ))}
        </ul>
      )}
      {reviews.hasNextPage && (
        <Button
          variant="secondary"
          loading={reviews.isFetchingNextPage}
          onClick={() => void reviews.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

function ReviewCard({ review, canRespond }: { review: BranchReview; canRespond: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.response?.text ?? '');
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState<ReviewReportReason>('SPAM');
  const [note, setNote] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['reviews'] });
  const respond = useMutation({
    mutationFn: () =>
      review.response
        ? merchant.reviews.editResponse(review.id, text.trim())
        : merchant.reviews.respond(review.id, text.trim()),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const report = useMutation({
    mutationFn: () =>
      merchant.reviews.report(review.id, { reason, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => setReporting(false),
  });
  const r = review.response;
  const writing = canRespond && (editing || !r);

  return (
    <article
      aria-label={`Review from ${review.author}`}
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p>
          <span className="font-semibold" aria-label={`${review.rating} out of 5 stars`}>
            {'★'.repeat(review.rating)}
            <span className="text-gray-300">{'★'.repeat(5 - review.rating)}</span>
          </span>{' '}
          <span className="font-medium">{review.author}</span>
          <span className="text-sm text-gray-600">
            {' '}
            · order {review.orderNumber} · {day(review.createdAt)}
          </span>
        </p>
        {review.status === 'HIDDEN' && (
          <span className="text-xs text-gray-600">Hidden by moderators</span>
        )}
      </header>
      {review.text && <p className="mt-2 text-sm">{review.text}</p>}
      {review.tags.length > 0 && (
        <p className="mt-1 text-xs text-gray-600">{review.tags.map(label).join(' · ')}</p>
      )}

      {r && !editing && (
        <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm">
          <p className="font-medium">Your response</p>
          <p className="mt-1">{r.text}</p>
          {canRespond &&
            (r.editable ? (
              <Button size="sm" variant="ghost" className="mt-1" onClick={() => setEditing(true)}>
                Edit response
              </Button>
            ) : (
              <p className="mt-1 text-xs text-gray-600">
                Responses can be edited for 24 hours after posting.
              </p>
            ))}
        </div>
      )}

      {writing && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim().length >= 2) respond.mutate();
          }}
        >
          <label className="block text-sm">
            <span className="font-medium">{r ? 'Edit your response' : 'Respond publicly'}</span>
            <textarea
              value={text}
              maxLength={1000}
              onChange={(e) => setText(e.target.value)}
              className="mt-1 block min-h-20 w-full rounded-md border border-gray-300 px-3 py-2"
            />
          </label>
          {!r && (
            <p className="text-xs text-gray-600">
              One response per review. You can edit it for 24 hours.
            </p>
          )}
          <ServerError error={respond.error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={text.trim().length < 2}
              loading={respond.isPending}
            >
              {r ? 'Save response' : 'Post response'}
            </Button>
            {r && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      {canRespond && (
        <div className="mt-3 text-sm">
          {report.isSuccess ? (
            <Alert tone="success">Reported. Our moderators will take a look.</Alert>
          ) : reporting ? (
            <div className="flex flex-wrap items-end gap-2">
              <label>
                <span className="block font-medium">Why report it?</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as ReviewReportReason)}
                  className="mt-1 h-9 rounded border border-gray-300 px-2"
                >
                  {REASONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="block font-medium">Note (optional)</span>
                <input
                  value={note}
                  maxLength={300}
                  onChange={(e) => setNote(e.target.value)}
                  className="mt-1 h-9 rounded border border-gray-300 px-2"
                />
              </label>
              <Button
                size="sm"
                variant="danger"
                loading={report.isPending}
                onClick={() => report.mutate()}
              >
                Send report
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReporting(false)}>
                Cancel
              </Button>
              <ServerError error={report.error} />
            </div>
          ) : (
            <button
              type="button"
              className="text-gray-600 underline"
              onClick={() => setReporting(true)}
            >
              Report this review
            </button>
          )}
        </div>
      )}
    </article>
  );
}
