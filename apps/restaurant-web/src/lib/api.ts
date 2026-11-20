import { createApiClient } from '@fos/api-client';

/** Same-origin API client; the Vite proxy / reverse proxy routes /api to the API. */
export const api = createApiClient({ clientApp: 'RESTAURANT' });
