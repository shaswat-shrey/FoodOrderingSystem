import type { AuthConfig } from '@fos/auth-web';
import { APP_INFO } from '../app-info';

/** Delivery partners sign in with their phone; new partners register here and onboard in Phase 8. */
export const AUTH_CONFIG: AuthConfig = {
  appName: APP_INFO.title,
  methods: ['otp'],
  allowSignUp: true,
};
