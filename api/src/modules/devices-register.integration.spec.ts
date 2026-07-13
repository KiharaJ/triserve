/**
 * Integration tests (Phase 5 CRM) for the devices register against the REAL
 * MySQL database over HTTP:
 *   - create a multi-brand device with a free device_type and no category →
 *     category defaults OTHER, device_type + customer_name are on the wire;
 *   - list ?q= searches brand/model/type/serial AND the owner's name;
 *   - list ?type= filters by device_type.
 * Fixtures are test-only (prefixed __TEST_DR__) and removed in afterAll.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_DR__';
const PASSWORD = 'DevReg-Pass!';
const EMAIL = 'test-dr-admin@triserve.test';

const raw = new PrismaClient();
let app: INestApplication<App>;
let companyId: string;
let adminId: string;
let customerId: string;
let token: string;
const createdDeviceIds: string[] = [];

async function createDevice(body: Record<string, unknown>, expectStatus = 201) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/devices')
    .set('Authorization', `Bearer ${token}`)
    .send({ customer_id: customerId, ...body })
    .expect(expectStatus);
  if (res.body?.id) createdDeviceIds.push(res.body.id);
  return res.body;
}

beforeAll(async () => {
  companyId = (
    await raw.company.findFirstOrThrow({ where: { name: 'Samsung ASC Group' } })
  ).id;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  adminId = (
    await raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} admin`,
        email: EMAIL,
        passwordHash,
        role: 'SUPER_ADMIN',
        scope: 'group',
        homeBranchId: null,
      },
    })
  ).id;
  customerId = (
    await raw.customer.create({
      data: { companyId, name: `${TEST_PREFIX} Fatima Sheikh` },
    })
  ).id;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  token = (
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200)
  ).body.access_token;
});

afterAll(async () => {
  await raw.device.deleteMany({ where: { id: { in: createdDeviceIds } } });
  await raw.customer.deleteMany({ where: { id: customerId } });
  await raw.session.deleteMany({ where: { userId: adminId } });
  await raw.user.deleteMany({ where: { id: adminId } });
  await raw.$disconnect();
  await app.close();
});

describe('Devices register', () => {
  it('creates a multi-brand device (free type, default category)', async () => {
    const d = await createDevice({
      brand: 'Titan',
      model: `${TEST_PREFIX} Edge 1576`,
      device_type: 'Watch',
      imei_serial: 'SN-TTN-1576X',
    });
    expect(d.device_type).toBe('Watch');
    expect(d.brand).toBe('Titan');
    expect(d.category).toBe('OTHER'); // defaulted, no Samsung category given
    expect(d.imei_serial).toBe('SNTTN1576X'); // normalized
    expect(d.customer_name).toContain('Fatima Sheikh');
  });

  it('searches by owner name and filters by type', async () => {
    await createDevice({ brand: 'Honda', model: `${TEST_PREFIX} Activa`, device_type: 'Two-Wheeler' });

    const byOwner = await request(app.getHttpServer())
      .get(`/api/v1/devices?q=${encodeURIComponent(`${TEST_PREFIX} Fatima`)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((byOwner.body as { total: number }).total).toBeGreaterThanOrEqual(2);

    const byType = await request(app.getHttpServer())
      .get('/api/v1/devices?type=Two-Wheeler&q=' + encodeURIComponent(TEST_PREFIX))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = (byType.body as { data: { device_type: string }[] }).data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.device_type === 'Two-Wheeler')).toBe(true);
  });
});
