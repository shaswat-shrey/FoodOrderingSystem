import type { ClientApp } from '@fos/shared';
import type { AuthContext } from '../platform/http/auth-context';

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      clientApp?: ClientApp;
      auth?: AuthContext;
    }
  }
}

export {};
