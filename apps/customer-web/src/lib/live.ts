import { createRealtime } from '@fos/api-client';
import { api } from './api';

/** The customer app's socket (SRS §13); started in main.tsx, connects while signed in. */
export const live = createRealtime(api);
