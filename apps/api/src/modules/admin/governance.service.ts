import type { AuditSensitivity, Prisma, PrismaClient } from '@fos/db';
import { QUEUE_NAMES, type QueueName } from '@fos/shared';
import { AppError } from '../../platform/http/errors';
import type { JobQueue } from '../../platform/jobs';
import type { AuditService } from '../audit';
import type { PermissionChanges } from '../merchant';
import { auditAs, pageArgs, pageMeta, type AdminActor, type Page } from './admin.http';

/** Platform roles an admin grants here; customer/partner/owner roles come from sign-up and onboarding. */
export const STAFF_ROLES = ['SUPPORT_AGENT', 'ADMIN', 'SUPER_ADMIN'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface AuditFilter extends Page {
  actor?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  action?: string | undefined;
  sensitivity?: AuditSensitivity | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/**
 * Roles and permissions (FR-ADMIN-110, API-ADM-180/183…185), the audit trail
 * (FR-AUDIT-003, API-ADM-187) and dead-letter jobs (E27, API-ADM-202/203).
 */
export class AdminGovernanceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissionChanges: PermissionChanges,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------ IAM ------------------------------ */

  /** API-ADM-180: every role with its permissions and holders. */
  async roles() {
    const rows = await this.prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: {
        permissions: { select: { permission: { select: { key: true } } } },
        _count: { select: { users: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      system: r.isSystem,
      appScope: r.appScope,
      assignable: (STAFF_ROLES as readonly string[]).includes(r.key),
      userCount: r._count.users,
      permissions: r.permissions.map((p) => p.permission.key).sort(),
    }));
  }

  /** API-ADM-183: the permission catalogue and which platform roles hold each one. */
  async permissions() {
    const rows = await this.prisma.permission.findMany({
      orderBy: { key: 'asc' },
      include: { roles: { select: { role: { select: { key: true } } } } },
    });
    return rows.map((p) => ({
      key: p.key,
      description: p.description,
      scope: p.scopeType,
      roles: p.roles.map((r) => r.role.key).sort(),
    }));
  }

  private async roleRow(key: StaffRole) {
    const role = await this.prisma.role.findUnique({ where: { key } });
    if (!role) throw new AppError('NOT_FOUND', { message: `The role ${key} is not set up.` });
    return role;
  }

  /** BR-ADMIN-001 / FR-ADMIN-110: nobody changes their own roles; only super admins make super admins. */
  private guard(actor: AdminActor, userId: string, role: StaffRole) {
    if (actor.userId === userId)
      throw new AppError('FORBIDDEN', { message: 'You can’t change your own roles.' });
    if (role === 'SUPER_ADMIN' && !actor.roles.includes('SUPER_ADMIN'))
      throw new AppError('FORBIDDEN', {
        message: 'Only a super admin can grant or revoke super admin.',
      });
  }

  private async userRoles(userId: string) {
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: { select: { key: true } } },
    });
    return roles.map((r) => r.role.key).sort();
  }

  /** API-ADM-184 ★: takes effect on the user's very next request (FR-AUTH-024). */
  async grantRole(actor: AdminActor, userId: string, role: StaffRole, reason: string) {
    this.guard(actor, userId, role);
    const r = await this.roleRow(role);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status === 'ANONYMIZED')
        throw new AppError('NOT_FOUND', { message: "We couldn't find that user." });
      if (!['ACTIVE', 'PENDING_VERIFICATION'].includes(user.status))
        throw new AppError('ACCOUNT_STATE_CONFLICT', {
          message: 'Reactivate this account before giving it a staff role.',
        });
      // FR-ADMIN-111: the admin console's second factor is emailed.
      if (!user.email || !user.emailVerifiedAt)
        throw new AppError('VALIDATION_ERROR', {
          message: 'Staff accounts need a verified email for the second sign-in factor.',
        });
      if (await tx.userRole.findUnique({ where: { userId_roleId: { userId, roleId: r.id } } }))
        throw new AppError('RESOURCE_CONFLICT', { message: `They already have ${role}.` });
      const before = await tx.userRole.findMany({
        where: { userId },
        select: { role: { select: { key: true } } },
      });
      await tx.userRole.create({ data: { userId, roleId: r.id, grantedBy: actor.userId } });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.role_granted',
          targetType: 'user',
          targetId: userId,
          reason,
          before: { roles: before.map((b) => b.role.key).sort() },
          after: { granted: role },
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    await this.permissionChanges.changed(userId);
    return { userId, roles: await this.userRoles(userId) };
  }

  /** API-ADM-185 ★ (BR-ADMIN-004): the last active super admin can't be removed. */
  async revokeRole(actor: AdminActor, userId: string, role: StaffRole, reason: string) {
    this.guard(actor, userId, role);
    const r = await this.roleRow(role);
    await this.prisma.$transaction(async (tx) => {
      // Serialise super-admin changes so two revocations can't both pass the check.
      await tx.$queryRaw`SELECT id FROM roles WHERE id = ${r.id}::uuid FOR UPDATE`;
      if (!(await tx.userRole.findUnique({ where: { userId_roleId: { userId, roleId: r.id } } })))
        throw new AppError('NOT_FOUND', { message: `They don't have ${role}.` });
      if (role === 'SUPER_ADMIN') {
        const others = await tx.userRole.count({
          where: { roleId: r.id, userId: { not: userId }, user: { status: 'ACTIVE' } },
        });
        if (others === 0)
          throw new AppError('RESOURCE_CONFLICT', {
            message: 'This is the last active super admin; grant another one first.',
          });
      }
      await tx.userRole.delete({ where: { userId_roleId: { userId, roleId: r.id } } });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.role_revoked',
          targetType: 'user',
          targetId: userId,
          reason,
          before: { revoked: role },
          sensitivity: 'HIGH',
        },
        tx,
      );
    });
    await this.permissionChanges.changed(userId);
    return { userId, roles: await this.userRoles(userId) };
  }

  /* ------------------------------ audit ------------------------------ */

  /** API-ADM-187 (FR-AUDIT-003): newest first; `action` matches as a prefix. */
  async auditLogs(f: AuditFilter) {
    const where: Prisma.AuditLogWhereInput = {
      ...(f.actor ? { actorUserId: f.actor } : {}),
      ...(f.targetType ? { targetType: f.targetType } : {}),
      ...(f.targetId ? { targetId: f.targetId } : {}),
      ...(f.action ? { action: { startsWith: f.action } } : {}),
      ...(f.sensitivity ? { sensitivity: f.sensitivity } : {}),
      ...(f.from || f.to
        ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(f),
        include: { actor: { select: { id: true, fullName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((a) => ({
        id: a.id,
        action: a.action,
        actor: a.actor,
        actorRoles: a.actorRoles,
        target: { type: a.targetType, id: a.targetId },
        reason: a.reason,
        before: a.before,
        after: a.after,
        sensitivity: a.sensitivity,
        ip: a.ip,
        requestId: a.requestId,
        createdAt: a.createdAt,
      })),
      meta: pageMeta(f, total),
    };
  }

  /* ------------------------------ jobs ------------------------------ */

  /** API-ADM-202: dead-lettered jobs of one queue, or of every queue. */
  async failedJobs(queue: QueueName | undefined, limit: number) {
    const queues = queue ? [queue] : [...QUEUE_NAMES];
    const lists = await Promise.all(queues.map((q) => this.jobs.failed(q, limit)));
    return lists
      .flat()
      .sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  /** API-ADM-203 ★ */
  async retryJob(actor: AdminActor, queue: QueueName, jobId: string, reason: string) {
    if (!(await this.jobs.retry(queue, jobId)))
      throw new AppError('NOT_FOUND', { message: 'That job is not in the failed list.' });
    await auditAs(this.audit, actor, {
      action: 'admin.job_retried',
      targetType: 'job',
      targetId: `${queue}:${jobId}`.slice(0, 100),
      reason,
      sensitivity: 'HIGH',
    });
    return { queue, jobId, retried: true };
  }
}
