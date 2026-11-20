import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '@fos/auth-web';
import { Alert, Button, Card, Spinner } from '@fos/ui';
import { ServerError } from '../components/fields';
import { ROLE_LABEL } from '../lib/format';
import { merchant } from '../lib/merchant';

/** FR-RSTAFF-001: invitation preview, then sign in (or sign up) and accept. */
export function InvitePage() {
  const { token = '' } = useParams();
  const { status } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => merchant.staff.preview(token),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => merchant.staff.accept(token),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['merchant', 'me'] });
      navigate('/', { replace: true });
    },
  });
  if (preview.isLoading) return <Spinner />;
  if (preview.isError)
    return (
      <Alert tone="error">This invitation has expired or was withdrawn. Ask for a new one.</Alert>
    );
  const p = preview.data!;
  const next = encodeURIComponent(`/invite/${token}`);
  return (
    <Card className="mx-auto max-w-md space-y-3 p-6">
      <h1 className="text-xl font-bold">Join {p.restaurant}</h1>
      <p>
        {p.invitedBy} invited you as <strong>{ROLE_LABEL[p.role]}</strong>
        {p.branches.length ? ` at ${p.branches.join(', ')}` : ' at all outlets'}.
      </p>
      <ServerError error={accept.error} />
      {status === 'signedIn' ? (
        <Button loading={accept.isPending} onClick={() => accept.mutate()}>
          Accept invitation
        </Button>
      ) : (
        <p className="text-sm">
          <Link className="font-medium text-brand-700 underline" to={`/sign-in?next=${next}`}>
            Sign in
          </Link>{' '}
          or{' '}
          <Link className="font-medium text-brand-700 underline" to={`/sign-up?next=${next}`}>
            create an account
          </Link>{' '}
          with the number this invitation was sent to.
        </p>
      )}
    </Card>
  );
}
