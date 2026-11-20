import { createAdminApi } from '@fos/api-client';
import { api } from './api';

/** Typed admin console endpoints (API-ADM-*). */
export const admin = createAdminApi(api);
