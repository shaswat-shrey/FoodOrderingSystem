import type { ClientApp } from '@fos/shared';

/**
 * Authenticated caller, resolved from a verified access token plus a live
 * session check (FR-AUTH-021). `scope` is ONBOARDING for restaurant/delivery
 * applicants who may only use onboarding endpoints (BR-AUTH-010).
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  app: ClientApp;
  roles: string[];
  scope: 'FULL' | 'ONBOARDING';
  permissionVersion: number;
}
