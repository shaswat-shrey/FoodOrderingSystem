import { createPartnerApi } from '@fos/api-client';
import { api } from './api';

export const partner = createPartnerApi(api);
