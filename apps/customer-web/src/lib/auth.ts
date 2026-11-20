import type { AuthConfig } from '@fos/auth-web';
import { APP_INFO } from '../app-info';

/** Customers sign in with a one-time code or a password; browsing stays public. */
export const AUTH_CONFIG: AuthConfig = {
  appName: APP_INFO.title,
  methods: ['otp', 'password'],
  allowSignUp: true,
};
