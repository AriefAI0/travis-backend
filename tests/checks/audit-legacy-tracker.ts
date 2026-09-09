// Legacy retirement audit (spec 16): read-only classification of every legacy
// multipart session in DATA_DIR/tracker.sqlite3. Retiring SQLite is allowed
// only when every legacy upload has an explicit terminal disposition, so this
// report splits terminal from non-terminal work and lists what must drain or
// be explicitly abandoned first. Deletes nothing, writes nothing.
//
//   docker run --rm --network travis -v $PWD:/repo -w /repo travis-backend:dev \
//     bun tests/checks/audit-legacy-tracker.ts
import { Database } from "bun:sqlite";
import { join } from "node:path";

// standalone: no repo imports, so it runs inside the deployed container too.
// DATA_DIR matches the env.ts default the tracker file lives under.
const DATA_DIR = process.env.DATA_DIR ?? "./data";

// terminal: the upload reached a final verdict and needs no further work.
// abandoned-by-operator is terminal too — but only after a human says so.
const TERMINAL_STATUSES = new Set(["finalized", "finalization_failed"]);
// in-flight: stopping/truncating/finalizing sessions may still finish on their own
const INFLIGHT_STATUSES = new Set(["stopping", "truncating", "finalizing"]);
// waiting: created/recording/stale sessions hold an open MPU and undrained bytes
const WAITING_STATUSES = new Set(["created", "recording", "stale"]);

interface SessionRow {
  id: string;
  identity_string: string;
  kind: string;
  status: string;
  storage_stem: string | null;
  durable_through: number;
  highest_index_seen: number;
  size_bytes: number | null;
  created_at: number | null;
  last_seen_at: number | null;
}

interface CountRow {
  n: number;
}

const main = () => {
  const path = join(DATA_DIR, "tracker.sqlite3");
  let db: Database;
  try {
    // readonly: the audit must never mutate the tracker it audits
    db = new Database(path, { readonly: true });
  } catch (e) {
    console.log(`[audit] no legacy tracker at ${path} — nothing to retire`);
    process.exit(0);
  }

  // deployed lineages differ: early trackers carried only jobs. A missing
  // table means that revision never wrote one — treat it as zero rows.
  const existingTables = new Set(
    (
      db
        .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as unknown as Array<{ name: string }>
    ).map((row) => row.name)
  );
  const has = (table: string) => existingTables.has(table);

  const sessions = has("sessions")
    ? (db
        .query(
          `SELECT id, identity_string, kind, status, storage_stem, durable_through,
                  highest_index_seen, size_bytes, created_at, last_seen_at
           FROM sessions ORDER BY created_at ASC`
        )
        .all() as unknown as SessionRow[])
    : [];

  const terminal: SessionRow[] = [];
  const inflight: SessionRow[] = [];
  const waiting: SessionRow[] = [];
  const unknown: SessionRow[] = [];
  for (const session of sessions) {
    if (TERMINAL_STATUSES.has(session.status)) terminal.push(session);
    else if (INFLIGHT_STATUSES.has(session.status)) inflight.push(session);
    else if (WAITING_STATUSES.has(session.status)) waiting.push(session);
    else unknown.push(session);
  }

  // pending job queue rows: drain blockers even for finalized sessions
  const pendingJobs = has("jobs")
    ? (db
        .query(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')`)
        .get() as unknown as CountRow)
    : { n: 0 };

  // undrained part bytes: any parts/segments rows at all mean SQLite still
  // carries upload state the v2 ledger never saw
  const partRows = has("parts")
    ? (db.query(`SELECT COUNT(*) AS n FROM parts`).get() as unknown as CountRow)
    : { n: 0 };
  const segmentRows = has("segments")
    ? (db.query(`SELECT COUNT(*) AS n FROM segments`).get() as unknown as CountRow)
    : { n: 0 };

  console.log("=== legacy tracker retirement audit (read-only) ===");
  console.log(`tracker: ${path}`);
  console.log(`tables present: ${[...existingTables].sort().join(", ") || "none"}`);
  console.log(`sessions: ${sessions.length} total`);
  console.log(`  terminal (finalized/finalization_failed): ${terminal.length}`);
  console.log(`  in-flight (stopping/truncating/finalizing): ${inflight.length}`);
  console.log(`  waiting (created/recording/stale): ${waiting.length}`);
  if (unknown.length > 0) console.log(`  UNKNOWN STATUS: ${unknown.length}`);
  console.log(`pending jobs (queued/running): ${pendingJobs.n}`);
  console.log(`multipart part rows: ${partRows.n}`);
  console.log(`segment mapping rows: ${segmentRows.n}`);

  const listBlocked = [...inflight, ...waiting, ...unknown];
  if (listBlocked.length > 0) {
    console.log("\nnon-terminal sessions blocking retirement:");
    for (const session of listBlocked) {
      console.log(
        `  ${session.kind} ${session.identity_string} status=${session.status} ` +
          `durable_through=${session.durable_through} highest=${session.highest_index_seen} ` +
          `bytes=${session.size_bytes ?? "?"} id=${session.id}`
      );
    }
    console.log(
      "\nverdict: NOT ready to retire SQLite — drain or explicitly abandon the sessions above first"
    );
    process.exitCode = 1;
  } else if (pendingJobs.n > 0) {
    console.log("\nverdict: sessions settled but jobs remain queued — drain the job queue first");
    process.exitCode = 1;
  } else {
    console.log(
      "\nverdict: every legacy upload has a terminal disposition — SQLite retirement is " +
        "eligible (deletion still requires separate operational approval)"
    );
  }
};

main();
