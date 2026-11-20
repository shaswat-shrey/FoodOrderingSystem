import type { ClientApp, NotificationCategory, NotificationChannel } from '@fos/db';

export interface TemplateDefinition {
  key: string;
  category: NotificationCategory;
  /** Which app's inbox the in-app entry belongs to. */
  app: ClientApp;
  channels: Partial<Record<NotificationChannel, { subject?: string; body: string }>>;
  /** Variables every channel needs; a missing one fails the send (FR-NOTIF-005). */
  variables: string[];
  deepLink?: string;
}

const ORDER_VARS = ['number', 'restaurant', 'orderId'];

/**
 * Version 1 of the default templates (FR-NOTIF-005/010, EVENTS-AND-JOBS §3).
 * They are written to `notification_templates` on first use; admins publish
 * newer versions later (Phase 11).
 */
export const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'order.placed',
    category: 'ORDER_UPDATES',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Order placed',
        body: '{{restaurant}} has your order {{number}}. We will tell you when they accept it.',
      },
      PUSH: { subject: 'Order placed', body: '{{restaurant}} has your order {{number}}.' },
    },
  },
  {
    key: 'order.accepted',
    category: 'ORDER_UPDATES',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Order accepted',
        body: '{{restaurant}} accepted order {{number}} and will start preparing it.',
      },
      PUSH: { subject: 'Order accepted', body: '{{restaurant}} accepted order {{number}}.' },
    },
  },
  {
    key: 'order.preparing',
    category: 'ORDER_UPDATES',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Preparing your food',
        body: '{{restaurant}} is preparing order {{number}}.',
      },
    },
  },
  {
    key: 'order.ready_for_pickup',
    category: 'ORDER_UPDATES',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Food is ready',
        body: 'Order {{number}} is packed and waiting for pickup.',
      },
    },
  },
  {
    key: 'order.picked_up',
    category: 'ORDER_UPDATES',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: { subject: 'On the way', body: 'Order {{number}} is on its way to you.' },
      PUSH: { subject: 'On the way', body: 'Order {{number}} is on its way.' },
    },
  },
  {
    key: 'order.delivered',
    category: 'ORDER_UPDATES',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Delivered',
        body: 'Order {{number}} from {{restaurant}} was delivered. Enjoy your meal!',
      },
      PUSH: { subject: 'Delivered', body: 'Order {{number}} was delivered. Enjoy!' },
    },
  },
  {
    key: 'order.cancelled',
    category: 'TRANSACTIONAL',
    app: 'CUSTOMER',
    variables: [...ORDER_VARS, 'refundText'],
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Order cancelled',
        body: 'Order {{number}} from {{restaurant}} was cancelled. {{refundText}}',
      },
      PUSH: { subject: 'Order cancelled', body: 'Order {{number}} was cancelled. {{refundText}}' },
      SMS: { body: 'FoodOrderSystem: order {{number}} was cancelled. {{refundText}}' },
    },
  },
  {
    key: 'order.rejected',
    category: 'TRANSACTIONAL',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Restaurant couldn’t accept',
        body: '{{restaurant}} couldn’t accept order {{number}}. You will get a full refund.',
      },
      PUSH: {
        subject: 'Restaurant couldn’t accept',
        body: 'Order {{number}} couldn’t be accepted. Full refund on the way.',
      },
    },
  },
  {
    key: 'order.payment_expired',
    category: 'TRANSACTIONAL',
    app: 'CUSTOMER',
    variables: ORDER_VARS,
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Payment not completed',
        body: 'We didn’t receive payment for order {{number}}, so it was not placed. Any wallet credit is back in your wallet.',
      },
    },
  },
  {
    key: 'refund.succeeded',
    category: 'TRANSACTIONAL',
    app: 'CUSTOMER',
    variables: ['number', 'orderId', 'amount', 'destinationText'],
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Refund processed',
        body: 'Rs. {{amount}} for order {{number}} {{destinationText}}',
      },
      EMAIL: {
        subject: 'Your refund for order {{number}}',
        body: 'Rs. {{amount}} for order {{number}} {{destinationText}}',
      },
    },
  },
  {
    key: 'ticket.created',
    category: 'TRANSACTIONAL',
    app: 'CUSTOMER',
    variables: ['ticketNumber', 'ticketId'],
    deepLink: '/support/tickets/{{ticketId}}',
    channels: {
      IN_APP: {
        subject: 'We got your request',
        body: 'Ticket {{ticketNumber}} is open. Our team will reply here.',
      },
    },
  },
  {
    key: 'restaurant.new_order',
    category: 'TRANSACTIONAL',
    app: 'RESTAURANT',
    variables: ['number', 'orderId', 'branch', 'itemCount'],
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'New order {{number}}',
        body: '{{itemCount}} item(s) for {{branch}}. Accept it within 5 minutes.',
      },
      PUSH: { subject: 'New order {{number}}', body: '{{itemCount}} item(s) for {{branch}}.' },
    },
  },
  {
    key: 'restaurant.accept_reminder',
    category: 'TRANSACTIONAL',
    app: 'RESTAURANT',
    variables: ['number', 'orderId', 'branch'],
    deepLink: '/orders/{{orderId}}',
    channels: {
      PUSH: {
        subject: 'Order {{number}} is waiting',
        body: 'Accept or reject order {{number}} at {{branch}} now.',
      },
      SMS: {
        body: 'FoodOrderSystem: order {{number}} at {{branch}} is waiting for you. Accept it now or it will be cancelled.',
      },
    },
  },
  {
    key: 'restaurant.order_cancelled',
    category: 'TRANSACTIONAL',
    app: 'RESTAURANT',
    variables: ['number', 'orderId', 'branch'],
    deepLink: '/orders/{{orderId}}',
    channels: {
      IN_APP: {
        subject: 'Order {{number}} cancelled',
        body: 'Order {{number}} at {{branch}} was cancelled. Stop preparing it.',
      },
      PUSH: { subject: 'Order {{number}} cancelled', body: 'Stop preparing order {{number}}.' },
    },
  },
];

/** BR-NOTIF-001: these categories can't be switched off. */
export const MANDATORY_CATEGORIES = new Set<NotificationCategory>([
  'TRANSACTIONAL',
  'SECURITY',
  'ORDER_UPDATES',
]);
export const OPTIONAL_CATEGORIES = ['PROMOTIONS', 'RECOMMENDATIONS', 'REVIEW_REMINDERS'] as const;
export const PREFERENCE_CHANNELS = ['PUSH', 'SMS', 'EMAIL'] as const;

/** `{{name}}` substitution; a missing or empty variable is an error, never blank text. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '')
      throw new Error(`template variable "${name}" is missing`);
    return String(v);
  });
}
