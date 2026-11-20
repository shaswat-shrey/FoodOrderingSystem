import type { AuthConfig } from '@fos/auth-web';
import { APP_INFO } from '../app-info';

/** Restaurant owners and staff; new owners register here and finish onboarding in Phase 8. */
export const AUTH_CONFIG: AuthConfig = {
  appName: APP_INFO.title,
  methods: ['password', 'otp'],
  allowSignUp: true,
};
