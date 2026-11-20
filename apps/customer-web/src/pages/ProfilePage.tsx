import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useAuth } from '@fos/auth-web';
import type { Preferences } from '@fos/api-client';
import { Alert, Button, ErrorState, Spinner } from '@fos/ui';
import { PageTitle, TagPicker } from '../components/account-ui';
import { Field, Section, ServerError } from '../components/ui';
import { customer } from '../lib/customer';

const DIETARY: Record<string, string> = {
  VEGAN: 'Vegan',
  JAIN: 'Jain',
  GLUTEN_FREE: 'Gluten-free',
  DAIRY_FREE: 'Dairy-free',
  SPICY: 'Loves spicy',
  KETO: 'Keto',
  HIGH_PROTEIN: 'High protein',
};
const ALLERGENS: Record<string, string> = {
  GLUTEN: 'Gluten',
  CRUSTACEANS: 'Crustaceans',
  EGGS: 'Eggs',
  FISH: 'Fish',
  PEANUTS: 'Peanuts',
  SOY: 'Soy',
  MILK: 'Milk',
  TREE_NUTS: 'Tree nuts',
  CELERY: 'Celery',
  MUSTARD: 'Mustard',
  SESAME: 'Sesame',
  SULPHITES: 'Sulphites',
  LUPIN: 'Lupin',
  MOLLUSCS: 'Molluscs',
};

/** Profile and food preferences (API-USER-001/002/006, FR-USER-*). */
export function ProfilePage() {
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => customer.profile.get() });
  if (profile.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading your profile" />
      </div>
    );
  if (profile.isError)
    return (
      <ErrorState
        title="Couldn’t load your profile"
        description={profile.error.message}
        action={<Button onClick={() => void profile.refetch()}>Try again</Button>}
      />
    );
  const p = profile.data;
  return (
    <div className="space-y-4">
      <PageTitle>Profile</PageTitle>
      <NameSection fullName={p.fullName} />
      <EmailSection email={p.email} verified={p.emailVerified} />
      <Section title="Phone">
        <p className="text-sm text-gray-800">
          {p.phone ?? 'Not added'}{' '}
          {p.phone && (
            <span className={p.phoneVerified ? 'text-success-600' : 'text-warning-600'}>
              · {p.phoneVerified ? 'Verified' : 'Not verified'}
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-gray-500">Change your number from sign-in and security.</p>
      </Section>
      <PreferencesSection />
      <Section title="Sign-in and security">
        <p className="text-sm text-gray-700">Password, signed-in devices and account deletion.</p>
        <Link
          to="/account/security"
          className="mt-2 inline-block font-medium text-brand-700 underline"
        >
          Manage sign-in and security
        </Link>
      </Section>
    </div>
  );
}

function NameSection({ fullName }: { fullName: string }) {
  const qc = useQueryClient();
  const { api } = useAuth();
  const [name, setName] = useState(fullName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError(new Error('Enter your name (at least 2 characters).'));
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await customer.profile.update({ fullName: trimmed });
      qc.setQueryData(['profile'], updated);
      const state = api.authStore.getState();
      if (state.user)
        api.authStore.setState({ user: { ...state.user, fullName: updated.fullName } });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Your name">
      <form className="space-y-3" onSubmit={submit} noValidate aria-label="Your name">
        <Field
          label="Full name"
          autoComplete="name"
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        <ServerError error={error} />
        {saved && <Alert tone="success">Profile updated.</Alert>}
        <Button type="submit" loading={busy} disabled={name.trim() === fullName}>
          Save name
        </Button>
      </form>
    </Section>
  );
}

function EmailSection({ email, verified }: { email: string | null; verified: boolean }) {
  const qc = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      setError(new Error('Enter a valid email address.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await customer.profile.changeEmail(value.trim());
      setSent(true);
      setChanging(false);
      void qc.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Email">
      <p className="text-sm text-gray-800">
        {email ?? 'Not added'}{' '}
        {email && (
          <span className={verified ? 'text-success-600' : 'text-warning-600'}>
            · {verified ? 'Verified' : 'Not verified — check your inbox for the link'}
          </span>
        )}
      </p>
      {sent && (
        <Alert tone="success" className="mt-2">
          We sent a verification link to your new email.
        </Alert>
      )}
      {changing ? (
        <form className="mt-3 space-y-3" onSubmit={submit} noValidate aria-label="Change email">
          <Field
            label="New email"
            type="email"
            autoComplete="email"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <ServerError error={error} />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setChanging(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Send verification link
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setChanging(true)}>
          {email ? 'Change email' : 'Add email'}
        </Button>
      )}
    </Section>
  );
}

function PreferencesSection() {
  const prefs = useQuery({
    queryKey: ['preferences'],
    queryFn: () => customer.profile.preferences(),
  });
  const [form, setForm] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (prefs.data) setForm(prefs.data);
  }, [prefs.data]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setForm(await customer.profile.updatePreferences(form));
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Food preferences">
      {!form ? (
        prefs.isError ? (
          <ServerError error={prefs.error} />
        ) : (
          <Spinner label="Loading preferences" />
        )
      ) : (
        <form className="space-y-4" onSubmit={submit} noValidate aria-label="Food preferences">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={form.vegOnlyDefault}
              onChange={(e) => {
                setForm({ ...form, vegOnlyDefault: e.target.checked });
                setSaved(false);
              }}
            />
            Show vegetarian food only by default
          </label>
          <TagPicker
            legend="Dietary preferences"
            options={DIETARY}
            value={form.dietaryTags}
            onChange={(dietaryTags) => {
              setForm({ ...form, dietaryTags });
              setSaved(false);
            }}
          />
          <TagPicker
            legend="Allergies — we’ll warn you about these"
            options={ALLERGENS}
            value={form.allergens}
            onChange={(allergens) => {
              setForm({ ...form, allergens });
              setSaved(false);
            }}
          />
          <ServerError error={error} />
          {saved && <Alert tone="success">Preferences saved.</Alert>}
          <Button type="submit" loading={busy}>
            Save preferences
          </Button>
        </form>
      )}
    </Section>
  );
}
