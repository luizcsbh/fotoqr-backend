const PG_UNIQUE_VIOLATION = '23505';

/**
 * Returns the Postgres error code of a database error.
 *
 * Since drizzle-orm 0.44, driver errors are wrapped in a `DrizzleQueryError`
 * and the original `pg` error (which carries `code`) lives in `cause`.
 */
export function getPgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return getPgErrorCode(error) === PG_UNIQUE_VIOLATION;
}
