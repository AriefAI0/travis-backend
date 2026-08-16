// Interim crash-recovery store: one local SQLite file in DATA_DIR, zero infra.
// NOT a database deployment — will be replaced by drizzle + Postgres in a future
// phase. All callers go through the `tracker` API below, so the swap touches only
// this file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "../../config/env";

mkdirSync(env.DATA_DIR, { recursive: true });

export const db = new Database(join(env.DATA_DIR, "tracker.sqlite3"));
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = FULL");

db.run(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  app_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('master','clip')),
  status TEXT NOT NULL,
  upload_id TEXT,
  bucket TEXT,
  object_key TEXT,
  durable_through INTEGER NOT NULL DEFAULT -1,
  highest_index_seen INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER,
  stopped_at INTEGER,
  last_seen_at INTEGER,
  truncated_at INTEGER,
  duration_ms INTEGER,
  size_bytes INTEGER,
  UNIQUE(app_session_id, kind)
)`);
db.run(`CREATE TABLE IF NOT EXISTS segments (
  session_id TEXT,
  idx INTEGER,
  size_bytes INTEGER,
  state TEXT CHECK(state IN ('received','in_part')),
  PRIMARY KEY(session_id, idx)
)`);
db.run(`CREATE TABLE IF NOT EXISTS parts (
  session_id TEXT,
  part_number INTEGER,
  etag TEXT,
  size_bytes INTEGER,
  first_idx INTEGER,
  last_idx INTEGER,
  PRIMARY KEY(session_id, part_number)
)`);
db.run(`CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  type TEXT,
  status TEXT CHECK(status IN ('queued','running','done','failed')),
  attempts INTEGER,
  locked_at INTEGER,
  error TEXT
)`);

export interface SessionRow {
  id: string;
  app_session_id: string;
  kind: "master" | "clip";
  status: string;
  upload_id: string | null;
  bucket: string | null;
  object_key: string | null;
  durable_through: number;
  highest_index_seen: number;
  created_at: number | null;
  stopped_at: number | null;
  last_seen_at: number | null;
  truncated_at: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
}

export interface PartRow {
  part_number: number;
  etag: string;
  size_bytes: number;
  first_idx: number;
  last_idx: number;
}

const ACTIVE_STATUSES = ["created", "recording", "stopping", "stale"];

export function trackerReady() {
  try {
    db.query("select 1").get();
    return true;
  } catch {
    return false;
  }
}

export const tracker = {
  createSession(input: { id: string; appSessionId: string; kind: "master" | "clip"; bucket: string; objectKey: string }) {
    const now = Date.now();
    db.run(
      `INSERT INTO sessions (id, app_session_id, kind, status, bucket, object_key, created_at, last_seen_at)
       VALUES (?, ?, ?, 'created', ?, ?, ?, ?)`,
      [input.id, input.appSessionId, input.kind, input.bucket, input.objectKey, now, now],
    );
  },

  getSession(id: string): SessionRow | undefined {
    return db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  },

  countActive(): number {
    const row = db
      .query(`SELECT COUNT(*) AS n FROM sessions WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`)
      .get(...ACTIVE_STATUSES) as { n: number };
    return row.n;
  },

  setRecording(id: string, uploadId: string) {
    db.run(`UPDATE sessions SET status = 'recording', upload_id = ? WHERE id = ?`, [uploadId, id]);
  },

  setStatus(id: string, status: string) {
    db.run(`UPDATE sessions SET status = ? WHERE id = ?`, [status, id]);
  },

  touch(id: string) {
    db.run(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, [Date.now(), id]);
  },

  setDurableThrough(id: string, value: number) {
    db.run(`UPDATE sessions SET durable_through = ? WHERE id = ?`, [value, id]);
  },

  setHighestSeen(id: string, index: number) {
    db.run(`UPDATE sessions SET highest_index_seen = MAX(highest_index_seen, ?) WHERE id = ?`, [index, id]);
  },

  setCompleted(id: string, sizeBytes: number, truncated = false) {
    db.run(
      `UPDATE sessions SET status = 'finalizing', stopped_at = ?, size_bytes = ?, truncated_at = ? WHERE id = ?`,
      [Date.now(), sizeBytes, truncated ? Date.now() : null, id],
    );
  },

  setFinalizedEmpty(id: string, truncated = false) {
    db.run(
      `UPDATE sessions SET status = 'finalized', stopped_at = ?, size_bytes = 0, truncated_at = ? WHERE id = ?`,
      [Date.now(), truncated ? Date.now() : null, id],
    );
  },

  sessionsByStatuses(statuses: string[]): SessionRow[] {
    return db
      .query(`SELECT * FROM sessions WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...statuses) as SessionRow[];
  },

  // Every upload_id ever persisted — the orphan sweep's allow-list.
  uploadIds(): Set<string> {
    const rows = db.query("SELECT upload_id FROM sessions WHERE upload_id IS NOT NULL").all() as { upload_id: string }[];
    return new Set(rows.map((r) => r.upload_id));
  },

  segments(sessionId: string): { idx: number; size_bytes: number }[] {
    return db
      .query("SELECT idx, size_bytes FROM segments WHERE session_id = ? ORDER BY idx")
      .all(sessionId) as { idx: number; size_bytes: number }[];
  },

  updatePartEtag(sessionId: string, partNumber: number, etag: string) {
    db.run(`UPDATE parts SET etag = ? WHERE session_id = ? AND part_number = ?`, [etag, sessionId, partNumber]);
  },

  // Demotion cascade: drop this part and everything above it; its segments go
  // back to awaiting re-send; durableThrough rewinds to the surviving prefix.
  demotePartsFrom(sessionId: string, fromPartNumber: number, durableThrough: number) {
    db.transaction(() => {
      db.run(`DELETE FROM parts WHERE session_id = ? AND part_number >= ?`, [sessionId, fromPartNumber]);
      db.run(`UPDATE segments SET state = 'received' WHERE session_id = ? AND idx > ?`, [sessionId, durableThrough]);
      db.run(`UPDATE sessions SET durable_through = ? WHERE id = ?`, [durableThrough, sessionId]);
    })();
  },

  upsertSegment(sessionId: string, idx: number, sizeBytes: number) {
    db.run(
      `INSERT INTO segments (session_id, idx, size_bytes, state) VALUES (?, ?, ?, 'received')
       ON CONFLICT(session_id, idx) DO UPDATE SET size_bytes = excluded.size_bytes, state = 'received'`,
      [sessionId, idx, sizeBytes],
    );
  },

  parts(sessionId: string): PartRow[] {
    return db
      .query("SELECT part_number, etag, size_bytes, first_idx, last_idx FROM parts WHERE session_id = ? ORDER BY part_number")
      .all(sessionId) as PartRow[];
  },

  // Part row + segment flips + durableThrough move atomically: a crash can never
  // leave a part tracked without its segments marked (the reverse window is healed
  // by boot recovery trusting ListParts).
  commitPart(sessionId: string, part: { partNumber: number; etag: string; sizeBytes: number; firstIdx: number; lastIdx: number }) {
    db.transaction(() => {
      db.run(
        `INSERT INTO parts (session_id, part_number, etag, size_bytes, first_idx, last_idx) VALUES (?, ?, ?, ?, ?, ?)`,
        [sessionId, part.partNumber, part.etag, part.sizeBytes, part.firstIdx, part.lastIdx],
      );
      db.run(
        `UPDATE segments SET state = 'in_part' WHERE session_id = ? AND idx >= ? AND idx <= ?`,
        [sessionId, part.firstIdx, part.lastIdx],
      );
      db.run(`UPDATE sessions SET durable_through = ? WHERE id = ? AND durable_through < ?`, [
        part.lastIdx,
        sessionId,
        part.lastIdx,
      ]);
    })();
  },

  segmentsReceived(sessionId: string): number {
    const row = db.query(`SELECT COUNT(*) AS n FROM segments WHERE session_id = ?`).get(sessionId) as { n: number };
    return row.n;
  },

  enqueueJob(sessionId: string, type: string) {
    db.run(`INSERT INTO jobs (session_id, type, status, attempts) VALUES (?, ?, 'queued', 0)`, [sessionId, type]);
  },
};
