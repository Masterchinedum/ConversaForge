/**
 * Jest global setup: point every integration suite at ONE disposable test database and a separate
 * Redis logical DB, so `pnpm test` works locally and in CI without per-workstream databases.
 *   CF_TEST_DATABASE_URL (default postgresql://postgres:postgres@localhost:5432/conversaforge_test)
 *   CF_TEST_REDIS_URL    (default redis://localhost:6379/7)
 * The schema must already be applied (CI: `prisma migrate deploy`; local: `pnpm test:prepare`).
 * Suites that don't find a test database skip themselves.
 */
export default async function globalSetup() {
  const db = process.env.CF_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/conversaforge_test';
  const redis = process.env.CF_TEST_REDIS_URL ?? 'redis://localhost:6379/7';
  for (const key of [
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'ANALYSIS_TEST_DATABASE_URL',
    'COURSES_TEST_DATABASE_URL',
    'G_TEST_DATABASE_URL',
    'E_TEST_DATABASE_URL',
    'H_TEST_DATABASE_URL',
  ]) {
    process.env[key] = process.env[key]?.includes('conversaforge_test') ? process.env[key] : db;
  }
  process.env.REDIS_URL = redis;
  process.env.E_TEST_REDIS_URL = process.env.E_TEST_REDIS_URL ?? redis;
  process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
  process.env.SIGNING_SECRET ??= 'test-signing-secret-test-signing-secret';
  process.env.NODE_ENV = 'test';
}
