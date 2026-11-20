import { createHash } from 'node:crypto';
import type { ClientApp, File, FilePurpose, Prisma, PrismaClient } from '@fos/db';
import { uuidv7 } from '@fos/shared';
import sharp from 'sharp';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import type { AuditService } from '../audit';
import {
  DERIVATIVES,
  detectType,
  EXTENSION,
  PURPOSES,
  type DerivativeName,
  type DetectedType,
} from './policy';
import type { StorageProvider } from './storage';

type Tx = Prisma.TransactionClient;
const SIGNED_URL_SECONDS = 300; // FR-FILE-004
const MAX_PIXELS = 40_000_000;

export interface Uploader {
  userId: string;
  app: ClientApp;
}

/** Who else may read a private file besides its owner (decided by the module that attached it). */
export type AccessCheck = (file: File) => Promise<boolean>;

/**
 * Uploads (FR-FILE-001…006): purpose rules, magic-byte typing, EXIF stripped by
 * re-encoding, WebP derivatives for public images, private files only through
 * short-lived signed URLs.
 */
export class FilesService {
  private readonly checks: AccessCheck[] = [];

  constructor(
    private readonly prisma: PrismaClient,
    readonly storage: StorageProvider,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Modules register who may read files they own (e.g. admins reviewing documents). */
  allow(check: AccessCheck): void {
    this.checks.push(check);
  }

  private async sanitize(type: DetectedType, input: Buffer) {
    if (type === 'application/pdf') return { body: input, width: null, height: null };
    try {
      // rotate() applies EXIF orientation; re-encoding drops all metadata incl. GPS.
      const img = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
      const encoded =
        type === 'image/jpeg'
          ? img.jpeg({ quality: 88, mozjpeg: true })
          : type === 'image/png'
            ? img.png({ compressionLevel: 9 })
            : img.webp({ quality: 86 });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      return { body: data, width: info.width, height: info.height };
    } catch (error) {
      throw new AppError('FILE_TYPE_NOT_ALLOWED', {
        message: 'This image could not be read. Try another file.',
        cause: error,
      });
    }
  }

  private derivativeKey(key: string, name: DerivativeName) {
    return `${key.replace(/\.\w+$/, '')}.${name}.webp`;
  }

  /** API-FILE-001 */
  async upload(who: Uploader, purpose: FilePurpose, input: Buffer) {
    const rule = PURPOSES[purpose];
    if (!rule || !rule.apps.includes(who.app))
      throw new AppError('FORBIDDEN', { message: 'You cannot upload this kind of file here.' });
    if (input.length > rule.maxBytes)
      throw new AppError('FILE_TOO_LARGE', {
        message: `Files of this kind can be at most ${rule.maxBytes / 1024 / 1024} MB.`,
      });
    const type = detectType(input.subarray(0, 16));
    if (!type || !rule.types.includes(type))
      throw new AppError('FILE_TYPE_NOT_ALLOWED', {
        message: `Allowed: ${rule.types.map((t) => EXTENSION[t].toUpperCase()).join(', ')}.`,
      });
    const { body, width, height } = await this.sanitize(type, input);
    const id = uuidv7();
    const now = this.clock.now();
    const key = `${purpose.toLowerCase()}/${now.toISOString().slice(0, 7)}/${id}.${EXTENSION[type]}`;
    // FR-FILE-003: public images are served as derivatives; the original stays private (owner only).
    const derivativeBucket = rule.visibility === 'PUBLIC' ? 'public' : 'private';
    const bucket = rule.visibility === 'PUBLIC' && !rule.derivatives ? 'public' : 'private';
    await this.storage.put(bucket, key, body, type);
    if (rule.derivatives) {
      for (const [name, w] of Object.entries(DERIVATIVES) as [DerivativeName, number][]) {
        const d = await sharp(body)
          .resize({ width: w, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        await this.storage.put(derivativeBucket, this.derivativeKey(key, name), d, 'image/webp');
      }
    }
    const file = await this.prisma.file.create({
      data: {
        id,
        ownerUserId: who.userId,
        purpose,
        bucket,
        objectKey: key,
        mimeType: type,
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest(),
        width,
        height,
        visibility: rule.visibility,
        createdAt: now,
      },
    });
    return this.view(file);
  }

  /** Public URLs: the WebP derivatives of public images (originals are private, FR-FILE-003). */
  urls(file: Pick<File, 'objectKey' | 'visibility' | 'purpose'>) {
    if (file.visibility !== 'PUBLIC') return null;
    if (!PURPOSES[file.purpose]?.derivatives)
      return { original: this.storage.publicUrl(file.objectKey) };
    return Object.fromEntries(
      (Object.keys(DERIVATIVES) as DerivativeName[]).map((n) => [
        n,
        this.storage.publicUrl(this.derivativeKey(file.objectKey, n)),
      ]),
    ) as Partial<Record<DerivativeName | 'original', string>>;
  }

  view(file: File) {
    return {
      id: file.id,
      purpose: file.purpose,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
      visibility: file.visibility,
      status: file.status,
      urls: this.urls(file),
      createdAt: file.createdAt,
    };
  }

  /** API-FILE-002 (FR-FILE-004): owner or an authorised reader; every grant is audited. */
  async signedUrl(who: Uploader & { sessionId?: string }, fileId: string) {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.status === 'DELETED')
      throw new AppError('NOT_FOUND', { message: "We couldn't find that file." });
    let allowed = file.ownerUserId === who.userId;
    for (const check of this.checks) if (!allowed) allowed = await check(file);
    if (!allowed) throw new AppError('NOT_FOUND', { message: "We couldn't find that file." });
    if (file.bucket === 'public')
      return { url: this.storage.publicUrl(file.objectKey), expiresAt: null };
    const url = await this.storage.signedUrl(file.objectKey, SIGNED_URL_SECONDS, this.clock.now());
    await this.audit.record({
      action: 'file.signed_url',
      targetType: 'file',
      targetId: file.id,
      actorUserId: who.userId,
      sessionId: who.sessionId ?? null,
      after: { purpose: file.purpose },
      sensitivity: 'HIGH',
    });
    return {
      url,
      expiresAt: new Date(this.clock.now().getTime() + SIGNED_URL_SECONDS * 1000),
    };
  }

  /**
   * API-ADM-040 (FR-FILE-004): a signed URL for platform staff. The caller has
   * already checked the platform permission (e.g. `document:read`); the grant is
   * audited against what was viewed (`subject`), not only the file.
   */
  async signedUrlForStaff(
    who: { userId: string; sessionId?: string | null; roles?: string[] },
    fileId: string,
    subject: { type: string; id: string; reason?: string | null },
  ) {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.status === 'DELETED')
      throw new AppError('NOT_FOUND', { message: "We couldn't find that file." });
    const expiresAt = new Date(this.clock.now().getTime() + SIGNED_URL_SECONDS * 1000);
    const url =
      file.bucket === 'public'
        ? this.storage.publicUrl(file.objectKey)
        : await this.storage.signedUrl(file.objectKey, SIGNED_URL_SECONDS, this.clock.now());
    await this.audit.record({
      action: 'file.signed_url',
      targetType: subject.type,
      targetId: subject.id,
      actorUserId: who.userId,
      actorRoles: who.roles ?? [],
      sessionId: who.sessionId ?? null,
      reason: subject.reason ?? null,
      after: { fileId: file.id, purpose: file.purpose },
      sensitivity: 'HIGH',
    });
    return { url, expiresAt: file.bucket === 'public' ? null : expiresAt };
  }

  /** API-FILE-003: only uploads not yet attached to anything. */
  async remove(userId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, ownerUserId: userId } });
    if (!file || file.status === 'DELETED')
      throw new AppError('NOT_FOUND', { message: "We couldn't find that file." });
    if (file.status === 'ATTACHED')
      throw new AppError('CONFLICT_STALE_VERSION', {
        status: 409,
        message: 'This file is in use. Remove it from where it is used first.',
      });
    await this.destroy(file);
  }

  private async destroy(file: File) {
    await this.storage.delete(file.bucket === 'public' ? 'public' : 'private', file.objectKey);
    if (PURPOSES[file.purpose]?.derivatives)
      for (const n of Object.keys(DERIVATIVES) as DerivativeName[])
        await this.storage.delete(
          file.visibility === 'PUBLIC' ? 'public' : 'private',
          this.derivativeKey(file.objectKey, n),
        );
    await this.prisma.file.update({ where: { id: file.id }, data: { status: 'DELETED' } });
  }

  /**
   * Attaches an upload to an entity inside the caller's transaction: it must be the
   * caller's own file of the expected purpose. Returns the file.
   */
  async claim(tx: Tx, input: { fileId: string; userId: string; purposes: FilePurpose[] }) {
    const file = await tx.file.findUnique({ where: { id: input.fileId } });
    if (
      !file ||
      file.status === 'DELETED' ||
      file.ownerUserId !== input.userId ||
      !input.purposes.includes(file.purpose)
    )
      throw new AppError('VALIDATION_ERROR', {
        message: 'That file is not available.',
        details: [{ path: 'fileId', code: 'FILE_INVALID', message: 'Upload the file again.' }],
      });
    if (file.status === 'UPLOADED')
      return tx.file.update({ where: { id: file.id }, data: { status: 'ATTACHED' } });
    return file;
  }

  /** The entity no longer uses the file: delete it now. */
  async release(fileId: string) {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (file && file.status !== 'DELETED') await this.destroy(file);
  }

  /** JOB-FILE-002 (FR-FILE-006): unattached uploads older than a day. */
  async cleanupOrphans(olderThanHours = 24): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - olderThanHours * 3_600_000);
    const stale = await this.prisma.file.findMany({
      where: { status: 'UPLOADED', createdAt: { lt: cutoff } },
      take: 500,
    });
    for (const f of stale)
      await this.destroy(f).catch((error: unknown) =>
        this.logger.warn({ err: error, fileId: f.id }, 'orphan file cleanup failed'),
      );
    return stale.length;
  }
}
