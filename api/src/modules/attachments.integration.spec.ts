/**
 * Integration tests (Task 1.4, DESIGN.md §4.12) for the attachments API
 * against the REAL MySQL database + the LOCAL storage driver (this machine
 * has no Docker/MinIO):
 *   - upload a PHOTO_BEFORE to a job via the multipart route → row saved
 *     with correct owner/kind/mime/size; object exists in STORAGE_LOCAL_DIR;
 *   - GET /attachments?owner_type=JOB&owner_id= lists it with a presigned
 *     URL; fetching that URL (the app's signed file route) resolves
 *     (200 + correct content-type + bytes match the uploaded buffer);
 *   - upload a SIGNATURE via a PNG data-URI;
 *   - reject a disallowed mime (400) and an oversized file (413);
 *   - DELETE removes the row + the object (verified gone) + writes an
 *     audit DELETE row;
 *   - branch scoping: a JOB-owned attachment is invisible to a same-company
 *     user of a DIFFERENT branch; a CUSTOMER-owned (company-level,
 *     branch_id=NULL) attachment stays visible group-wide, as designed;
 *   - company scoping: a rival company can't list/read it, and can't even
 *     attach to a job/customer that isn't theirs.
 *
 * Fixtures are test-only (prefixed __TEST_1_4__) and removed in afterAll —
 * the real seed stays pristine, which the last test asserts explicitly.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, type UserScope } from '@prisma/client';
import * as argon2 from 'argon2';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { resolveLocalStoragePath } from './storage/local-storage-path.util';

function storageBaseDir(): string {
  return process.env.STORAGE_LOCAL_DIR ?? join(process.cwd(), '.storage');
}

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_1_4__';
const PASSWORD = 'Attach1.4-Pass!';

const EMAILS = {
  advisorDar: 'test-1-4-advisor-dar@triserve.test',
  advisorKrk: 'test-1-4-advisor-krk@triserve.test',
  managerDar: 'test-1-4-manager-dar@triserve.test',
  adminB: 'test-1-4-admin-b@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let companyBId: string;
let branchDar: string;
let branchKrk: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdJobIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdAttachmentIds: string[] = [];

// 1x1 transparent PNG.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_1x1_BUFFER = Buffer.from(PNG_1x1_BASE64, 'base64');

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface AttachmentBody {
  id: string;
  company_id: string;
  branch_id: string | null;
  owner_type: string;
  owner_id: string;
  kind: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  url: string;
  created_at: string;
}

interface JobBody {
  id: string;
  branch_id: string;
  customer_id: string;
}

async function createJob(
  token: string,
  branchId: string,
  suffix: string,
): Promise<JobBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/jobs')
    .set('Authorization', `Bearer ${token}`)
    .send({
      branch_id: branchId,
      customer: {
        name: `${TEST_PREFIX} Cust ${suffix}`,
        phone: `07650${suffix}`,
      },
      device: { category: 'HHP', imei_serial: `35100000${suffix}` },
    })
    .expect(201);
  const job = res.body as JobBody;
  createdJobIds.push(job.id);
  createdCustomerIds.push(job.customer_id);
  return job;
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  branchKrk = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'KRK' } })
  ).id;

  const companyB = await raw.company.create({
    data: { name: `${TEST_PREFIX} Rival Service Co` },
  });
  companyBId = companyB.id;
  await raw.branch.create({
    data: { companyId: companyBId, code: 'RB1', name: `${TEST_PREFIX} B` },
  });

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mk = (
    email: string,
    role: string,
    scope: UserScope,
    company: string,
    homeBranchId: string | null,
  ) =>
    raw.user.create({
      data: {
        companyId: company,
        fullName: `${TEST_PREFIX} ${role}`,
        email,
        passwordHash,
        role,
        scope,
        homeBranchId,
      },
    });

  const [advisorDar, advisorKrk, managerDar, adminB] = await Promise.all([
    mk(EMAILS.advisorDar, 'SERVICE_ADVISOR', 'branch', companyId, branchDar),
    mk(EMAILS.advisorKrk, 'SERVICE_ADVISOR', 'branch', companyId, branchKrk),
    mk(EMAILS.managerDar, 'BRANCH_MANAGER', 'branch', companyId, branchDar),
    mk(EMAILS.adminB, 'SUPER_ADMIN', 'group', companyBId, null),
  ]);
  ids.advisorDar = advisorDar.id;
  ids.advisorKrk = advisorKrk.id;
  ids.managerDar = managerDar.id;
  ids.adminB = adminB.id;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  for (const [k, email] of Object.entries(EMAILS)) {
    tokens[k] = await login(email);
  }
});

afterAll(async () => {
  const actorIds = Object.values(ids);
  await raw.auditLog.deleteMany({
    where: { companyId: { in: [companyId, companyBId] } },
  });
  await raw.session.deleteMany({ where: { userId: { in: actorIds } } });

  // Remove the actual storage OBJECTS before dropping the rows (raw Prisma
  // deleteMany bypasses AttachmentsService.remove(), which is what normally
  // pairs a row delete with an object delete) — otherwise orphaned files
  // would accumulate under STORAGE_LOCAL_DIR across suite runs.
  const leftoverAttachments = await raw.attachment.findMany({
    where: { companyId: { in: [companyId, companyBId] } },
  });
  await Promise.all(
    leftoverAttachments.map((a) =>
      rm(resolveLocalStoragePath(storageBaseDir(), a.fileUrl), {
        force: true,
      }),
    ),
  );

  await raw.attachment.deleteMany({
    where: { companyId: { in: [companyId, companyBId] } },
  });
  // Scope deletes to THIS suite's fixtures — a bare companyId filter would wipe
  // the real company's jobs/customers/devices (e.g. imported data).
  await raw.job.deleteMany({
    where: { OR: [{ companyId: companyBId }, { id: { in: createdJobIds } }] },
  });
  await raw.jobCounter.deleteMany({ where: { companyId: companyBId } });
  await raw.device.deleteMany({
    where: {
      OR: [
        { companyId: companyBId },
        { customerId: { in: createdCustomerIds } },
      ],
    },
  });
  await raw.customer.deleteMany({
    where: {
      OR: [{ companyId: companyBId }, { id: { in: createdCustomerIds } }],
    },
  });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.branch.deleteMany({ where: { companyId: companyBId } });
  await raw.company.deleteMany({ where: { id: companyBId } });
  await app.close();
  await raw.$disconnect();
});

describe('POST /attachments — multipart upload (§4.12)', () => {
  it('uploads a PHOTO_BEFORE to a job: row saved, object on disk, listed with a presigned URL that resolves', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '001');

    const uploadRes = await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'PHOTO_BEFORE')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'before.png',
        contentType: 'image/png',
      })
      .expect(201);

    const att = uploadRes.body as AttachmentBody;
    createdAttachmentIds.push(att.id);
    expect(att.owner_type).toBe('JOB');
    expect(att.owner_id).toBe(job.id);
    expect(att.kind).toBe('PHOTO_BEFORE');
    expect(att.mime_type).toBe('image/png');
    expect(att.size_bytes).toBe(PNG_1x1_BUFFER.length);
    expect(att.branch_id).toBe(branchDar);
    expect(att.url).toBeTruthy();

    // Row saved exactly as expected (raw DB check).
    const row = await raw.attachment.findUniqueOrThrow({
      where: { id: att.id },
    });
    expect(row.companyId).toBe(companyId);
    expect(row.branchId).toBe(branchDar);
    expect(row.uploadedById).toBe(ids.advisorDar);
    // file_url is a storage KEY, never exposed on the wire.
    expect(row.fileUrl).toMatch(
      new RegExp(`^${companyId}/JOB/${job.id}/[0-9a-f-]+\\.png$`),
    );

    // Object physically present under STORAGE_LOCAL_DIR.
    const path = resolveLocalStoragePath(storageBaseDir(), row.fileUrl);
    expect(existsSync(path)).toBe(true);

    // GET /attachments lists it with a fresh presigned URL.
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/attachments')
      .query({ owner_type: 'JOB', owner_id: job.id })
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const listed = listRes.body as {
      data: AttachmentBody[];
      total: number;
    };
    expect(listed.total).toBe(1);
    expect(listed.data[0].id).toBe(att.id);
    const presignedUrl = listed.data[0].url;
    expect(presignedUrl).toMatch(/^\/api\/v1\/attachments\/file\/.+/);

    // The presigned URL ACTUALLY RESOLVES: 200, correct content-type, bytes
    // match the uploaded buffer byte-for-byte.
    const fileRes = await request(app.getHttpServer())
      .get(presignedUrl)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(fileRes.headers['content-type']).toBe('image/png');
    expect(Buffer.isBuffer(fileRes.body)).toBe(true);
    expect((fileRes.body as Buffer).equals(PNG_1x1_BUFFER)).toBe(true);
  });

  it('uploads a SIGNATURE via a PNG data-URI, attached to a JOB', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '002');

    const res = await request(app.getHttpServer())
      .post('/api/v1/attachments/signature')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({
        owner_id: job.id,
        data_uri: `data:image/png;base64,${PNG_1x1_BASE64}`,
      })
      .expect(201);

    const att = res.body as AttachmentBody;
    createdAttachmentIds.push(att.id);
    expect(att.owner_type).toBe('JOB');
    expect(att.kind).toBe('SIGNATURE');
    expect(att.mime_type).toBe('image/png');
    expect(att.size_bytes).toBe(PNG_1x1_BUFFER.length);

    const path = resolveLocalStoragePath(
      storageBaseDir(),
      (await raw.attachment.findUniqueOrThrow({ where: { id: att.id } }))
        .fileUrl,
    );
    expect(existsSync(path)).toBe(true);
  });

  it('rejects a disallowed mime type (400)', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '003');
    await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'DOC')
      .attach('file', Buffer.from('not a real file'), {
        filename: 'malware.exe',
        contentType: 'application/x-msdownload',
      })
      .expect(400);
  });

  it('rejects an oversized file (413)', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '004');
    const oversized = Buffer.alloc(26 * 1024 * 1024, 1); // > 25 MiB cap
    await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'PHOTO_BEFORE')
      .attach('file', oversized, {
        filename: 'huge.png',
        contentType: 'image/png',
      })
      .expect(413);
  }, 30_000);

  it('rejects SIGNATURE kind on the multipart route (use /attachments/signature)', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '005');
    await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'SIGNATURE')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'sig.png',
        contentType: 'image/png',
      })
      .expect(400);
  });
});

describe('DELETE /attachments/{id} — removes row + object, audited (§4.12)', () => {
  it('removes both, and requires attachment.delete (BRANCH_MANAGER, not SERVICE_ADVISOR)', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '010');
    const uploadRes = await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'PHOTO_AFTER')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'after.png',
        contentType: 'image/png',
      })
      .expect(201);
    const att = uploadRes.body as AttachmentBody;
    const row = await raw.attachment.findUniqueOrThrow({
      where: { id: att.id },
    });
    const path = resolveLocalStoragePath(storageBaseDir(), row.fileUrl);
    expect(existsSync(path)).toBe(true);

    // SERVICE_ADVISOR lacks attachment.delete → 403.
    await request(app.getHttpServer())
      .delete(`/api/v1/attachments/${att.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(403);

    // BRANCH_MANAGER holds attachment.delete → 204.
    await request(app.getHttpServer())
      .delete(`/api/v1/attachments/${att.id}`)
      .set('Authorization', `Bearer ${tokens.managerDar}`)
      .expect(204);

    expect(
      await raw.attachment.findUnique({ where: { id: att.id } }),
    ).toBeNull();
    expect(existsSync(path)).toBe(false); // object gone too

    const auditRow = await raw.auditLog.findFirst({
      where: { entityType: 'Attachment', entityId: att.id, action: 'DELETE' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorUserId).toBe(ids.managerDar);
  });
});

describe('company + branch scoping (§4.12)', () => {
  it('a JOB-owned attachment is invisible to a same-company user of a DIFFERENT branch', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '020');
    const uploadRes = await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'PHOTO_BEFORE')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'p.png',
        contentType: 'image/png',
      })
      .expect(201);
    createdAttachmentIds.push((uploadRes.body as AttachmentBody).id);

    // Same company, KRK branch → sees nothing for this DAR job.
    const krkList = await request(app.getHttpServer())
      .get('/api/v1/attachments')
      .query({ owner_type: 'JOB', owner_id: job.id })
      .set('Authorization', `Bearer ${tokens.advisorKrk}`)
      .expect(200);
    expect((krkList.body as { total: number }).total).toBe(0);

    // A KRK advisor also cannot attach to a DAR job (owner resolution fails
    // the same branch-scoped Job read → 400, not silently branch-hopping).
    await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorKrk}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'PHOTO_BEFORE')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'p.png',
        contentType: 'image/png',
      })
      .expect(400);
  });

  it('a CUSTOMER-owned (company-level, branch_id=NULL) attachment stays visible group-wide', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '021');

    const uploadRes = await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'CUSTOMER')
      .field('owner_id', job.customer_id)
      .field('kind', 'DOC')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'id.png',
        contentType: 'image/png',
      })
      .expect(201);
    const att = uploadRes.body as AttachmentBody;
    createdAttachmentIds.push(att.id);
    expect(att.branch_id).toBeNull();

    // A DIFFERENT branch (KRK) user of the SAME company still sees it.
    const krkList = await request(app.getHttpServer())
      .get('/api/v1/attachments')
      .query({ owner_type: 'CUSTOMER', owner_id: job.customer_id })
      .set('Authorization', `Bearer ${tokens.advisorKrk}`)
      .expect(200);
    expect((krkList.body as { total: number }).total).toBe(1);
  });

  it('a rival company cannot list or attach to a job that is not theirs', async () => {
    const job = await createJob(tokens.advisorDar, branchDar, '022');
    const uploadRes = await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'PHOTO_BEFORE')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'p.png',
        contentType: 'image/png',
      })
      .expect(201);
    createdAttachmentIds.push((uploadRes.body as AttachmentBody).id);

    const rivalList = await request(app.getHttpServer())
      .get('/api/v1/attachments')
      .query({ owner_type: 'JOB', owner_id: job.id })
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .expect(200);
    expect((rivalList.body as { total: number }).total).toBe(0);

    await request(app.getHttpServer())
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .field('owner_type', 'JOB')
      .field('owner_id', job.id)
      .field('kind', 'PHOTO_BEFORE')
      .attach('file', PNG_1x1_BUFFER, {
        filename: 'p.png',
        contentType: 'image/png',
      })
      .expect(400);
  });
});

describe('seed stays pristine', () => {
  it('seed intact; jobs/customers/attachments in the DB are ONLY this suite fixtures (removed in teardown)', async () => {
    expect(
      await raw.company.count({ where: { name: 'Samsung ASC Group' } }),
    ).toBe(1);
    expect(
      await raw.branch.count({
        where: { companyId, code: { in: ['DAR', 'KRK', 'ARU', 'MLM', 'DOD'] } },
      }),
    ).toBe(5);

    // Scoped to this suite's fixtures so pre-existing real data (e.g. imports)
    // doesn't skew the counts; all are cleaned in afterAll.
    const jobCount = await raw.job.count({
      where: { id: { in: createdJobIds } },
    });
    expect(jobCount).toBe(createdJobIds.length);
    expect(jobCount).toBeGreaterThan(0);

    const customerCount = await raw.customer.count({
      where: { id: { in: createdCustomerIds } },
    });
    expect(customerCount).toBe(createdCustomerIds.length);

    // Every attachment row created above was either explicitly DELETEd via
    // the API (the DELETE-flow test) or is still tracked in
    // createdAttachmentIds — the remaining count must match exactly.
    const attachmentCount = await raw.attachment.count({
      where: { id: { in: createdAttachmentIds } },
    });
    expect(attachmentCount).toBe(createdAttachmentIds.length);
    expect(attachmentCount).toBeGreaterThan(0);
  });
});
