import type { PrismaClient, RestaurantRole } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { randomToken, sha256 } from '../../platform/crypto';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import type { RestaurantGrant } from '../iam';
import type { MessageDispatcher } from '../notifications';
import type { PermissionChanges } from './access';

const RANK: Record<RestaurantRole, number> = {
  OWNER: 4,
  MANAGER: 3,
  ORDER_MANAGER: 2,
  KITCHEN: 1,
  STAFF: 1,
};
const INVITE_DAYS = 7; // FR-RSTAFF-001
export const INVITABLE_ROLES = ['MANAGER', 'ORDER_MANAGER', 'KITCHEN', 'STAFF'] as const;

export interface Scope {
  allBranches: boolean;
  branchIds?: string[] | undefined;
}

const maskPhone = (p: string | null) => (p ? `${p.slice(0, 3)}XXXXX${p.slice(-4)}` : null);

/** Restaurant staff (FR-RSTAFF-001/002, API-RSTAFF-001…008). */
export class StaffService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messages: MessageDispatcher,
    private readonly permissionChanges: PermissionChanges,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly appUrl: string,
  ) {}

  /** The actor may only hand out roles below their own, inside their own branch scope. */
  private async checkGrant(
    actor: RestaurantGrant,
    restaurantId: string,
    role: RestaurantRole,
    scope: Scope,
  ) {
    if (role === 'OWNER')
      throw new AppError('FORBIDDEN', { message: 'Ownership is transferred, not granted.' });
    if (RANK[role] >= RANK[actor.role] && actor.role !== 'OWNER')
      throw new AppError('FORBIDDEN', { message: 'You can only give roles below your own.' });
    if (!scope.allBranches) {
      if (!scope.branchIds?.length)
        throw new AppError('VALIDATION_ERROR', {
          details: [{ path: 'branchIds', code: 'REQUIRED', message: 'Pick at least one outlet.' }],
        });
      const found = await this.prisma.branch.count({
        where: { id: { in: scope.branchIds }, restaurantId, deletedAt: null },
      });
      if (found !== new Set(scope.branchIds).size)
        throw new AppError('VALIDATION_ERROR', {
          details: [{ path: 'branchIds', code: 'INVALID', message: 'Unknown outlet.' }],
        });
      if (!actor.allBranches && scope.branchIds.some((b) => !actor.branchIds.includes(b)))
        throw new AppError('FORBIDDEN', {
          message: 'You can only add people to your own outlets.',
        });
    } else if (!actor.allBranches) {
      throw new AppError('FORBIDDEN', { message: 'You can only add people to your own outlets.' });
    }
  }

  /** API-RSTAFF-001 */
  async members(restaurantId: string) {
    const rows = await this.prisma.restaurantMember.findMany({
      where: { restaurantId, status: { not: 'REMOVED' } },
      include: {
        user: { select: { fullName: true, phone: true, email: true } },
        branches: { select: { branch: { select: { id: true, name: true } } } },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows
      .sort((a, b) => RANK[b.role] - RANK[a.role])
      .map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.fullName,
        phone: maskPhone(m.user.phone),
        email: m.user.email,
        role: m.role,
        status: m.status,
        allBranches: m.allBranches,
        branches: m.branches.map((b) => b.branch),
        since: m.createdAt,
      }));
  }

  /** API-RSTAFF-002 */
  async invite(
    actorId: string,
    actor: RestaurantGrant,
    restaurantId: string,
    input: { phone?: string | undefined; email?: string | undefined; role: RestaurantRole } & Scope,
  ) {
    await this.checkGrant(actor, restaurantId, input.role, input);
    const existing = await this.prisma.restaurantMember.findFirst({
      where: {
        restaurantId,
        status: { not: 'REMOVED' },
        user: {
          OR: [
            ...(input.phone ? [{ phone: input.phone }] : []),
            ...(input.email ? [{ email: input.email }] : []),
          ],
        },
      },
    });
    if (existing) throw new AppError('MEMBER_EXISTS');
    const token = randomToken();
    const now = this.clock.now();
    const invitation = await this.prisma.$transaction(async (tx) => {
      // A newer invite replaces an older pending one to the same person.
      await tx.restaurantInvitation.updateMany({
        where: {
          restaurantId,
          status: 'PENDING',
          OR: [
            ...(input.phone ? [{ phone: input.phone }] : []),
            ...(input.email ? [{ email: input.email }] : []),
          ],
        },
        data: { status: 'REVOKED' },
      });
      const inv = await tx.restaurantInvitation.create({
        data: {
          restaurantId,
          invitedBy: actorId,
          phone: input.phone ?? null,
          email: input.email ?? null,
          role: input.role,
          allBranches: input.allBranches,
          tokenHash: sha256(token),
          expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
          createdAt: now,
          ...(input.allBranches
            ? {}
            : { branches: { create: input.branchIds!.map((branchId) => ({ branchId })) } }),
        },
      });
      await this.audit.record(
        {
          action: 'restaurant.member_invited',
          targetType: 'restaurant',
          targetId: restaurantId,
          actorUserId: actorId,
          after: { invitationId: inv.id, role: input.role },
        },
        tx,
      );
      return inv;
    });
    const r = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { brandName: true },
    });
    const link = `${this.appUrl}/invite/${token}`;
    const text = `You're invited to join ${r.brandName} on FoodOrderSystem as ${input.role.replace('_', ' ').toLowerCase()}. Accept within ${INVITE_DAYS} days: ${link}`;
    const subject = `Join ${r.brandName} on FoodOrderSystem`;
    if (input.phone)
      await this.messages.send({
        channel: 'SMS',
        to: input.phone,
        template: 'RENDERED',
        vars: { subject, text },
      });
    if (input.email)
      await this.messages.send({
        channel: 'EMAIL',
        to: input.email,
        template: 'RENDERED',
        vars: { subject, text },
      });
    return this.invitationView(invitation.id);
  }

  private async invitationView(id: string) {
    const i = await this.prisma.restaurantInvitation.findUniqueOrThrow({
      where: { id },
      include: { branches: { select: { branch: { select: { id: true, name: true } } } } },
    });
    return {
      id: i.id,
      phone: maskPhone(i.phone),
      email: i.email,
      role: i.role,
      allBranches: i.allBranches,
      branches: i.branches.map((b) => b.branch),
      status: i.status === 'PENDING' && i.expiresAt <= this.clock.now() ? 'EXPIRED' : i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    };
  }

  /** API-RSTAFF-003 */
  async invitations(restaurantId: string) {
    const rows = await this.prisma.restaurantInvitation.findMany({
      where: { restaurantId, status: 'PENDING', expiresAt: { gt: this.clock.now() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return Promise.all(rows.map((r) => this.invitationView(r.id)));
  }

  /** API-RSTAFF-004 */
  async revokeInvitation(
    actorId: string,
    actor: RestaurantGrant,
    restaurantId: string,
    id: string,
  ) {
    const inv = await this.prisma.restaurantInvitation.findFirst({
      where: { id, restaurantId, status: 'PENDING' },
    });
    if (!inv) throw new AppError('NOT_FOUND', { message: "We couldn't find that invitation." });
    if (actor.role !== 'OWNER' && RANK[inv.role] >= RANK[actor.role])
      throw new AppError('FORBIDDEN');
    await this.prisma.restaurantInvitation.update({ where: { id }, data: { status: 'REVOKED' } });
    await this.audit.record({
      action: 'restaurant.invitation_revoked',
      targetType: 'restaurant',
      targetId: restaurantId,
      actorUserId: actorId,
      after: { invitationId: id },
    });
  }

  private async byToken(token: string) {
    const inv = await this.prisma.restaurantInvitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        restaurant: { select: { id: true, brandName: true } },
        inviter: { select: { fullName: true } },
        branches: { select: { branch: { select: { id: true, name: true } } } },
      },
    });
    if (!inv || inv.status !== 'PENDING' || inv.expiresAt <= this.clock.now())
      throw new AppError('INVITATION_INVALID');
    return inv;
  }

  /** API-RSTAFF-005 (public preview): enough to decide, nothing about the invitee. */
  async preview(token: string) {
    const inv = await this.byToken(token);
    return {
      restaurant: inv.restaurant.brandName,
      role: inv.role,
      allBranches: inv.allBranches,
      branches: inv.branches.map((b) => b.branch.name),
      invitedBy: inv.inviter.fullName.split(/\s+/)[0],
      expiresAt: inv.expiresAt,
      sentTo: inv.phone ? 'PHONE' : 'EMAIL',
    };
  }

  /** API-RSTAFF-006: the signed-in user's verified phone or email must match. */
  async accept(userId: string, token: string) {
    const inv = await this.byToken(token);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phone: true, phoneVerifiedAt: true, email: true, emailVerifiedAt: true },
    });
    const phoneOk = inv.phone && user.phoneVerifiedAt && user.phone === inv.phone;
    const emailOk =
      inv.email && user.emailVerifiedAt && user.email?.toLowerCase() === inv.email.toLowerCase();
    if (!phoneOk && !emailOk) throw new AppError('INVITATION_MISMATCH');
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.restaurantInvitation.updateMany({
        where: { id: inv.id, status: 'PENDING' },
        data: { status: 'ACCEPTED' },
      });
      if (!claimed.count) throw new AppError('INVITATION_INVALID');
      const existing = await tx.restaurantMember.findFirst({
        where: { restaurantId: inv.restaurantId, userId },
      });
      if (existing && existing.status !== 'REMOVED') throw new AppError('MEMBER_EXISTS');
      const member = existing
        ? await tx.restaurantMember.update({
            where: { id: existing.id },
            data: { role: inv.role, status: 'ACTIVE', allBranches: inv.allBranches },
          })
        : await tx.restaurantMember.create({
            data: {
              restaurantId: inv.restaurantId,
              userId,
              role: inv.role,
              allBranches: inv.allBranches,
            },
          });
      await tx.restaurantMemberBranch.deleteMany({ where: { memberId: member.id } });
      if (!inv.allBranches)
        await tx.restaurantMemberBranch.createMany({
          data: inv.branches.map((b) => ({ memberId: member.id, branchId: b.branch.id })),
        });
      await this.audit.record(
        {
          action: 'restaurant.member_joined',
          targetType: 'restaurant',
          targetId: inv.restaurantId,
          actorUserId: userId,
          after: { role: inv.role, invitationId: inv.id },
        },
        tx,
      );
    });
    await this.permissionChanges.changed(userId);
    return { restaurantId: inv.restaurantId, restaurant: inv.restaurant.brandName, role: inv.role };
  }

  private async manageable(
    actor: RestaurantGrant,
    actorId: string,
    restaurantId: string,
    memberId: string,
  ) {
    const m = await this.prisma.restaurantMember.findFirst({
      where: { id: memberId, restaurantId, status: { not: 'REMOVED' } },
      include: { branches: true },
    });
    if (!m) throw new AppError('NOT_FOUND', { message: "We couldn't find that team member." });
    if (m.userId === actorId)
      throw new AppError('FORBIDDEN', { message: 'You can’t change your own access.' });
    if (m.role === 'OWNER')
      throw new AppError('FORBIDDEN', { message: 'The owner can’t be changed here.' });
    if (actor.role !== 'OWNER' && RANK[m.role] >= RANK[actor.role])
      throw new AppError('FORBIDDEN', { message: 'You can only manage roles below your own.' });
    if (
      !actor.allBranches &&
      (m.allBranches || m.branches.some((b) => !actor.branchIds.includes(b.branchId)))
    )
      throw new AppError('FORBIDDEN', { message: 'This person works outside your outlets.' });
    return m;
  }

  /** API-RSTAFF-007: role, branch scope, suspend/reactivate. Takes effect on the next request. */
  async update(
    actorId: string,
    actor: RestaurantGrant,
    restaurantId: string,
    memberId: string,
    patch: {
      role?: RestaurantRole | undefined;
      status?: 'ACTIVE' | 'SUSPENDED' | undefined;
      scope?: Scope | undefined;
    },
  ) {
    const m = await this.manageable(actor, actorId, restaurantId, memberId);
    const role = patch.role ?? m.role;
    const scope = patch.scope ?? {
      allBranches: m.allBranches,
      branchIds: m.branches.map((b) => b.branchId),
    };
    await this.checkGrant(actor, restaurantId, role, scope);
    await this.prisma.$transaction(async (tx) => {
      await tx.restaurantMember.update({
        where: { id: memberId },
        data: {
          role,
          allBranches: scope.allBranches,
          ...(patch.status ? { status: patch.status } : {}),
        },
      });
      if (patch.scope) {
        await tx.restaurantMemberBranch.deleteMany({ where: { memberId } });
        if (!scope.allBranches)
          await tx.restaurantMemberBranch.createMany({
            data: scope.branchIds!.map((branchId) => ({ memberId, branchId })),
          });
      }
      await this.audit.record(
        {
          action: 'restaurant.member_updated',
          targetType: 'restaurant',
          targetId: restaurantId,
          actorUserId: actorId,
          before: { role: m.role, status: m.status },
          after: { memberId, role, status: patch.status ?? m.status },
        },
        tx,
      );
    });
    await this.permissionChanges.changed(m.userId);
    return (await this.members(restaurantId)).find((x) => x.id === memberId)!;
  }

  /** API-RSTAFF-008: access ends on the member's next request (FR-RSTAFF-002). */
  async remove(actorId: string, actor: RestaurantGrant, restaurantId: string, memberId: string) {
    const m = await this.manageable(actor, actorId, restaurantId, memberId);
    await this.prisma.$transaction(async (tx) => {
      await tx.restaurantMember.update({ where: { id: memberId }, data: { status: 'REMOVED' } });
      await tx.restaurantMemberBranch.deleteMany({ where: { memberId } });
      await this.audit.record(
        {
          action: 'restaurant.member_removed',
          targetType: 'restaurant',
          targetId: restaurantId,
          actorUserId: actorId,
          after: { memberId, role: m.role },
        },
        tx,
      );
    });
    await this.permissionChanges.changed(m.userId);
  }
}
