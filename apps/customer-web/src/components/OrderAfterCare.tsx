import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type {
  CustomerOrderDetails,
  OrderIssue,
  OrderIssueType,
  PartnerReviewTag,
  RestaurantReviewTag,
  ReviewSubmission,
} from '@fos/api-client';
import { Alert, Button } from '@fos/ui';
import { customer } from '../lib/customer';
import { useIdempotencyKey } from '../lib/idempotency';
import { useReorder } from '../lib/reorder';
import { PhotoPicker, StarRating, TagPicker } from './account-ui';
import { Dialog, QuantityStepper, Section, Select, ServerError, TextArea } from './ui';

export const RESTAURANT_TAGS: Record<RestaurantReviewTag, string> = {
  TASTE: 'Taste',
  PORTION: 'Portion size',
  PACKAGING: 'Packaging',
  VALUE: 'Value for money',
};
export const PARTNER_TAGS: Record<PartnerReviewTag, string> = {
  POLITE: 'Polite',
  ON_TIME: 'On time',
  FOLLOWED_INSTRUCTIONS: 'Followed instructions',
  RUDE: 'Rude',
  LATE: 'Late',
};
const ISSUE_TYPES: Record<OrderIssueType, string> = {
  MISSING_ITEM: 'Item missing',
  WRONG_ITEM: 'Wrong item',
  QUALITY: 'Food quality',
  SPILLAGE: 'Spilled or damaged',
  LATE: 'Arrived late',
  PAYMENT: 'Payment or charges',
  OTHER: 'Something else',
};
const ITEM_ISSUES = new Set<OrderIssueType>(['MISSING_ITEM', 'WRONG_ITEM', 'QUALITY', 'SPILLAGE']);
const ACTIVE = new Set(['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP']);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** BR-REVIEW-001 (review.windowDays) and BR-SUP-002 (support.issueWindowHours) defaults. */
const REVIEW_WINDOW_DAYS = 7;
const ISSUE_WINDOW_HOURS = 48;

/**
 * After-order actions on the order page (FR-CORD-008…011, FR-REV-001): invoice,
 * reorder, report an issue and rate the order.
 */
export function OrderAfterCare({
  order,
  hasPartner,
}: {
  order: CustomerOrderDetails;
  hasPartner: boolean;
}) {
  const [dialog, setDialog] = useState<'rate' | 'issue' | null>(null);
  const [issue, setIssue] = useState<OrderIssue | null>(null);
  const [rated, setRated] = useState(false);
  const { reorder, busy, outcome, prompt } = useReorder();
  const delivered = order.status === 'DELIVERED';
  const since = order.deliveredAt ? Date.now() - Date.parse(order.deliveredAt) : Infinity;
  const canRate = delivered && !order.reviewed && !rated && since <= REVIEW_WINDOW_DAYS * DAY;
  const canReport = ACTIVE.has(order.status) || (delivered && since <= ISSUE_WINDOW_HOURS * HOUR);
  const ended = delivered || ['CANCELLED', 'REJECTED', 'FAILED'].includes(order.status);
  if (!ended && !canReport) return null;

  return (
    <Section title="Need anything else?">
      <div className="space-y-3">
        {issue && (
          <Alert tone="success" title="Thanks for letting us know">
            {issue.refund?.status === 'APPROVED'
              ? 'Your refund was approved to your wallet.'
              : 'Our support team will get back to you.'}{' '}
            {issue.ticket && (
              <Link
                to={`/help/tickets/${issue.ticket.id}`}
                className="font-medium text-brand-700 underline"
              >
                View ticket {issue.ticket.number}
              </Link>
            )}
          </Alert>
        )}
        {rated && <Alert tone="success">Thanks for your feedback!</Alert>}
        <div className="flex flex-wrap gap-2">
          {canRate && <Button onClick={() => setDialog('rate')}>Rate this order</Button>}
          {ended && (
            <Button
              variant="secondary"
              loading={busy === order.id}
              onClick={() => void reorder(order.id)}
            >
              Reorder
            </Button>
          )}
          {order.invoiceAvailable && <InvoiceButton order={order} />}
          {canReport && (
            <Button variant="secondary" onClick={() => setDialog('issue')}>
              Report an issue
            </Button>
          )}
          <Link
            to={`/help?orderId=${order.id}`}
            className="inline-flex h-11 items-center rounded-lg px-3 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            Get help
          </Link>
        </div>
        {outcome(order.id)}
      </div>
      {dialog === 'rate' && (
        <RateOrderDialog
          order={order}
          hasPartner={hasPartner}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setRated(true);
          }}
        />
      )}
      {dialog === 'issue' && (
        <ReportIssueDialog
          order={order}
          onClose={() => setDialog(null)}
          onDone={(i) => {
            setDialog(null);
            setIssue(i);
          }}
        />
      )}
      {prompt}
    </Section>
  );
}

function InvoiceButton({ order }: { order: CustomerOrderDetails }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <Button
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const blob = await customer.orders.invoice(order.id);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `invoice-${order.number}.pdf`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Download invoice
      </Button>
      {error != null && (
        <div className="w-full">
          <ServerError error={error} />
        </div>
      )}
    </>
  );
}

