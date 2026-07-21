import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from './jest-env';

/**
 * Jest `globalSetup` — prepares the TEST database once per run.
 *
 * Creates it if absent, applies migrations, and seeds it. The suites then have
 * the same starting fixtures the dev database has (company, branches, admin,
 * workflow states, service lines, GSPN codes) without ever opening a
 * connection to the developer's own data.
 *
 * The CREATE DATABASE goes through the server's `mysql` system schema rather
 * than the dev database, so nothing here can touch real rows even by accident.
 */
export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) {
    throw new Error(
      `TEST_DATABASE_URL has no database name: ${TEST_DATABASE_URL}`,
    );
  }
  // A test database that is not obviously a test database is a footgun — the
  // whole point of this file is that a mistake here cannot cost real data.
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run tests against "${dbName}": the test database name must contain "test"`,
    );
  }

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/mysql';
  const admin = new PrismaClient({
    datasources: { db: { url: adminUrl.toString() } },
  });
  try {
    // Identifier, so it cannot be parameterised — hence the strict name check
    // above plus this backtick-escape.
    await admin.$executeRawUnsafe(
      `CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.$disconnect();
  }

  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  const run = (args: string[]): void => {
    execFileSync('npx', args, {
      env,
      stdio: 'inherit',
      cwd: `${__dirname}/..`,
    });
  };
  run(['prisma', 'migrate', 'deploy']);
  run(['prisma', 'db', 'seed']);
}
