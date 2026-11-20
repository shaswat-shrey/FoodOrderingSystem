import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import type { OnboardingStatus } from '@fos/api-client';
import { Alert, Button } from '@fos/ui';
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
  ServerError,
  Table,
  Tabs,
  TextArea,
} from '../components/ui';
import { admin } from '../lib/admin';
import { dateTime, day, label } from '../lib/format';

const STATUSES: OnboardingStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'DRAFT',
];
const PARTNER_DOCS = [
  'DL_FRONT',
  'DL_BACK',
  'RC',
  'INSURANCE',
  'PAN',
  'ID_PROOF',
  'BANK_PROOF',
  'PHOTO',
] as const;

/** Opens a verification document through a short-lived signed URL (API-ADM-040). */
export function DocumentButton({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        aria-label={`Open ${name}`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const { url } = await admin.documents.url(id);
            window.open(url, '_blank', 'noopener,noreferrer');
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Open
      </Button>
      <ServerError error={error} />
    </span>
  );
}

function RestaurantQueue() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['restaurant-applications', status, page],
    queryFn: () =>
      admin.restaurantApplications.list({
        page,
        status: (status || undefined) as OnboardingStatus | undefined,
      }),
  });
  return (
    <>
      <Filters>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={STATUSES} any="Waiting for review" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No restaurant applications here.</Empty>
          ) : (
            <>
              <Table
                head={['Restaurant', 'Owner', 'Location', 'Status', 'Submissions', 'Waiting since']}
              >
                {p.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link
                        className="font-medium text-brand-700 hover:underline"
                        to={`/approvals/restaurants/${a.id}`}
                      >
                        {a.brandName}
                      </Link>
                      <div className="text-xs text-gray-500">{a.legalName}</div>
                    </td>
                    <td>{a.owner?.fullName ?? '—'}</td>
                    <td>{[a.area, a.city].filter(Boolean).join(', ') || '—'}</td>
                    <td>
                      <Badge value={a.status} />
                    </td>
                    <td>{a.submissionCount}</td>
                    <td>{dateTime(a.waitingSince)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </>
  );
}

function PartnerQueue() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['partner-applications', status, page],
    queryFn: () =>
      admin.partnerApplications.list({
        page,
        status: (status || undefined) as OnboardingStatus | undefined,
      }),
  });
  return (
    <>
      <Filters>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <Options values={STATUSES} any="Waiting for review" />
        </Select>
      </Filters>
      <Loader query={q}>
        {(p) =>
          p.data.length === 0 ? (
            <Empty>No partner applications here.</Empty>
          ) : (
            <>
              <Table head={['Partner', 'Phone', 'Zone', 'Vehicle', 'Status', 'Waiting since']}>
                {p.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link
                        className="font-medium text-brand-700 hover:underline"
                        to={`/approvals/partners/${a.id}`}
                      >
                        {a.legalName ?? 'Unnamed applicant'}
                      </Link>
                    </td>
                    <td>{a.phone ?? '—'}</td>
                    <td>{a.zone?.name ?? '—'}</td>
                    <td>{label(a.vehicleType)}</td>
                    <td>
                      <Badge value={a.status} />
                    </td>
                    <td>{dateTime(a.waitingSince)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={p.pagination} onPage={setPage} />
            </>
          )
        }
      </Loader>
    </>
  );
}

export function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'partners' ? 'partners' : 'restaurants';
  return (
    <div>
      <PageHeader title="Approvals" subtitle="Oldest applications first." />
      <Tabs
        tabs={[
          { key: 'restaurants', label: 'Restaurants' },
          { key: 'partners', label: 'Delivery partners' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t })}
      />
      {tab === 'restaurants' ? <RestaurantQueue /> : <PartnerQueue />}
    </div>
  );
}

function Checklist({ missing }: { missing: { path: string; message: string }[] }) {
  return missing.length === 0 ? (
    <Alert tone="success">Every required item is complete.</Alert>
  ) : (
    <ul className="list-disc space-y-1 pl-5 text-sm text-gray-800">
      {missing.map((m) => (
        <li key={m.path + m.message}>
          <span className="font-medium">{m.path}</span>: {m.message}
        </li>
      ))}
    </ul>
  );
}

