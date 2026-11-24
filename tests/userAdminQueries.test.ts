/**
 * The user list counts events and photos with correlated subqueries. Drizzle renders the columns of
 * a single-table select without their table ("id"), which Postgres rejects as ambiguous inside a
 * subquery over events/photos — the list then failed for every super admin. Checked on the SQL
 * text, without a database.
 */
import { describe, it, expect } from 'vitest';
import { db } from '../src/config/database.js';
import { users } from '../src/models/schema.js';
import { eventCount, photoCount } from '../src/services/userAdmin.service.js';

describe('user list SQL', () => {
  const { sql } = db.select({ id: users.id, eventCount, photoCount }).from(users).toSQL();

  it('ties each subquery to the outer users row explicitly', () => {
    expect(sql.match(/= "users"\."id"/g)).toHaveLength(2);
  });

  it('never compares against a bare, ambiguous "id" column', () => {
    expect(sql).not.toMatch(/= "id"|"id" =/);
  });
});
