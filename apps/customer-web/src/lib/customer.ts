import { createCustomerApi } from '@fos/api-client';
import { api } from './api';

export const customer = createCustomerApi(api);
