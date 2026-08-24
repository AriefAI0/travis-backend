import { afterAll, expect, test } from "bun:test";
// module opens env.DATA_DIR sqlite on import — same side-effect acceptance
// as recovery.test.ts; rows are removed in afterAll so the shared file stays clean.
import { db, tracker } from "../../../src/lib/db/minio_tracker";

const ids: string[] = [];

const newSession = () => {
  const id = crypto.randomUUID();
  ids.push(id);
  tracker.createSession({
    id,
    identityString: `app-${id}`,
    projectId: 1,
    sessionId: 1,
    kind: "master",
    bucket: "travis-raw",
    storageStem: `test/${id}/master.ts`,
  });
  return id;
};

afterAll(() => {
  // flow: tests done > delete only this file's sessions
  if (!ids.length) return;
  db.run(`DELETE FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
});

test("schema: next_part_number exists, NOT NULL, defaults to 1", () => {
  const cols = db.query("PRAGMA table_info(sessions)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const col = cols.find((c) => c.name === "next_part_number");
  expect(col).toBeDefined();
  expect(col!.notnull).toBe(1);
  expect(col!.dflt_value).toBe("1");
});

test("schema: renamed + new columns exist (identity_string, storage_stem, project_id, session_id)", () => {
  // also proves the in-place migration ran: this shared dev file predates the rename
  const cols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  const names = cols.map((c) => c.name);
  expect(names).toContain("identity_string");
  expect(names).toContain("storage_stem");
  expect(names).toContain("project_id");
  expect(names).toContain("session_id");
  expect(names).not.toContain("app_session_id");
  expect(names).not.toContain("object_key");
});

test("setCompleted drops part and segment scratch in the same flip", () => {
  const id = newSession();
  tracker.upsertSegment(id, 0, 100);
  tracker.reportPart(id, { partNumber: 1, etag: "e", sizeBytes: 100, firstIdx: 0, lastIdx: 0 });
  expect(tracker.parts(id).length).toBe(1);
  expect(tracker.segments(id).length).toBe(1);

  tracker.setCompleted(id, 100);

  expect(tracker.parts(id)).toEqual([]);
  expect(tracker.segments(id)).toEqual([]);
  const s = tracker.getSession(id)!;
  expect(s.status).toBe("finalizing");
  expect(s.size_bytes).toBe(100);
});

test("new session reserves part 1; repeated reads stay sticky", () => {
  const id = newSession();
  expect(tracker.getNextPartNumber(id)).toBe(1);
  expect(tracker.getNextPartNumber(id)).toBe(1); // reserve retries get the same number
});

test("incrementPartNumber advances one step per call", () => {
  const id = newSession();
  tracker.incrementPartNumber(id);
  expect(tracker.getNextPartNumber(id)).toBe(2);
  tracker.incrementPartNumber(id);
  expect(tracker.getNextPartNumber(id)).toBe(3);
});

test("unknown session has no part number", () => {
  expect(tracker.getNextPartNumber(crypto.randomUUID())).toBeUndefined();
});
