import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiClientError } from '@fos/api-client';
import { useAuth } from '@fos/auth-web';
import { Alert, Button, Spinner } from '@fos/ui';
import { Field, Section, ServerError } from '../components/ui';
import { partner } from '../lib/partner';
import { api } from '../lib/api';

/** API-EARN-011/012: masked bank details; changes need a fresh code (BR-AUTH-017). */
export function BankPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const bank = useQuery({ queryKey: ['partner', 'bank'], queryFn: partner.earnings.bank });
  const [form, setForm] = useState({ holderName: '', accountNumber: '', ifsc: '' });
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const change = useMutation({
    mutationFn: () => partner.earnings.changeBank(form),
    onSuccess: (b) => {
      qc.setQueryData(['partner', 'bank'], b);
      setForm({ holderName: '', accountNumber: '', ifsc: '' });
      setNeedsCode(false);
    },
    onError: (e) => {
      if (isApiClientError(e) && e.code === 'AUTH_REAUTH_REQUIRED') setNeedsCode(true);
    },
  });
  const sendCode = useMutation({
    mutationFn: () => api.post('/auth/otp/request', { phone: user?.phone, purpose: 'LOGIN' }),
  });
  const confirm = useMutation({
    mutationFn: () => api.post('/auth/reauth', { code }),
    onSuccess: () => change.mutate(),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate();
  };
  const b = bank.data;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Bank account</h1>
      {bank.isPending && <Spinner />}
      <ServerError error={bank.error} />
      {b && (
        <Section title="Payouts go to">
          {b.current ? (
            <p className="text-sm text-gray-800">
              {b.current.holderName} · {b.current.accountMasked} · {b.current.ifsc}
              <span className="ml-2 text-xs text-gray-500">
                {b.current.status.toLowerCase().replaceAll('_', ' ')}
              </span>
            </p>
          ) : (
            <p className="text-sm text-gray-600">No bank account on file.</p>
          )}
          {b.pendingChange && (
            <Alert tone="warning" className="mt-3">
              Change to {b.pendingChange.accountMasked} is waiting for verification. Payouts are on
              hold until then.
            </Alert>
          )}
        </Section>
      )}
      <Section title="Change bank account">
        <form onSubmit={submit} className="grid gap-3">
          <Field
            label="Account holder name"
            value={form.holderName}
            onChange={set('holderName')}
            required
          />
          <Field
            label="Account number"
            inputMode="numeric"
            value={form.accountNumber}
            onChange={set('accountNumber')}
            required
          />
          <Field
            label="IFSC"
            value={form.ifsc}
            onChange={set('ifsc')}
            autoCapitalize="characters"
            required
          />
          {needsCode ? (
            <Alert tone="info" title="Confirm it’s you">
              We’ll send a code to your phone.
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={sendCode.isPending}
                  onClick={() => sendCode.mutate()}
                >
                  {sendCode.isSuccess ? 'Resend code' : 'Send code'}
                </Button>
                <Field
                  label="Code"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button
                  size="sm"
                  loading={confirm.isPending || change.isPending}
                  onClick={() => confirm.mutate()}
                >
                  Confirm and save
                </Button>
              </div>
              <ServerError error={confirm.error ?? sendCode.error} />
            </Alert>
          ) : (
            <>
              <ServerError error={change.error} />
              <Button type="submit" loading={change.isPending}>
                Request change
              </Button>
            </>
          )}
          {change.isSuccess && <Alert tone="success">Sent for verification.</Alert>}
        </form>
      </Section>
    </div>
  );
}
