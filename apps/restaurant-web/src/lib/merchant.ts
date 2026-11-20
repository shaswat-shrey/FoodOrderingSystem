import { createMerchantApi } from '@fos/api-client';
import { api } from './api';

export const merchant = createMerchantApi(api);
