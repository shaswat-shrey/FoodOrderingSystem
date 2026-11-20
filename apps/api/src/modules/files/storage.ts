import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { apiPublicUrlOf, storageDriverOf, type StorageEnv } from './config';

export type BucketKind = 'public' | 'private';

/** FR-FILE-005: the only way modules touch object storage. */
export interface StorageProvider {
  put(bucket: BucketKind, key: string, body: Buffer, contentType: string): Promise<void>;
  get(bucket: BucketKind, key: string): Promise<Buffer>;
  delete(bucket: BucketKind, key: string): Promise<void>;
  /** Stable URL for public media. */
  publicUrl(key: string): string;
  /** Short-lived URL for a private object (FR-FILE-004: ≤ 5 minutes). */
  signedUrl(key: string, ttlSeconds: number, now: Date): Promise<string>;
}

const safeKey = (key: string) => {
  const n = normalize(key);
  if (n.startsWith('..') || isAbsolute(n) || /[^\w./-]/.test(key))
    throw new Error(`unsafe object key ${key}`);
  return n;
};

/**
 * Filesystem storage for development and tests. Private objects are served by
 * the API only with an HMAC-signed, expiring URL, mirroring S3 presigning.
 */
export class LocalStorageProvider implements StorageProvider {
  constructor(
    private readonly root: string,
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly publicBase?: string,
  ) {}

  private path(bucket: BucketKind, key: string) {
    return join(this.root, bucket, safeKey(key));
  }

  async put(bucket: BucketKind, key: string, body: Buffer): Promise<void> {
    const p = this.path(bucket, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  get(bucket: BucketKind, key: string): Promise<Buffer> {
    return readFile(this.path(bucket, key));
  }

  async delete(bucket: BucketKind, key: string): Promise<void> {
    await rm(this.path(bucket, key), { force: true });
  }

  publicUrl(key: string): string {
    return `${this.publicBase ?? `${this.apiUrl}/api/v1/media`}/${safeKey(key)}`;
  }

  signature(key: string, expires: number): string {
    return createHmac('sha256', this.secret).update(`file|${key}|${expires}`).digest('hex');
  }

  verify(key: string, expires: number, sig: string, now: Date): boolean {
    if (!Number.isInteger(expires) || expires * 1000 < now.getTime()) return false;
    const expected = Buffer.from(this.signature(key, expires), 'hex');
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async signedUrl(key: string, ttlSeconds: number, now: Date): Promise<string> {
    const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
    return `${this.apiUrl}/api/v1/files/private/${safeKey(key)}?expires=${expires}&sig=${this.signature(key, expires)}`;
  }
}

/** S3, R2 or SeaweedFS (path-style) storage. */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(
    private readonly buckets: Record<BucketKind, string>,
    opts: {
      endpoint?: string | undefined;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
    private readonly publicBase: string,
  ) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(bucket: BucketKind, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.buckets[bucket],
        Key: safeKey(key),
        Body: body,
        ContentType: contentType,
        ...(bucket === 'public' ? { CacheControl: 'public, max-age=31536000, immutable' } : {}),
      }),
    );
  }

  async get(bucket: BucketKind, key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.buckets[bucket], Key: safeKey(key) }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async delete(bucket: BucketKind, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.buckets[bucket], Key: safeKey(key) }),
    );
  }

  publicUrl(key: string): string {
    return `${this.publicBase}/${safeKey(key)}`;
  }

  signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.buckets.private, Key: safeKey(key) }),
      { expiresIn: ttlSeconds },
    );
  }
}

export function createStorageProvider(env: StorageEnv, secret: string): StorageProvider {
  const api = apiPublicUrlOf(env);
  if (storageDriverOf(env) === 'local') {
    const root = isAbsolute(env.STORAGE_LOCAL_DIR)
      ? env.STORAGE_LOCAL_DIR
      : resolve(process.cwd(), '../..', env.STORAGE_LOCAL_DIR);
    return new LocalStorageProvider(root, api, secret, env.PUBLIC_MEDIA_BASE_URL);
  }
  return new S3StorageProvider(
    { public: env.STORAGE_PUBLIC_BUCKET, private: env.STORAGE_PRIVATE_BUCKET },
    {
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      accessKeyId: env.STORAGE_ACCESS_KEY!,
      secretAccessKey: env.STORAGE_SECRET_KEY!,
    },
    (
      env.PUBLIC_MEDIA_BASE_URL ??
      `${env.STORAGE_ENDPOINT ?? `https://${env.STORAGE_PUBLIC_BUCKET}.s3.${env.STORAGE_REGION}.amazonaws.com`}${env.STORAGE_ENDPOINT ? `/${env.STORAGE_PUBLIC_BUCKET}` : ''}`
    ).replace(/\/$/, ''),
  );
}