export function RestaurantApplicationPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['restaurant-applications', id],
    queryFn: () => admin.restaurantApplications.get(id),
  });
  const [comments, setComments] = useState<{ field: string; comment: string }[]>([
    { field: '', comment: '' },
  ]);
  const commentMap = Object.fromEntries(
    comments
      .filter((c) => c.field.trim() && c.comment.trim())
      .map((c) => [c.field.trim(), c.comment.trim()]),
  );
  const [startError, setStartError] = useState<unknown>(null);

  return (
    <Loader query={q}>
      {(a) => {
        const decidable = a.status === 'SUBMITTED' || a.status === 'UNDER_REVIEW';
        return (
          <div className="space-y-4">
            <PageHeader
              back={{ to: '/approvals', label: 'Approvals' }}
              title={a.brandName}
              subtitle={
                <span className="flex flex-wrap items-center gap-2">
                  <Badge value={a.status} /> Submission {a.submissionCount} · owner{' '}
                  {a.owner?.fullName ?? '—'}
                </span>
              }
              actions={
                <>
                  {a.status === 'SUBMITTED' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        setStartError(null);
                        try {
                          await admin.restaurantApplications.startReview(id);
                          void q.refetch();
                        } catch (e) {
                          setStartError(e);
                        }
                      }}
                    >
                      Start review
                    </Button>
                  )}
                  <ActionDialog
                    label="Approve"
                    variant="primary"
                    title={`Approve ${a.brandName}`}
                    description="The restaurant goes live once its outlet is approved and opened."
                    confirmLabel="Approve"
                    disabled={!decidable}
                    onConfirm={(reason) => admin.restaurantApplications.approve(id, reason)}
                  />
                  <ActionDialog
                    label="Request changes"
                    title="Request changes"
                    description="The owner sees each comment next to the field it refers to."
                    reason="optional"
                    ready={Object.keys(commentMap).length > 0}
                    confirmLabel="Send to owner"
                    disabled={!decidable}
                    onConfirm={(reason) =>
                      admin.restaurantApplications.requestChanges(
                        id,
                        commentMap,
                        reason || undefined,
                      )
                    }
                  >
                    {comments.map((c, i) => (
                      <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr]">
                        <Field
                          label="Field"
                          list="application-fields"
                          value={c.field}
                          onChange={(e) =>
                            setComments(
                              comments.map((x, j) =>
                                j === i ? { ...x, field: e.target.value } : x,
                              ),
                            )
                          }
                        />
                        <Field
                          label="Comment"
                          value={c.comment}
                          onChange={(e) =>
                            setComments(
                              comments.map((x, j) =>
                                j === i ? { ...x, comment: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </div>
                    ))}
                    <datalist id="application-fields">
                      {[
                        'brandName',
                        'legalName',
                        'panNumber',
                        'gstin',
                        'fssaiNumber',
                        'bank',
                        'branch',
                        'logo',
                        'menu',
                      ]
                        .concat(a.documents.map((d) => d.type))
                        .map((f) => (
                          <option key={f} value={f} />
                        ))}
                    </datalist>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setComments([...comments, { field: '', comment: '' }])}
                    >
                      Add another comment
                    </Button>
                  </ActionDialog>
                  <ActionDialog
                    label="Reject"
                    variant="danger"
                    title={`Reject ${a.brandName}`}
                    description="The applicant is told the reason. This can't be undone."
                    confirmLabel="Reject"
                    disabled={!decidable}
                    onConfirm={(reason) => admin.restaurantApplications.reject(id, reason)}
                  />
                </>
              }
            />
            <ServerError error={startError} />
            {a.flags.length > 0 && (
              <Alert tone="warning" title="Possible duplicate">
                {a.flags.map(label).join(', ')}
              </Alert>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="Checklist">
                <Checklist missing={a.missing} />
              </Section>
              <Section title="Business">
                <Facts
                  items={[
                    ['Legal name', a.legalName],
                    ['Entity', label(a.entityType)],
                    ['PAN', a.panMasked],
                    ['GSTIN', a.gstin],
                    ['FSSAI', a.fssaiNumber],
                    ['FSSAI expires', day(a.fssaiExpiresOn)],
                    ['Contact email', a.contactEmail],
                    ['Contact phone', a.contactPhone],
                    ['Pure veg', a.pureVeg ? 'Yes' : 'No'],
                    ['Cuisines', a.cuisines.map((c) => c.name).join(', ')],
                  ]}
                />
              </Section>
              <Section title="Outlet">
                {a.branch ? (
                  <Facts
                    items={[
                      ['Name', a.branch.name],
                      [
                        'Address',
                        [
                          a.branch.line1,
                          a.branch.line2,
                          a.branch.area,
                          a.branch.city,
                          a.branch.pincode,
                        ]
                          .filter(Boolean)
                          .join(', '),
                      ],
                      ['Delivery radius', `${(a.branch.deliveryRadiusM / 1000).toFixed(1)} km`],
                      ['Prep time', `${a.branch.defaultPrepMinutes} min`],
                      [
                        'Location',
                        a.branch.location
                          ? `${a.branch.location.lat.toFixed(5)}, ${a.branch.location.lng.toFixed(5)}`
                          : '—',
                      ],
                    ]}
                  />
                ) : (
                  <Empty>No outlet added.</Empty>
                )}
              </Section>
              <Section title="Bank account">
                {a.bank ? (
                  <Facts
                    items={[
                      ['Holder', a.bank.holderName],
                      ['Account', a.bank.accountMasked],
                      ['IFSC', a.bank.ifsc],
                      ['Status', <Badge key="s" value={a.bank.status} />],
                    ]}
                  />
                ) : (
                  <Empty>No bank account.</Empty>
                )}
              </Section>
            </div>
            <Section title="Documents">
              {a.documents.length === 0 ? (
                <Empty>No documents uploaded.</Empty>
              ) : (
                <Table head={['Document', 'Status', 'Reviewer note', '']}>
                  {a.documents.map((d) => (
                    <tr key={d.id}>
                      <td>{label(d.type)}</td>
                      <td>
                        <Badge value={d.status} />
                      </td>
                      <td>{d.reviewerNote ?? '—'}</td>
                      <td>
                        <DocumentButton id={d.id} name={label(d.type)} />
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
            <Section title="Review history">
              {a.reviews.length === 0 ? (
                <Empty>No decisions yet.</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {a.reviews.map((r, i) => (
                    <li key={i} className="rounded border border-gray-100 p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge value={r.decision} /> Submission {r.submissionNo} ·{' '}
                        {r.reviewer?.fullName ?? 'system'} · {dateTime(r.createdAt)}
                      </div>
                      {r.comments && Object.keys(r.comments).length > 0 && (
                        <ul className="mt-1 list-disc pl-5">
                          {Object.entries(r.comments).map(([k, v]) => (
                            <li key={k}>
                              <span className="font-medium">{k}</span>: {v}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        );
      }}
    </Loader>
  );
}

export function PartnerApplicationPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['partner-applications', id],
    queryFn: () => admin.partnerApplications.get(id),
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [vehicleDecision, setVehicleDecision] = useState<'VERIFIED' | 'REJECTED'>('VERIFIED');
  const docNotes = Object.fromEntries(
    Object.entries(notes)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => [k, v.trim()]),
  );

  return (
    <Loader query={q}>
      {(a) => {
        const decidable = a.status === 'SUBMITTED' || a.status === 'UNDER_REVIEW';
        const name = a.legalName ?? a.user.fullName;
        return (
          <div className="space-y-4">
            <PageHeader
              back={{ to: '/approvals?tab=partners', label: 'Approvals' }}
              title={name}
              subtitle={
                <span className="flex flex-wrap items-center gap-2">
                  <Badge value={a.status} /> Submission {a.submissionCount} · {a.user.phone ?? ''}
                </span>
              }
              actions={
                <>
                  <ActionDialog
                    label="Approve"
                    variant="primary"
                    title={`Approve ${name}`}
                    confirmLabel="Approve"
                    disabled={!decidable}
                    onConfirm={(reason) => admin.partnerApplications.approve(id, reason)}
                  />
                  <ActionDialog
                    label="Request changes"
                    title="Request changes"
                    description="Add a note to each document the partner must re-upload."
                    confirmLabel="Send to partner"
                    disabled={!decidable}
                    onConfirm={(reason) =>
                      admin.partnerApplications.requestChanges(id, reason, docNotes)
                    }
                  >
                    {PARTNER_DOCS.filter((t) => a.documents.some((d) => d.type === t)).map((t) => (
                      <Field
                        key={t}
                        label={`${label(t)} note`}
                        value={notes[t] ?? ''}
                        onChange={(e) => setNotes({ ...notes, [t]: e.target.value })}
                      />
                    ))}
                  </ActionDialog>
                  <ActionDialog
                    label="Reject"
                    variant="danger"
                    title={`Reject ${name}`}
                    confirmLabel="Reject"
                    disabled={!decidable}
                    onConfirm={(reason) => admin.partnerApplications.reject(id, reason)}
                  />
                </>
              }
            />
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="Checklist">
                <Checklist missing={a.missing} />
              </Section>
              <Section title="Applicant">
                <Facts
                  items={[
                    ['Legal name', a.legalName],
                    ['Date of birth', a.dateOfBirth],
                    ['Home zone', a.homeZone?.name],
                    ['PAN', a.panMasked],
                    ['Aadhaar', a.aadhaarMasked],
                    [
                      'Emergency contact',
                      a.emergencyContact
                        ? `${a.emergencyContact.name} (${a.emergencyContact.relation})`
                        : '—',
                    ],
                    [
                      'Bank',
                      a.bank
                        ? `${a.bank.holderName} · ${a.bank.accountMasked} · ${a.bank.ifsc}`
                        : '—',
                    ],
                    [
                      'Guidelines',
                      a.guidelines.acknowledged
                        ? `v${a.guidelines.acknowledged} acknowledged`
                        : 'Not acknowledged',
                    ],
                  ]}
                />
              </Section>
            </div>
            <Section title="Documents">
              {a.documents.length === 0 ? (
                <Empty>No documents uploaded.</Empty>
              ) : (
                <Table head={['Document', 'Status', 'Expires', 'Reviewer note', '']}>
                  {a.documents.map((d) => (
                    <tr key={d.id}>
                      <td>{label(d.type)}</td>
                      <td>
                        <Badge value={d.status} />
                      </td>
                      <td>{d.expiresOn ?? '—'}</td>
                      <td>{d.reviewerNote ?? '—'}</td>
                      <td>
                        <DocumentButton id={d.id} name={label(d.type)} />
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
            <Section title="Vehicles">
              {a.vehicles.length === 0 ? (
                <Empty>No vehicles.</Empty>
              ) : (
                <Table head={['Type', 'Registration', 'Status', '']}>
                  {a.vehicles.map((v) => (
                    <tr key={v.id}>
                      <td>{label(v.type)}</td>
                      <td>{v.registrationNumber ?? '—'}</td>
                      <td>
                        <Badge value={v.status} />
                      </td>
                      <td>
                        <ActionDialog
                          label="Verify"
                          title="Verify vehicle"
                          confirmLabel="Save decision"
                          onConfirm={(reason) =>
                            admin.partnerApplications.verifyVehicle(v.id, vehicleDecision, reason)
                          }
                        >
                          <Select
                            label="Decision"
                            value={vehicleDecision}
                            onChange={(e) =>
                              setVehicleDecision(e.target.value as 'VERIFIED' | 'REJECTED')
                            }
                          >
                            <option value="VERIFIED">Verified</option>
                            <option value="REJECTED">Rejected</option>
                          </Select>
                        </ActionDialog>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
            {a.rejectedReason && (
              <Section title="Rejection">
                <TextArea label="Reason given" value={a.rejectedReason} readOnly />
              </Section>
            )}
          </div>
        );
      }}
    </Loader>
  );
}
