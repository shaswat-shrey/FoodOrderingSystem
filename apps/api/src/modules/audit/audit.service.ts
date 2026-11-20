import type { Prisma, PrismaClient } from '@fos/db';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  actorUserId?: string | null;
  actorRoles?: string[];
  sessionId?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  sensitivity?: 'NORMAL' | 'HIGH';
}

const SENSITIVE = /password|token|otp|secret|hash|accountnumber|pan|aadhaar|cookie|authorization/i;

/** Replaces values of sensitive keys at any depth (FR-AUDIT-001: "sensitive fields redacted"). */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE.test(k) ? '[REDACTED]' : redact(v),
      ]),
    );
  }
  return value;
}

/** Append-only audit writer (FR-AUDIT-001). Pass a transaction client to audit atomically with the change. */
export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        actorUserId: entry.actorUserId ?? null,
        actorRoles: entry.actorRoles ?? [],
        sessionId: entry.sessionId ?? null,
        reason: entry.reason ?? null,
        before: (entry.before ? redact(entry.before) : undefined) as
          Prisma.InputJsonValue | undefined,
        after: (entry.after ? redact(entry.after) : undefined) as Prisma.InputJsonValue | undefined,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 512) ?? null,
        requestId: entry.requestId ?? null,
        sensitivity: entry.sensitivity ?? 'NORMAL',
      },
    });
  }
}
