import type { AuthConfig } from '@fos/auth-web';
import { APP_INFO } from '../app-info';

/** Admins sign in with a password plus an emailed code; accounts are created by a super admin, never self-registered. */
export const AUTH_CONFIG: AuthConfig = {
  appName: APP_INFO.title,
  methods: ['password'],
  allowSignUp: false,
};
