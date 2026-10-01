// Schema invariant: any table parented by project, session or result must
// cascade, or deleting the parent fails at the FK instead of removing the child.
// The video_clip.session_id omission shipped as a 404 on project delete.
// flow: read pg_constraint > assert every delete action is 'c'

import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { closeTestDatabase, ensureTestDatabase, testDb } from "../helpers/db";

type FkRow = {
  child_table: string;
  constraint_name: string;
  parent_table: string;
  delete_action: string;
};

describe("schema cascades", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  it("every foreign key into project, session or result cascades on delete", async () => {
    const found = await testDb.execute(sql`
      select
        child.relname as child_table,
        con.conname as constraint_name,
        parent.relname as parent_table,
        con.confdeltype as delete_action
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_class parent on parent.oid = con.confrelid
      where con.contype = 'f'
        and parent.relname in ('project', 'session', 'result')
      order by parent.relname, child.relname
    `);

    const rows = found.rows as FkRow[];

    // guard the guard: a wrong catalog query would silently find nothing
    expect(rows.length).toBeGreaterThan(0);

    const offenders = rows
      .filter((row) => row.delete_action !== "c")
      .map((row) => `${row.child_table}.${row.constraint_name} -> ${row.parent_table}`);

    expect(offenders).toEqual([]);
  });
});
