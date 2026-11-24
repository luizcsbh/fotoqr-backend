import { vi } from 'vitest';

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