/** API-REV-001: restaurant (stars, tags, text, ≤ 3 photos) and partner (stars, tags). */
function RateOrderDialog({
  order,
  hasPartner,
  onClose,
  onDone,
}: {
  order: CustomerOrderDetails;
  hasPartner: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const key = useIdempotencyKey();
  const [food, setFood] = useState({ rating: 0, tags: [] as RestaurantReviewTag[], text: '' });
  const [photos, setPhotos] = useState<{ id: string; name: string }[]>([]);
  const [partner, setPartner] = useState({ rating: 0, tags: [] as PartnerReviewTag[] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (food.rating === 0 && partner.rating === 0) {
      setError(new Error('Choose a star rating for the food or the delivery.'));
      return;
    }
    const body: ReviewSubmission = {};
    if (food.rating > 0)
      body.restaurant = {
        rating: food.rating,
        ...(food.tags.length ? { tags: food.tags } : {}),
        ...(food.text.trim() ? { text: food.text.trim() } : {}),
        ...(photos.length ? { photoFileIds: photos.map((p) => p.id) } : {}),
      };
    if (partner.rating > 0)
      body.partner = {
        rating: partner.rating,
        ...(partner.tags.length ? { tags: partner.tags } : {}),
      };
    setBusy(true);
    setError(null);
    try {
      await customer.reviews.submit(order.id, body, key(JSON.stringify(body)));
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
      void qc.invalidateQueries({ queryKey: ['reviews'] });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Rate your order" onClose={onClose}>
      <form className="space-y-4" onSubmit={submit} noValidate aria-label="Rate your order">
        <section className="space-y-3" aria-label="Food">
          <StarRating
            legend={`How was the food from ${order.restaurant.name}?`}
            value={food.rating}
            onChange={(rating) => setFood({ ...food, rating })}
          />
          {food.rating > 0 && (
            <>
              <TagPicker
                legend="What stood out?"
                options={RESTAURANT_TAGS}
                value={food.tags}
                max={4}
                onChange={(tags) => setFood({ ...food, tags })}
              />
              <TextArea
                label="Tell others about it (optional)"
                maxLength={1000}
                value={food.text}
                onChange={(e) => setFood({ ...food, text: e.target.value })}
              />
              <PhotoPicker
                label="Add photos (optional)"
                purpose="REVIEW_PHOTO"
                value={photos}
                onChange={setPhotos}
              />
            </>
          )}
        </section>
        {hasPartner && (
          <section className="space-y-3 border-t border-gray-100 pt-3" aria-label="Delivery">
            <StarRating
              legend="How was the delivery?"
              value={partner.rating}
              onChange={(rating) => setPartner({ ...partner, rating })}
            />
            {partner.rating > 0 && (
              <TagPicker
                legend="About your delivery partner"
                options={PARTNER_TAGS}
                value={partner.tags}
                onChange={(tags) => setPartner({ ...partner, tags })}
              />
            )}
          </section>
        )}
        <ServerError error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button type="submit" loading={busy}>
            Submit rating
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** API-ORD-011 (FR-CORD-010/011): what went wrong, which items, optional photos. */
function ReportIssueDialog({
  order,
  onClose,
  onDone,
}: {
  order: CustomerOrderDetails;
  onClose: () => void;
  onDone: (issue: OrderIssue) => void;
}) {
  const key = useIdempotencyKey();
  const [type, setType] = useState<OrderIssueType>('MISSING_ITEM');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [description, setDescription] = useState('');
  const [refund, setRefund] = useState(true);
  const [photos, setPhotos] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [descError, setDescError] = useState<string | undefined>();
  const itemIssue = ITEM_ISSUES.has(type);
  const items = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (description.trim().length < 10) {
      setDescError('Tell us a little more (at least 10 characters).');
      return;
    }
    setDescError(undefined);
    if (itemIssue && items.length === 0) {
      setError(new Error('Choose the items that had a problem.'));
      return;
    }
    const body = {
      type,
      description: description.trim(),
      ...(itemIssue ? { items, requestRefund: refund } : {}),
      ...(photos.length ? { photoFileIds: photos.map((p) => p.id) } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      onDone(await customer.orders.reportIssue(order.id, body, key(JSON.stringify(body))));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Report an issue" onClose={onClose}>
      <form className="space-y-4" onSubmit={submit} noValidate aria-label="Report an issue">
        <Select
          label="What went wrong?"
          value={type}
          onChange={(e) => setType(e.target.value as OrderIssueType)}
        >
          {(Object.keys(ISSUE_TYPES) as OrderIssueType[]).map((t) => (
            <option key={t} value={t}>
              {ISSUE_TYPES[t]}
            </option>
          ))}
        </Select>
        {itemIssue && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-800">Which items?</legend>
            <ul className="mt-1 space-y-2">
              {order.items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {i.itemName}
                    <span className="text-gray-500"> (ordered {i.quantity})</span>
                  </span>
                  <QuantityStepper
                    label={i.itemName}
                    value={qty[i.id] ?? 0}
                    max={i.quantity}
                    onChange={(n) => setQty({ ...qty, [i.id]: n })}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <TextArea
          label="Describe the problem"
          value={description}
          maxLength={1000}
          error={descError}
          onChange={(e) => setDescription(e.target.value)}
        />
        {itemIssue && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={refund}
              onChange={(e) => setRefund(e.target.checked)}
            />
            Request a refund for these items
          </label>
        )}
        <PhotoPicker
          label="Add photos (optional)"
          purpose="SUPPORT_ATTACHMENT"
          value={photos}
          onChange={setPhotos}
        />
        <ServerError error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Send report
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
