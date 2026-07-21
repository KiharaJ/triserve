/**
 * Jest `setupFiles` — runs BEFORE any test module is imported.
 *
 * Pins DATABASE_URL to the TEST database. This has to happen here, before the
 * spec files run, because each spec constructs its own `new PrismaClient()` at
 * module scope and Prisma reads the URL at construction.
 *
 * WHY THIS EXISTS: the integration suites used to run against the development
 * database. Their teardowns issue real deletes, and a teardown that fails
 * part-way leaves debris that breaks the next run — or, worse, takes real rows
 * with it. Tests must never be able to touch data someone cares about.
 *
 * Set explicitly, NOT with `??`: `.env` also defines DATABASE_URL (pointing at
 * the dev database), and @nestjs/config's dotenv load leaves an already-set
 * value alone — so whatever is set here wins for the whole run.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

process.env.DATABASE_URL = TEST_DATABASE_URL;
// Keep the seed deterministic and away from any real credentials.
process.env.SEED_ADMIN_EMAIL ??= 'admin@triserve.local';
process.env.SEED_ADMIN_PASSWORD ??= 'ChangeMe123!';
