import type { LoginOutcome, Prisma, PrismaClient, User } from '@fos/db';
import { Prisma as PrismaNs } from '@fos/db';
import type { ClientApp } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { hmac, randomToken, sha256 } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import type { RateLimiter } from '../../platform/rate-limit';
import type { AuditService } from '../audit';
import { appScopeFor, type IamService } from '../iam';
import type { MessageDispatcher, SecurityEvent } from '../notifications';
import type { OtpService } from './otp.service';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';
import { AUTH_POLICY, lockMinutesFor } from './policy';
import type { DeviceInfo, SessionService } from './session.service';
import type { TokenService } from './tokens';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RequestMeta extends DeviceInfo {
  app: ClientApp;
  requestId?: string;
}

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

export interface UserSummary {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  status: User['status'];
  roles: string[];
  scope: 'FULL' | 'ONBOARDING';
  profileComplete: boolean;
}

export type SignInResult =
  | ({ kind: 'session'; user: UserSummary } & SessionTokens)
  | { kind: 'mfa'; mfaToken: string; mfaTokenExpiresAt: Date };

export interface AuthServiceConfig {
  hmacSecret: string;
  appUrls: Record<ClientApp, string>;
}

/** Normalises an email or phone identifier; 10-digit Indian numbers get +91. */
export function normalizeIdentifier(raw: string): { kind: 'email' | 'phone'; value: string } {
  const value = raw.trim();
  if (value.includes('@')) return { kind: 'email', value: value.toLowerCase() };
  const digits = value.replace(/[\s-]/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return { kind: 'phone', value: `+91${digits}` };
  return { kind: 'phone', value: digits };
}

const TERMINAL_ORDER_STATUSES = ['DELIVERED', 'CANCELLED', 'REJECTED', 'FAILED'] as const;
const ACTIVE_DELIVERY_STATUSES = [
  'ASSIGNED',
  'AT_RESTAURANT',
  'EN_ROUTE_TO_CUSTOMER',
  'AT_CUSTOMER',
] as const;

/**
 * Authentication and account lifecycle (SRS §5). Controllers translate HTTP to
 * these calls; every security-relevant outcome is audited (BR-ADMIN-002).
 */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly iam: IamService,
    private readonly audit: AuditService,
    private readonly messages: MessageDispatcher,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly config: AuthServiceConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Sessions & tokens
  // ---------------------------------------------------------------------------

  private async summarize(
    userId: string,
    app: ClientApp,
  ): Promise<{ user: UserSummary; tokenVersion: number; permissionVersion: number }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const perms = await this.iam.resolve(user.id, user.permissionVersion);
    const scope = appScopeFor(app, perms);
    if (!scope) throw new AppError('AUTH_APP_NOT_PERMITTED');
    return {
      tokenVersion: user.tokenVersion,
      permissionVersion: user.permissionVersion,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        emailVerified: user.emailVerifiedAt !== null,
        phoneVerified: user.phoneVerifiedAt !== null,
        status: user.status,
        roles: perms.platformRoles,
        scope,
        profileComplete: user.fullName.trim().length > 0,
      },
    };
  }

  /** FR-AUTH-020: session + refresh token + access token for an authenticated user. */
  private async establishSession(
    userId: string,
    meta: RequestMeta,
    options: { mfaVerified?: boolean } = {},
  ): Promise<{ kind: 'session'; user: UserSummary } & SessionTokens> {
    const { user, tokenVersion, permissionVersion } = await this.summarize(userId, meta.app);
    const session = await this.sessions.create(this.prisma, userId, meta.app, meta);
    if (options.mfaVerified) {
      await this.prisma.userSession.update({
        where: { id: session.sessionId },
        data: { mfaVerifiedAt: this.clock.now() },
      });
    }
    const access = await this.tokens.sign({
      userId,
      sessionId: session.sessionId,
      app: meta.app,
      roles: user.roles,
      scope: user.scope,
      permissionVersion,
      tokenVersion,
    });
    return {
      kind: 'session',
      user,
      sessionId: session.sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.absoluteExpiresAt,
    };
  }

  /** FR-AUTH-022: rotate the refresh token and mint a new access token. */
  async refresh(
    rawToken: string,
    meta: RequestMeta,
  ): Promise<SessionTokens & { user: UserSummary }> {
    const result = await this.sessions.rotate(rawToken, meta.app);
    if (result.kind === 'race') throw new AppError('AUTH_REFRESH_RACE');
    if (result.kind === 'reused') {
      await this.audit.record({
        action: 'auth.refresh_reuse_detected',
        targetType: 'session',
        targetId: result.sessionId,
        actorUserId: result.userId,
        sessionId: result.sessionId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        sensitivity: 'HIGH',
      });
      await this.alert(result.userId, 'SESSION_REUSE_DETECTED');
      throw new AppError('AUTH_REFRESH_REUSED');
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { status: true },
    });
    if (user.status !== 'ACTIVE' && user.status !== 'PENDING_VERIFICATION') {
      await this.sessions.revoke(
        result.sessionId,
        user.status === 'SUSPENDED' ? 'SUSPENDED' : 'ADMIN_REVOKED',
      );
      throw new AppError(
        user.status === 'SUSPENDED' ? 'AUTH_ACCOUNT_SUSPENDED' : 'AUTH_SESSION_REVOKED',
      );
    }
    const summary = await this.summarize(result.userId, meta.app);
    const access = await this.tokens.sign({
      userId: result.userId,
      sessionId: result.sessionId,
      app: meta.app,
      roles: summary.user.roles,
      scope: summary.user.scope,
      permissionVersion: summary.permissionVersion,
      tokenVersion: summary.tokenVersion,
    });
    return {
      user: summary.user,
      sessionId: result.sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.absoluteExpiresAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Registration & sign-in
  // ---------------------------------------------------------------------------

  private async latestLegalDocuments(db: Db): Promise<string[]> {
    const docs = await db.legalDocument.findMany({
      where: { type: { in: ['TERMS', 'PRIVACY'] }, publishedAt: { lte: this.clock.now() } },
      orderBy: { publishedAt: 'desc' },
    });
    const latest = new Map<string, string>();
    for (const d of docs) if (!latest.has(d.type)) latest.set(d.type, d.id);
    return [...latest.values()];
  }

  /** Creates the account records shared by password and OTP sign-up. */
  private async createAccount(
    tx: Prisma.TransactionClient,
    input: {
      fullName: string;
      email: string | null;
      phone: string;
      passwordHash: string | null;
      phoneVerified: boolean;
    },
    meta: RequestMeta,
  ): Promise<string> {
    const now = this.clock.now();
    const customerRole =
      meta.app === 'CUSTOMER'
        ? await tx.role.findUniqueOrThrow({ where: { key: 'CUSTOMER' } })
        : null;
    const user = await tx.user.create({
      data: {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        status: input.phoneVerified ? 'ACTIVE' : 'PENDING_VERIFICATION',
        phoneVerifiedAt: input.phoneVerified ? now : null,
        credential: input.passwordHash
          ? { create: { passwordHash: input.passwordHash } }
          : undefined,
        roles: customerRole ? { create: { roleId: customerRole.id } } : undefined,
        customerProfile: meta.app === 'CUSTOMER' ? { create: {} } : undefined,
      },
    });
    const docs = await this.latestLegalDocuments(tx);
    await tx.userConsent.createMany({
      data: docs.map((legalDocumentId) => ({
        userId: user.id,
        legalDocumentId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      })),
    });
    return user.id;
  }

  /** FR-AUTH-001: email + password registration. Phone OTP and email link follow. */
  async register(
    input: { fullName: string; email: string; phone: string; password: string },
    meta: RequestMeta,
  ): Promise<SignInResult> {
    if (meta.app === 'ADMIN') throw new AppError('AUTH_APP_NOT_PERMITTED');
    const email = input.email.trim().toLowerCase();
    const issue = checkPasswordPolicy(input.password, { email, phone: input.phone });
    if (issue) throw new AppError(issue);

    const existing = await this.prisma.user.findFirst({
      where: { status: { not: 'ANONYMIZED' }, OR: [{ email }, { phone: input.phone }] },
      select: { id: true },
    });
    if (existing) throw new AppError('AUTH_REGISTRATION_CONFLICT');

    const passwordHash = await hashPassword(input.password);
    let userId: string;
    try {
      userId = await this.prisma.$transaction((tx) =>
        this.createAccount(
          tx,
          {
            fullName: input.fullName.trim(),
            email,
            phone: input.phone,
            passwordHash,
            phoneVerified: false,
          },
          meta,
        ),
      );
    } catch (error) {
      if (error instanceof PrismaNs.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError('AUTH_REGISTRATION_CONFLICT'); // concurrent sign-up with the same details
      }
      throw error;
    }

    await this.sendPhoneOtp(input.phone, 'VERIFY_PHONE', userId).catch((error: unknown) =>
      this.logger.warn(
        { err: error, userId },
        'could not send phone verification code at registration',
      ),
    );
    await this.sendEmailVerificationFor(userId, meta.app);
    return this.establishSession(userId, meta);
  }

  private async recordAttempt(
    identifier: string,
    userId: string | null,
    outcome: LoginOutcome,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.loginAttempt.create({
      data: {
        identifierHash: hmac(this.config.hmacSecret, 'login-identifier', identifier),
        userId,
        ip: meta.ip ?? null,
        app: meta.app,
        outcome,
        createdAt: this.clock.now(),
      },
    });
  }

  /** Consecutive failures since the last success, with the time of the latest one (BR-AUTH-004). */
  private async lockState(userId: string): Promise<{ failures: number; lockedUntil: Date | null }> {
    const recent = await this.prisma.loginAttempt.findMany({
      where: { userId, outcome: { in: ['SUCCESS', 'MFA_REQUIRED', 'INVALID_CREDENTIALS'] } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { outcome: true, createdAt: true },
    });
    let failures = 0;
    for (const a of recent) {
      if (a.outcome !== 'INVALID_CREDENTIALS') break;
      failures += 1;
    }
    const minutes = lockMinutesFor(failures);
    if (minutes === 0) return { failures, lockedUntil: null };
    const until = new Date(recent[0]!.createdAt.getTime() + minutes * 60_000);
    return { failures, lockedUntil: until > this.clock.now() ? until : null };
  }

  /** FR-AUTH-003: identifier + password. Unknown user, wrong password and locked account look identical. */
  async loginWithPassword(
    identifierRaw: string,
    password: string,
    meta: RequestMeta,
  ): Promise<SignInResult> {
    const identifier = normalizeIdentifier(identifierRaw);
    const ipKey = `auth:login-fail:ip:${meta.ip ?? 'unknown'}`;
    if ((await this.limiter.peek(ipKey)) >= AUTH_POLICY.ipFailures.limit) {
      throw new AppError('RATE_LIMITED', {
        message: 'Too many failed sign-in attempts from this network. Try again later.',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: {
        status: { not: 'ANONYMIZED' },
        ...(identifier.kind === 'email'
          ? { email: identifier.value }
          : { phone: identifier.value }),
      },
      include: { credential: true },
    });
    const fail = async (userId: string | null, outcome: LoginOutcome) => {
      await this.recordAttempt(identifier.value, userId, outcome, meta);
      await this.limiter.hit(
        ipKey,
        AUTH_POLICY.ipFailures.limit,
        AUTH_POLICY.ipFailures.windowSeconds,
      );
      return new AppError('AUTH_INVALID_CREDENTIALS');
    };

    if (!user?.credential) {
      await burnPasswordCheck(password);
      throw await fail(user?.id ?? null, 'INVALID_CREDENTIALS');
    }

    const lock = await this.lockState(user.id);
    if (lock.lockedUntil) {
      await burnPasswordCheck(password);
      throw await fail(user.id, 'LOCKED');
    }

    if (!(await verifyPassword(user.credential.passwordHash, password))) {
      const error = await fail(user.id, 'INVALID_CREDENTIALS');
      if (lockMinutesFor(lock.failures + 1) > lockMinutesFor(lock.failures)) {
        await this.audit.record({
          action: 'auth.account_locked',
          targetType: 'user',
          targetId: user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          after: { failures: lock.failures + 1, minutes: lockMinutesFor(lock.failures + 1) },
          sensitivity: 'HIGH',
        });
        await this.alert(user.id, 'ACCOUNT_LOCKED');
      }
      throw error;
    }

    await this.assertCanSignIn(user, identifier.value, meta);
    if (needsRehash(user.credential.passwordHash)) {
      await this.prisma.userCredential.update({
        where: { userId: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    if (meta.app === 'ADMIN') return this.startMfa(user, identifier.value, meta);
    await this.recordAttempt(identifier.value, user.id, 'SUCCESS', meta);
    await this.limiter.reset(ipKey);
    return this.establishSession(user.id, meta);
  }

  /** Status checks after the credential is proven (FR-AUTH-003 steps 5–6). */
  private async assertCanSignIn(user: User, identifier: string, meta: RequestMeta): Promise<void> {
    if (user.status === 'SUSPENDED') {
      await this.recordAttempt(identifier, user.id, 'SUSPENDED', meta);
      throw new AppError('AUTH_ACCOUNT_SUSPENDED');
    }
    if (user.status === 'DEACTIVATED') {
      const reactivationToken = await this.issueToken(
        user.id,
        'REACTIVATE_ACCOUNT',
        AUTH_POLICY.reactivationTokenTtlSeconds,
      );
      throw new AppError('ACCOUNT_PENDING_DELETION', {
        message: 'This account is scheduled for deletion. You can reactivate it.',
        details: [{ code: 'REACTIVATION_TOKEN', message: reactivationToken }],
      });
    }
    const perms = await this.iam.resolve(user.id, user.permissionVersion);
    if (!appScopeFor(meta.app, perms)) {
      await this.recordAttempt(identifier, user.id, 'APP_NOT_PERMITTED', meta);
      throw new AppError('AUTH_APP_NOT_PERMITTED');
    }
  }

  /** BR-AUTH-018: admin-app sign-in needs an email OTP second factor until TOTP (CORE). */
  private async startMfa(user: User, identifier: string, meta: RequestMeta): Promise<SignInResult> {
    if (!user.email || !user.emailVerifiedAt) {
      throw new AppError('AUTH_APP_NOT_PERMITTED', {
        message: 'Admin accounts need a verified email for sign-in codes.',
      });
    }
    const mfaToken = await this.issueToken(user.id, 'MFA_LOGIN', AUTH_POLICY.mfaTokenTtlSeconds);
    const { code } = await this.otp.issue(user.email, 'MFA_LOGIN', user.id);
    await this.messages.send({
      channel: 'EMAIL',
      to: user.email,
      template: 'OTP',
      vars: { code, purpose: 'MFA_LOGIN', minutes: AUTH_POLICY.otp.ttlSeconds / 60 },
    });
    await this.recordAttempt(identifier, user.id, 'MFA_REQUIRED', meta);
    return {
      kind: 'mfa',
      mfaToken,
      mfaTokenExpiresAt: new Date(
        this.clock.now().getTime() + AUTH_POLICY.mfaTokenTtlSeconds * 1000,
      ),
    };
  }

  async completeMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<SignInResult> {
    const userId = await this.consumeToken(mfaToken, 'MFA_LOGIN', { peek: true });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    try {
      await this.otp.verify(user.email!, 'MFA_LOGIN', code);
    } catch (error) {
      await this.recordAttempt(user.email!, user.id, 'MFA_FAILED', meta);
      throw error instanceof AppError && error.code === 'AUTH_OTP_INVALID'
        ? new AppError('AUTH_MFA_INVALID')
        : error;
    }
    await this.consumeToken(mfaToken, 'MFA_LOGIN');
    await this.recordAttempt(user.email!, user.id, 'SUCCESS', meta);
    return this.establishSession(user.id, meta, { mfaVerified: true });
  }

  /** FR-AUTH-002: phone + OTP sign-in; creates the account on first use. */
  async loginWithOtp(
    input: { phone: string; code: string; fullName?: string; acceptTerms?: boolean },
    meta: RequestMeta,
  ): Promise<SignInResult> {
    if (meta.app === 'ADMIN') throw new AppError('AUTH_APP_NOT_PERMITTED');
    await this.otp.verify(input.phone, 'LOGIN', input.code);
    const existing = await this.prisma.user.findFirst({
      where: { phone: input.phone, status: { not: 'ANONYMIZED' } },
    });

    if (!existing) {
      if (!input.acceptTerms) throw new AppError('AUTH_TERMS_REQUIRED');
      const userId = await this.prisma.$transaction((tx) =>
        this.createAccount(
          tx,
          {
            fullName: input.fullName?.trim() ?? '',
            email: null,
            phone: input.phone,
            passwordHash: null,
            phoneVerified: true,
          },
          meta,
        ),
      );
      await this.recordAttempt(input.phone, userId, 'SUCCESS', meta);
      return this.establishSession(userId, meta);
    }

    if (existing.phoneVerifiedAt === null || existing.status === 'PENDING_VERIFICATION') {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          phoneVerifiedAt: existing.phoneVerifiedAt ?? this.clock.now(),
          status: existing.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : existing.status,
        },
      });
      existing.status = existing.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : existing.status;
    }
    await this.assertCanSignIn(existing, input.phone, meta);
    await this.recordAttempt(input.phone, existing.id, 'SUCCESS', meta);
    return this.establishSession(existing.id, meta);
  }

  // ---------------------------------------------------------------------------
  // OTP & verification
  // ---------------------------------------------------------------------------

  private async sendPhoneOtp(
    phone: string,
    purpose: 'LOGIN' | 'VERIFY_PHONE' | 'RESET_PASSWORD' | 'DELETE_ACCOUNT',
    userId?: string | null,
  ) {
    const { code } = await this.otp.issue(phone, purpose, userId);
    await this.messages.send({
      channel: 'SMS',
      to: phone,
      template: 'OTP',
      vars: { code, purpose, minutes: AUTH_POLICY.otp.ttlSeconds / 60 },
    });
  }

  /**
   * API-AUTH-002. Public purposes (LOGIN, RESET_PASSWORD) respond identically
   * whether or not the phone is registered; authenticated purposes always go to
   * the signed-in user's own phone.
   */
  async requestOtp(
    input: {
      phone?: string;
      purpose: 'LOGIN' | 'RESET_PASSWORD' | 'VERIFY_PHONE' | 'DELETE_ACCOUNT';
    },
    meta: RequestMeta,
    authUserId?: string,
  ): Promise<void> {
    if (input.purpose === 'VERIFY_PHONE' || input.purpose === 'DELETE_ACCOUNT') {
      if (!authUserId) throw new AppError('AUTH_TOKEN_MISSING');
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: authUserId },
        select: { phone: true, phoneVerifiedAt: true },
      });
      if (!user.phone)
        throw new AppError('VALIDATION_ERROR', { message: 'Add a phone number first.' });
      if (input.purpose === 'VERIFY_PHONE' && user.phoneVerifiedAt) return;
      await this.sendPhoneOtp(user.phone, input.purpose, authUserId);
      return;
    }
    if (!input.phone)
      throw new AppError('VALIDATION_ERROR', { message: 'Phone number is required.' });
    if (input.purpose === 'LOGIN') {
      if (meta.app === 'ADMIN') throw new AppError('AUTH_APP_NOT_PERMITTED');
      await this.sendPhoneOtp(input.phone, 'LOGIN');
      return;
    }
    const user = await this.prisma.user.findFirst({
      where: { phone: input.phone, status: { notIn: ['ANONYMIZED'] } },
      select: { id: true },
    });
    if (user) await this.sendPhoneOtp(input.phone, 'RESET_PASSWORD', user.id);
  }

  /** FR-AUTH-009 */
  async verifyPhone(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.phone)
      throw new AppError('VALIDATION_ERROR', { message: 'Add a phone number first.' });
    if (user.phoneVerifiedAt) return;
    await this.otp.verify(user.phone, 'VERIFY_PHONE', code);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneVerifiedAt: this.clock.now(),
        status: user.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : user.status,
      },
    });
    await this.sessions.invalidateUser(userId);
  }

  private async issueToken(
    userId: string,
    purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'MFA_LOGIN' | 'REACTIVATE_ACCOUNT',
    ttlSeconds: number,
  ): Promise<string> {
    const now = this.clock.now();
    const token = randomToken();
    await this.prisma.$transaction([
      this.prisma.verificationToken.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: now },
      }),
      this.prisma.verificationToken.create({
        data: {
          userId,
          purpose,
          tokenHash: sha256(token),
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
          createdAt: now,
        },
      }),
    ]);
    return token;
  }

  /** Validates (and unless `peek`, consumes) a single-use token; returns its user. */
  private async consumeToken(
    token: string,
    purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'MFA_LOGIN' | 'REACTIVATE_ACCOUNT',
    options: { peek?: boolean } = {},
  ): Promise<string> {
    const now = this.clock.now();
    const row = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!row || row.purpose !== purpose)
      throw new AppError('AUTH_TOKEN_INVALID', { message: 'This link is not valid.' });
    if (row.usedAt) throw new AppError('AUTH_TOKEN_USED');
    if (row.expiresAt <= now) throw new AppError('AUTH_TOKEN_EXPIRED');
    if (!options.peek) {
      const updated = await this.prisma.verificationToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (updated.count === 0) throw new AppError('AUTH_TOKEN_USED'); // lost a race with a concurrent use
    }
    return row.userId;
  }

  private async sendEmailVerificationFor(userId: string, app: ClientApp): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.email || user.emailVerifiedAt) return;
    const token = await this.issueToken(
      userId,
      'VERIFY_EMAIL',
      AUTH_POLICY.emailVerificationTtlSeconds,
    );
    const link = `${this.config.appUrls[app]}/verify-email?token=${encodeURIComponent(token)}`;
    await this.messages.send({
      channel: 'EMAIL',
      to: user.email,
      template: 'VERIFY_EMAIL',
      vars: { name: user.fullName || 'there', link },
    });
  }

  /** FR-AUTH-008 */
  async sendEmailVerification(userId: string, app: ClientApp): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user.email)
      throw new AppError('VALIDATION_ERROR', { message: 'Add an email address first.' });
    if (user.emailVerifiedAt) throw new AppError('AUTH_EMAIL_ALREADY_VERIFIED');
    await this.sendEmailVerificationFor(userId, app);
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeToken(token, 'VERIFY_EMAIL');
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: this.clock.now() },
    });
  }

  // ---------------------------------------------------------------------------
  // Passwords
  // ---------------------------------------------------------------------------

  /** FR-AUTH-011: always the same response, whether or not the account exists. */
  async forgotPassword(identifierRaw: string, app: ClientApp): Promise<void> {
    const identifier = normalizeIdentifier(identifierRaw);
    const user = await this.prisma.user.findFirst({
      where: {
        status: { notIn: ['ANONYMIZED'] },
        ...(identifier.kind === 'email'
          ? { email: identifier.value }
          : { phone: identifier.value }),
      },
    });
    if (!user) return;
    if (identifier.kind === 'email') {
      const token = await this.issueToken(
        user.id,
        'RESET_PASSWORD',
        AUTH_POLICY.passwordResetTtlSeconds,
      );
      const link = `${this.config.appUrls[app]}/reset-password?token=${encodeURIComponent(token)}`;
      await this.messages.send({
        channel: 'EMAIL',
        to: identifier.value,
        template: 'RESET_PASSWORD_EMAIL',
        vars: {
          name: user.fullName || 'there',
          link,
          minutes: AUTH_POLICY.passwordResetTtlSeconds / 60,
        },
      });
    } else {
      await this.sendPhoneOtp(identifier.value, 'RESET_PASSWORD', user.id).catch(
        (error: unknown) => {
          // Rate limits must not reveal whether the account exists.
          if (!(error instanceof AppError && error.code === 'RATE_LIMITED')) throw error;
        },
      );
    }
  }

  /** FR-AUTH-012: sets a new password and revokes every session. */
  async resetPassword(
    input: { token?: string; phone?: string; code?: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<void> {
    let userId: string;
    if (input.token) {
      userId = await this.consumeToken(input.token, 'RESET_PASSWORD', { peek: true });
    } else if (input.phone && input.code) {
      await this.otp.verify(input.phone, 'RESET_PASSWORD', input.code);
      const user = await this.prisma.user.findFirst({
        where: { phone: input.phone, status: { not: 'ANONYMIZED' } },
        select: { id: true },
      });
      if (!user) throw new AppError('AUTH_OTP_INVALID');
      userId = user.id;
    } else {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Provide a reset link token or a phone number and code.',
      });
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });
    const issue = checkPasswordPolicy(input.newPassword, user);
    if (issue) throw new AppError(issue);
    if (
      user.credential &&
      (await verifyPassword(user.credential.passwordHash, input.newPassword))
    ) {
      throw new AppError('AUTH_PASSWORD_WEAK', {
        message: 'Choose a password you have not used for this account.',
      });
    }
    if (input.token) await this.consumeToken(input.token, 'RESET_PASSWORD');
    const passwordHash = await hashPassword(input.newPassword);
    await this.prisma.userCredential.upsert({
      where: { userId },
      create: { userId, passwordHash },
      update: { passwordHash, passwordUpdatedAt: this.clock.now() },
    });
    await this.prisma.verificationToken.updateMany({
      where: { userId, purpose: 'RESET_PASSWORD', usedAt: null },
      data: { usedAt: this.clock.now() },
    });
    await this.sessions.revokeAll(userId, 'PASSWORD_RESET');
    await this.audit.record({
      action: 'auth.password_reset',
      targetType: 'user',
      targetId: userId,
      actorUserId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      sensitivity: 'HIGH',
    });
    await this.alert(userId, 'PASSWORD_RESET');
  }

  /** FR-AUTH-013: other sessions are revoked; the current one gets a fresh refresh token. */
  async changePassword(
    userId: string,
    sessionId: string,
    input: { currentPassword: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<{ refreshToken: string; refreshTokenExpiresAt: Date }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });
    if (
      !user.credential ||
      !(await verifyPassword(user.credential.passwordHash, input.currentPassword))
    ) {
      throw new AppError('AUTH_INVALID_CREDENTIALS', {
        message: 'Your current password is incorrect.',
      });
    }
    const issue = checkPasswordPolicy(input.newPassword, user);
    if (issue) throw new AppError(issue);
    await this.prisma.userCredential.update({
      where: { userId },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        passwordUpdatedAt: this.clock.now(),
      },
    });
    await this.sessions.revokeAll(userId, 'PASSWORD_CHANGED', sessionId);
    const reissued = await this.reissueRefreshToken(sessionId);
    await this.audit.record({
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: userId,
      actorUserId: userId,
      sessionId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      sensitivity: 'HIGH',
    });
    await this.alert(userId, 'PASSWORD_CHANGED');
    return reissued;
  }

  private async reissueRefreshToken(
    sessionId: string,
  ): Promise<{ refreshToken: string; refreshTokenExpiresAt: Date }> {
    const session = await this.prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });
    const refreshToken = randomToken();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { sessionId, status: { in: ['ACTIVE', 'ROTATED'] } },
        data: { status: 'REVOKED' },
      }),
      this.prisma.refreshToken.create({
        data: {
          sessionId,
          tokenHash: sha256(refreshToken),
          expiresAt: session.absoluteExpiresAt,
          issuedAt: this.clock.now(),
        },
      }),
    ]);
    return { refreshToken, refreshTokenExpiresAt: session.absoluteExpiresAt };
  }

  /** FR-AUTH-031 / API-AUTH-016: confirm identity for sensitive operations. */
  async reauthenticate(
    userId: string,
    sessionId: string,
    input: { password?: string; code?: string },
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });
    if (input.password !== undefined) {
      if (
        !user.credential ||
        !(await verifyPassword(user.credential.passwordHash, input.password))
      ) {
        throw new AppError('AUTH_INVALID_CREDENTIALS', { message: 'That password is incorrect.' });
      }
    } else if (input.code !== undefined && user.phone) {
      await this.otp.verify(user.phone, 'LOGIN', input.code);
    } else {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Provide your password or a code sent to your phone.',
      });
    }
    await this.sessions.markReauthenticated(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Sessions management
  // ---------------------------------------------------------------------------

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'LOGOUT');
  }

  async logoutAll(
    userId: string,
    currentSessionId: string,
    keepCurrent: boolean,
    meta: RequestMeta,
  ): Promise<number> {
    const revoked = await this.sessions.revokeAll(
      userId,
      'LOGOUT_ALL',
      keepCurrent ? currentSessionId : undefined,
    );
    await this.audit.record({
      action: 'auth.logout_all',
      targetType: 'user',
      targetId: userId,
      actorUserId: userId,
      sessionId: currentSessionId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      after: { revokedSessions: revoked.length, keepCurrent },
    });
    return revoked.length;
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.sessions.list(userId);
    return sessions.map((s) => ({
      id: s.id,
      app: s.app,
      device: s.deviceLabel ?? 'Unknown device',
      ip: maskIp(s.ip),
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      current: s.id === currentSessionId,
    }));
  }

  /** Revokes one of the caller's own sessions; other users' sessions look like "not found". */
  async revokeOwnSession(
    userId: string,
    sessionId: string,
    meta: RequestMeta & { currentSessionId: string },
  ): Promise<void> {
    const session = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!session) throw new AppError('AUTH_SESSION_NOT_FOUND');
    await this.sessions.revoke(sessionId, 'USER_REVOKED');
    await this.audit.record({
      action: 'auth.session_revoked',
      targetType: 'session',
      targetId: sessionId,
      actorUserId: userId,
      sessionId: meta.currentSessionId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
  }

  // ---------------------------------------------------------------------------
  // Account lifecycle
  // ---------------------------------------------------------------------------

  /** BR-AUTH-013: reasons an account cannot be deleted yet. */
  async deletionBlockers(userId: string): Promise<string[]> {
    const partner = await this.prisma.deliveryPartner.findUnique({
      where: { userId },
      select: { id: true },
    });
    const [openOrders, activeDeliveries, balances, disputes, soleOwnerships] = await Promise.all([
      this.prisma.order.count({
        where: { userId, status: { notIn: [...TERMINAL_ORDER_STATUSES] } },
      }),
      partner
        ? this.prisma.delivery.count({
            where: { partnerId: partner.id, status: { in: [...ACTIVE_DELIVERY_STATUSES] } },
          })
        : 0,
      this.prisma.ledgerAccount.count({
        where: {
          balance: { not: 0n },
          OR: [
            { ownerType: 'CUSTOMER', ownerId: userId, type: 'CUSTOMER_WALLET_HOLD' },
            ...(partner ? [{ ownerType: 'PARTNER' as const, ownerId: partner.id }] : []),
          ],
        },
      }),
      this.prisma.dispute.count({
        where: { raisedBy: userId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      }),
      this.prisma.restaurantMember.count({
        where: { userId, role: 'OWNER', status: 'ACTIVE', restaurant: { status: 'ACTIVE' } },
      }),
    ]);
    const blockers: string[] = [];
    if (openOrders) blockers.push('ACTIVE_ORDERS');
    if (activeDeliveries) blockers.push('ACTIVE_DELIVERY');
    if (balances) blockers.push('UNSETTLED_BALANCE');
    if (disputes) blockers.push('OPEN_DISPUTES');
    if (soleOwnerships) blockers.push('RESTAURANT_OWNER');
    return blockers;
  }

  /** FR-AUTH-041: deactivate now, anonymise after the grace period. */
  async requestDeletion(
    userId: string,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<{ deletionScheduledAt: Date }> {
    await this.sessions.requireRecentReauth(sessionId);
    const blockers = await this.deletionBlockers(userId);
    if (blockers.length > 0) {
      throw new AppError('ACCOUNT_DELETION_BLOCKED', {
        message: 'This account cannot be deleted yet.',
        details: blockers.map((code) => ({ code, message: code })),
      });
    }
    const deletionScheduledAt = new Date(
      this.clock.now().getTime() + AUTH_POLICY.deletionGraceDays * 86_400_000,
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: 'DEACTIVATED', deletionScheduledAt },
    });
    await this.sessions.revokeAll(userId, 'LOGOUT_ALL');
    await this.audit.record({
      action: 'account.deletion_requested',
      targetType: 'user',
      targetId: userId,
      actorUserId: userId,
      sessionId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      after: { deletionScheduledAt },
      sensitivity: 'HIGH',
    });
    await this.alert(userId, 'ACCOUNT_DELETION_REQUESTED');
    return { deletionScheduledAt };
  }

  /** FR-AUTH-042: reactivation during the grace period, using the token issued at sign-in. */
  async reactivate(token: string, meta: RequestMeta): Promise<SignInResult> {
    const userId = await this.consumeToken(token, 'REACTIVATE_ACCOUNT');
    const updated = await this.prisma.user.updateMany({
      where: { id: userId, status: 'DEACTIVATED' },
      data: { status: 'ACTIVE', deletionScheduledAt: null },
    });
    if (updated.count === 0)
      throw new AppError('AUTH_TOKEN_INVALID', {
        message: 'This account can no longer be reactivated.',
      });
    await this.audit.record({
      action: 'account.reactivated',
      targetType: 'user',
      targetId: userId,
      actorUserId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      sensitivity: 'HIGH',
    });
    await this.alert(userId, 'ACCOUNT_REACTIVATED');
    return this.establishSession(userId, meta);
  }

  /**
   * JOB-USER-001: anonymises accounts whose grace period has ended. Orders,
   * payments and ledger rows stay (legal retention) but point to an anonymous user.
   */
  async anonymizeDueUsers(limit = 100): Promise<number> {
    const due = await this.prisma.user.findMany({
      where: { status: 'DEACTIVATED', deletionScheduledAt: { lte: this.clock.now() } },
      select: { id: true },
      take: limit,
    });
    for (const { id } of due) await this.anonymize(id);
    return due.length;
  }

  private async anonymize(userId: string): Promise<void> {
    const tombstone = Buffer.from(hmac(this.config.hmacSecret, 'anonymized-user', userId))
      .toString('hex')
      .slice(0, 24);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.status !== 'DEACTIVATED') return; // reactivated meanwhile
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'ANONYMIZED',
          fullName: 'Deleted user',
          email: `deleted-${tombstone}@deleted.invalid`,
          phone: null,
          emailVerifiedAt: null,
          phoneVerifiedAt: null,
          avatarFileId: null,
          deletionScheduledAt: null,
          tokenVersion: { increment: 1 },
        },
      });
      await tx.$executeRaw`
        UPDATE customer_addresses
        SET line1 = 'Deleted', line2 = NULL, landmark = NULL, area = 'Deleted', contact_name = 'Deleted user',
            contact_phone = '+910000000000', instructions = NULL, location = ST_GeogFromText('SRID=4326;POINT(0 0)'),
            is_default = false, deleted_at = COALESCE(deleted_at, now())
        WHERE user_id = ${userId}::uuid`;
      await tx.userCredential.deleteMany({ where: { userId } });
      await tx.oAuthAccount.deleteMany({ where: { userId } });
      await tx.mfaFactor.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.pushSubscription.deleteMany({ where: { userId } });
      await tx.searchHistory.deleteMany({ where: { userId } });
      await tx.customerAllergen.deleteMany({ where: { userId } });
      await tx.customerDietaryPreference.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.verificationToken.deleteMany({ where: { userId } });
      await this.audit.record(
        { action: 'account.anonymized', targetType: 'user', targetId: userId, sensitivity: 'HIGH' },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Read models
  // ---------------------------------------------------------------------------

  async me(userId: string, app: ClientApp): Promise<UserSummary> {
    return (await this.summarize(userId, app)).user;
  }

  /** Sends a security alert to the user's verified channels; failures are logged, never thrown. */
  private async alert(userId: string, event: SecurityEvent): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;
      const name = user.fullName || 'there';
      if (user.email && user.emailVerifiedAt) {
        await this.messages.send({
          channel: 'EMAIL',
          to: user.email,
          template: 'SECURITY_ALERT',
          vars: { name, event },
        });
      }
      if (
        user.phone &&
        ['SESSION_REUSE_DETECTED', 'ACCOUNT_LOCKED', 'PASSWORD_RESET'].includes(event)
      ) {
        await this.messages.send({
          channel: 'SMS',
          to: user.phone,
          template: 'SECURITY_ALERT',
          vars: { name, event },
        });
      }
    } catch (error) {
      this.logger.warn({ err: error, userId, event }, 'could not send security alert');
    }
  }
}

/** Shows the network, hides the host: 203.0.113.42 → 203.0.113.x (FR-AUTH-007). */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.x');
  return ip.replace(/:[0-9a-f]*:[0-9a-f]*$/i, ':x:x');
}
