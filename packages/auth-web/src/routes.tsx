import type { RouteObject } from 'react-router';
import { RedirectIfSignedIn, RequireAuth } from './guards';
import { AccountSecurityPage } from './pages/AccountSecurityPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordRecoveryPages';
import { SignInPage } from './pages/SignInPage';
import { SignUpPage } from './pages/SignUpPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { VerifyPhonePage } from './pages/VerifyPhonePage';

/**
 * Auth routes to place under an app's layout route. Paths match the links the
 * API emails (/verify-email, /reset-password). Sign-up is only mounted where
 * the app allows it.
 */
export function authRoutes({ allowSignUp }: { allowSignUp: boolean }): RouteObject[] {
  return [
    {
      element: <RedirectIfSignedIn />,
      children: [
        { path: 'sign-in', element: <SignInPage /> },
        ...(allowSignUp ? [{ path: 'sign-up', element: <SignUpPage /> }] : []),
        { path: 'forgot-password', element: <ForgotPasswordPage /> },
      ],
    },
    { path: 'reset-password', element: <ResetPasswordPage /> },
    { path: 'verify-email', element: <VerifyEmailPage /> },
    {
      element: <RequireAuth />,
      children: [
        { path: 'verify-phone', element: <VerifyPhonePage /> },
        { path: 'account/security', element: <AccountSecurityPage /> },
      ],
    },
  ];
}
