import { vi } from 'vitest';

// Super admins are only the SUPER_ADMIN_EMAIL accounts. Fixed here so tests do not depend on the
// local .env (dotenv never overrides a variable that is already set).
process.env.SUPER_ADMIN_EMAIL = 'admin@fotoqr.com,superadmin-test@fotoqr.local,superadmin-console@fotoqr.local';

// The tests run against the real DATABASE_URL: never write audit entries from a test run.
// Tests that care about auditing assert on these mocks (listAuditLogs keeps its real behaviour
// unless a test overrides it).
vi.mock('../src/services/audit.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/audit.service.js')>();
  return {
    ...original,
    recordAudit: vi.fn(async () => undefined),
    listAuditLogs: vi.fn(original.listAuditLogs),
  };
});
