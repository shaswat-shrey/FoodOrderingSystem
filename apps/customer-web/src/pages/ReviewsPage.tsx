import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { isApiClientError, type MyReview } from '@fos/api-client';
import { Button, EmptyState, ErrorState, Spinner } from '@fos/ui';
import {
  ConfirmDialog,
  LoadMore,
  PageTitle,
  StarRating,
  Stars,
  TagPicker,
} from '../components/account-ui';
import { PARTNER_TAGS, RESTAURANT_TAGS } from '../components/OrderAfterCare';
import { ServerError, TextArea } from '../components/ui';
import { customer } from '../lib/customer';
import { day, dayTime } from '../lib/format';
import { useIdempotencyKey } from '../lib/idempotency';

const reviewsKey = ['reviews', 'mine'];
const tagLabel = (r: MyReview, tag: string) =>
  (r.target === 'PARTNER'
    ? (PARTNER_TAGS as Record<string, string>)[tag]
    : (RESTAURANT_TAGS as Record<string, string>)[tag]) ?? tag;

/** My reviews (API-REV-004): edit within 48 h (BR-REVIEW-003), delete any time. */
export function ReviewsPage() {
  const reviews = useInfiniteQuery({
    queryKey: reviewsKey,
    queryFn: ({ pageParam }) => customer.reviews.mine(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = reviews.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div>
      <PageTitle>Your reviews</PageTitle>
      {reviews.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner label="Loading reviews" />
        </div>
      ) : reviews.isError ? (
        <ErrorState
          title="Couldn’t load your reviews"
          description={reviews.error.message}
          action={<Button onClick={() => void reviews.refetch()}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No reviews yet"
          description="Rate a delivered order to help others choose."
        />
      ) : (
        <ul className="space-y-3" aria-label="Reviews">
          {rows.map((r) => (
            <ReviewCard key={r.id} review={r} />
          ))}
        </ul>
      )}
      <LoadMore
        hasMore={Boolean(reviews.hasNextPage)}
        loading={reviews.isFetchingNextPage}
        onClick={() => void reviews.fetchNextPage()}
      />
    </div>
  );
}

function ReviewCard({ review: r }: { review: MyReview }) {
  const qc = useQueryClient();
  const key = useIdempotencyKey();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState({ rating: r.rating, text: r.text ?? '', tags: r.tags });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [closed, setClosed] = useState(false);
  const editable = r.editable && !closed && Date.parse(r.editableUntil) > Date.now();
  const title = r.target === 'PARTNER' ? 'Delivery' : (r.restaurant ?? 'Restaurant');

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { rating: form.rating, text: form.text.trim() || null, tags: form.tags };
    setBusy(true);
    setError(null);
    try {
      await customer.reviews.edit(r.id, body, key(`${r.id}:${JSON.stringify(body)}`));
      setEditing(false);
      void qc.invalidateQueries({ queryKey: reviewsKey });
    } catch (err) {
      if (isApiClientError(err) && err.code === 'REVIEW_EDIT_WINDOW_CLOSED') {
        setClosed(true);
        setEditing(false);
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await customer.reviews.remove(r.id, key(`delete:${r.id}`));
      setDeleting(false);
      void qc.invalidateQueries({ queryKey: reviewsKey });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900">{title}</p>
          <p className="text-xs text-gray-500">
            <Link to={`/orders/${r.orderId}`} className="underline">
              Order {r.orderNumber ?? ''}
            </Link>{' '}
            · {dayTime(r.createdAt)}
            {r.status !== 'PUBLISHED' && ` · ${r.status.toLowerCase()}`}
          </p>
        </div>
        <Stars rating={r.rating} />
      </div>
      {editing ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={save}
          noValidate
          aria-label={`Edit review of ${title}`}
        >
          <StarRating
            legend="Your rating"
            value={form.rating}
            onChange={(rating) => setForm({ ...form, rating })}
          />
          <TagPicker
            legend="Tags"
            options={
              (r.target === 'PARTNER' ? PARTNER_TAGS : RESTAURANT_TAGS) as Record<string, string>
            }
            value={form.tags}
            onChange={(tags) => setForm({ ...form, tags })}
          />
          <TextArea
            label="Your review"
            maxLength={1000}
            value={form.text}
            onChange={(e) => setForm({ ...form, text: e.target.value })}
          />
          <ServerError error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save changes
            </Button>
          </div>
        </form>
      ) : (
        <>
          {r.text && <p className="mt-2 text-sm text-gray-800">{r.text}</p>}
          {r.tags.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1" aria-label="Tags">
              {r.tags.map((t) => (
                <li key={t} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                  {tagLabel(r, t)}
                </li>
              ))}
            </ul>
          )}
          {r.response && (
            <p className="mt-2 rounded-lg bg-gray-50 p-2 text-sm text-gray-700">
              <span className="font-medium">Restaurant replied:</span> {r.response.text}
            </p>
          )}
          {!deleting && <ServerError error={error} />}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {editable ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <span className="text-xs text-gray-500">
                  You can edit until {day(r.editableUntil)}
                </span>
              </>
            ) : (
              <span className="text-xs text-gray-500">The 48-hour editing window has passed.</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setError(null);
                setDeleting(true);
              }}
            >
              Delete
            </Button>
          </div>
        </>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this review?"
          confirmLabel="Delete review"
          busy={busy}
          error={error}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(false)}
        >
          <p>Your rating and comments will be removed. This can’t be undone.</p>
        </ConfirmDialog>
      )}
    </li>
  );
}
