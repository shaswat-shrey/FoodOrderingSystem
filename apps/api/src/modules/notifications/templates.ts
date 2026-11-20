/**
 * Message templates for authentication and account security (FR-NOTIF-005,
 * subset needed in Phase 4). The full versioned template store arrives with the
 * notifications module in Phase 7. Templates never include more than needed.
 */
export type MessageTemplate =
  | { template: 'OTP'; vars: { code: string; purpose: string; minutes: number } }
  | { template: 'VERIFY_EMAIL'; vars: { name: string; link: string } }
  | { template: 'RESET_PASSWORD_EMAIL'; vars: { name: string; link: string; minutes: number } }
  | { template: 'SECURITY_ALERT'; vars: { name: string; event: SecurityEvent } }
  /** Already rendered from a stored template (notification deliveries). */
  | { template: 'RENDERED'; vars: { subject: string; text: string } };

export type SecurityEvent =
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'ACCOUNT_LOCKED'
  | 'SESSION_REUSE_DETECTED'
  | 'LOGGED_OUT_EVERYWHERE'
  | 'EMAIL_CHANGED'
  | 'PHONE_CHANGED'
  | 'ACCOUNT_DELETION_REQUESTED'
  | 'ACCOUNT_REACTIVATED';

export type Message = { channel: 'SMS' | 'EMAIL'; to: string } & MessageTemplate;

const PURPOSE_TEXT: Record<string, string> = {
  LOGIN: 'sign in',
  VERIFY_PHONE: 'verify your phone number',
  RESET_PASSWORD: 'reset your password',
  CHANGE_PHONE: 'confirm your new phone number',
  DELETE_ACCOUNT: 'confirm account deletion',
  MFA_LOGIN: 'finish signing in to the admin console',
};

const SECURITY_TEXT: Record<SecurityEvent, string> = {
  PASSWORD_CHANGED: 'Your password was changed. Other devices have been signed out.',
  PASSWORD_RESET: 'Your password was reset and all devices were signed out.',
  ACCOUNT_LOCKED: 'Your account was temporarily locked after several failed sign-in attempts.',
  SESSION_REUSE_DETECTED:
    'We signed out one of your sessions because its sign-in credentials were used from two places. If this wasn’t you, change your password.',
  LOGGED_OUT_EVERYWHERE: 'You were signed out of all devices.',
  EMAIL_CHANGED: 'The email address on your account was changed.',
  PHONE_CHANGED:
    'The phone number on your account was changed and other devices were signed out. If this wasn’t you, contact support.',
  ACCOUNT_DELETION_REQUESTED:
    'Your account is scheduled for deletion in 30 days. Sign in to cancel.',
  ACCOUNT_REACTIVATED: 'Your account was reactivated and will not be deleted.',
};

export interface RenderedMessage {
  subject: string;
  text: string;
}

export function render(message: MessageTemplate): RenderedMessage {
  switch (message.template) {
    case 'OTP':
      return {
        subject: 'Your verification code',
        text: `${message.vars.code} is your FoodOrderSystem code to ${PURPOSE_TEXT[message.vars.purpose] ?? 'continue'}. It expires in ${message.vars.minutes} minutes. Never share it with anyone.`,
      };
    case 'VERIFY_EMAIL':
      return {
        subject: 'Verify your email address',
        text: `Hi ${message.vars.name}, confirm your email address: ${message.vars.link}\nThe link expires in 24 hours.`,
      };
    case 'RESET_PASSWORD_EMAIL':
      return {
        subject: 'Reset your password',
        text: `Hi ${message.vars.name}, reset your password here: ${message.vars.link}\nThe link expires in ${message.vars.minutes} minutes. If you didn’t ask for this, ignore this email.`,
      };
    case 'SECURITY_ALERT':
      return {
        subject: 'Security alert for your account',
        text: `Hi ${message.vars.name}, ${SECURITY_TEXT[message.vars.event]}`,
      };
    case 'RENDERED':
      return { subject: message.vars.subject, text: message.vars.text };
  }
}
