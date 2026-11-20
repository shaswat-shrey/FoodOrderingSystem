import { Button, ErrorState } from '@fos/ui';

/** Rendered when a route throws while rendering or loading (FR-FE-005). */
export function RouteErrorPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <ErrorState
        title="Something went wrong"
        description="This page couldn’t be displayed. Reloading usually fixes it."
        action={<Button onClick={() => window.location.reload()}>Reload page</Button>}
      />
    </div>
  );
}
