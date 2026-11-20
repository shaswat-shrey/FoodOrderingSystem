import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  createTestContext,
  integrationEnabled,
  ORIGINS,
  SAFFRON_STAFF,
  signInAs,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
});

/** A small JPEG carrying EXIF (incl. a GPS-like tag) that must not survive upload. */
const jpegWithExif = () =>
  sharp({ create: { width: 1600, height: 900, channels: 3, background: '#c33' } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: 'secret', Artist: 'Lat 12.93 Lng 77.62' } } })
    .toBuffer();

const upload = (
  b: { token: string | undefined },
  app: 'RESTAURANT' | 'CUSTOMER',
  purpose: string,
  body: Buffer,
  filename = 'x.jpg',
) => {
  const r = request(ctx.app)
    .post('/api/v1/files')
    .set('X-Client-App', app)
    .set('Origin', ORIGINS[app])
    .set('Authorization', `Bearer ${b.token}`)
    .field('purpose', purpose)
    .attach('file', body, filename);
  return r;
};

suite('uploads (API-FILE-001…003, FR-FILE-001…006, BR-FILE-001)', () => {
  it('strips metadata, makes WebP derivatives and serves public media', async () => {
    const owner = await signInAs(ctx, SAFFRON_STAFF.owner);
    const original = await jpegWithExif();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const res = await upload(owner.browser, 'RESTAURANT', 'FOOD_IMAGE', original);
    expect(res.status).toBe(201);
    const f = res.body.data;
    expect(f).toMatchObject({
      purpose: 'FOOD_IMAGE',
      mimeType: 'image/jpeg',
      width: 1600,
      height: 900,
      visibility: 'PUBLIC',
      status: 'UPLOADED',
      urls: {
        original: expect.stringMatching(/\/api\/v1\/media\/food_image\/.+\.jpg$/),
        thumb: expect.stringMatching(/\.thumb\.webp$/),
        hero: expect.stringMatching(/\.hero\.webp$/),
      },
    });
    const path = (u: string) => new URL(u).pathname;
    const served = await request(ctx.app).get(path(f.urls.original)).buffer(true);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/image\/jpeg/);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await sharp(served.body as Buffer).metadata()).exif).toBeUndefined();
    const thumb = await request(ctx.app).get(path(f.urls.thumb)).buffer(true);
    expect(await sharp(thumb.body as Buffer).metadata()).toMatchObject({
      format: 'webp',
      width: 160,
    });
  });

  it('types files by content, enforces purpose rules and size limits', async () => {
    const owner = await signInAs(ctx, SAFFRON_STAFF.owner);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(
      (await upload(owner.browser, 'RESTAURANT', 'FOOD_IMAGE', svg, 'cat.jpg')).body.error.code,
    ).toBe('FILE_TYPE_NOT_ALLOWED');
    // A PDF renamed .png is still a PDF: fine as a document, not as a food image.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    expect((await upload(owner.browser, 'RESTAURANT', 'FOOD_IMAGE', pdf, 'menu.png')).status).toBe(
      415,
    );
    const doc = await upload(owner.browser, 'RESTAURANT', 'RESTAURANT_DOCUMENT', pdf, 'fssai.png');
    expect(doc.body.data).toMatchObject({
      mimeType: 'application/pdf',
      visibility: 'PRIVATE',
      urls: null,
    });

    const big = Buffer.concat([await jpegWithExif(), Buffer.alloc(6 * 1024 * 1024)]);
    expect((await upload(owner.browser, 'RESTAURANT', 'FOOD_IMAGE', big)).body.error.code).toBe(
      'FILE_TOO_LARGE',
    );

    const customer = await signUpCustomer(ctx);
    expect(
      (await upload(customer.browser, 'CUSTOMER', 'FOOD_IMAGE', await jpegWithExif())).status,
    ).toBe(403);
    expect(
      (await upload(customer.browser, 'CUSTOMER', 'NOPE', await jpegWithExif())).body.error.code,
    ).toBe('VALIDATION_ERROR');
  });

  it('gives private files only to their owner, through expiring signed links', async () => {
    const owner = await signInAs(ctx, SAFFRON_STAFF.owner);
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const doc = (await upload(owner.browser, 'RESTAURANT', 'RESTAURANT_DOCUMENT', pdf, 'gst.pdf'))
      .body.data;
    const signed = (await owner.browser.get(`/files/${doc.id}/url`)).body.data;
    expect(signed.expiresAt).toBeTruthy();
    const link = new URL(signed.url);
    const ok = await request(ctx.app)
      .get(link.pathname + link.search)
      .buffer(true);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/application\/pdf/);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'file.signed_url', targetId: doc.id } }),
    ).toBe(1);

    const tampered = link.search.replace(/sig=[0-9a-f]/, 'sig=0');
    expect((await request(ctx.app).get(link.pathname + tampered)).status).toBe(403);
    ctx.clock.advance(301_000);
    expect((await request(ctx.app).get(link.pathname + link.search)).status).toBe(403);

    const other = await signUpCustomer(ctx);
    expect((await other.browser.get(`/files/${doc.id}/url`)).status).toBe(404);
  });

  it('deletes unattached uploads on request and as orphans after a day', async () => {
    const owner = await signInAs(ctx, SAFFRON_STAFF.owner);
    const a = (await upload(owner.browser, 'RESTAURANT', 'FOOD_IMAGE', await jpegWithExif())).body
      .data;
    expect((await owner.browser.delete(`/files/${a.id}`)).status).toBe(200);
    expect((await ctx.prisma.file.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      'DELETED',
    );
    expect((await request(ctx.app).get(new URL(a.urls.original).pathname)).status).toBe(404);

    const b = (await upload(owner.browser, 'RESTAURANT', 'FOOD_IMAGE', await jpegWithExif())).body
      .data;
    const kept = (await upload(owner.browser, 'RESTAURANT', 'FOOD_IMAGE', await jpegWithExif()))
      .body.data;
    await ctx.prisma.$transaction((tx) =>
      ctx.container.files.claim(tx, {
        fileId: kept.id,
        userId: owner.userId,
        purposes: ['FOOD_IMAGE'],
      }),
    );
    ctx.clock.advance(25 * 3_600_000);
    expect(await ctx.container.files.cleanupOrphans()).toBeGreaterThanOrEqual(1);
    expect((await ctx.prisma.file.findUniqueOrThrow({ where: { id: b.id } })).status).toBe(
      'DELETED',
    );
    expect((await ctx.prisma.file.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe(
      'ATTACHED',
    );
  });
});
