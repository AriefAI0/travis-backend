import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { tracker, type PartRow, type SessionRow } from "../../lib/db/minio_tracker";
import { minio } from "../../lib/minio_storage/clients";
import { s3parts, type RemotePart } from "../../lib/minio_storage/s3sdk";
import { finalizeRecording } from "./service";

export interface RecoveryPlan {
  durableThrough: number;
  retags: { partNumber: number; etag: string }[];
  heals: { partNumber: number; etag: string; sizeBytes: number; firstIdx: number; lastIdx: number }[];
  demoteFrom: number | null;
}

// Pure diff: decide the fate of every part. MinIO is truth (spec D7) — a remote
// part with no ledger row (crash between UploadPart and ledger write) is healed
// by rebuilding its index bounds from segment sizes; a ledger part missing
// remotely, or with different bytes, starts a demotion cascade that rewinds
// durableThrough to the surviving prefix.
export function recoveryPlan(
  ledger: PartRow[],
  remote: RemotePart[],
  segments: { idx: number; size_bytes: number }[],
): RecoveryPlan {
  const remoteByPn = new Map(remote.map((p) => [p.partNumber, p]));
  const plan: RecoveryPlan = { durableThrough: -1, retags: [], heals: [], demoteFrom: null };
  let covered = -1; // last segment index known inside a good part
  const coveredByPn = new Map<number, number>(); // confirmed part number -> its last idx

  // durableThrough after a demote = prefix strictly BELOW the demote point
  // (the point may sit under already-confirmed parts, e.g. a numbering contradiction)
  const demoteAt = (fromPartNumber: number): RecoveryPlan => {
    plan.demoteFrom = fromPartNumber;
    let d = -1;
    for (const [pn, last] of coveredByPn) if (pn < fromPartNumber) d = Math.max(d, last);
    plan.durableThrough = d;
    return plan;
  };

  for (const lp of ledger) {
    const rp = remoteByPn.get(lp.part_number);
    if (!rp) return demoteAt(lp.part_number);
    if (rp.etag !== lp.etag || rp.sizeBytes !== lp.size_bytes) {
      // same size, different etag: keep bytes, trust MinIO's etag for complete
      if (rp.sizeBytes === lp.size_bytes) plan.retags.push({ partNumber: lp.part_number, etag: rp.etag });
      else return demoteAt(lp.part_number);
    }
    remoteByPn.delete(lp.part_number);
    coveredByPn.set(lp.part_number, lp.last_idx);
    covered = lp.last_idx;
  }

  // remote-only parts above the ledger: walk segment sizes to rebuild bounds
  const highestLedgerPn = ledger.at(-1)?.part_number ?? 0;
  const segSizes = new Map(segments.map((s) => [s.idx, s.size_bytes]));
  const orphans = [...remoteByPn.values()].sort((a, b) => a.partNumber - b.partNumber);
  for (const rp of orphans) {
    if (rp.partNumber <= highestLedgerPn) return demoteAt(rp.partNumber); // numbering contradiction
    let idx = covered + 1;
    let sum = 0;
    while (sum < rp.sizeBytes) {
      const size = segSizes.get(idx);
      if (size === undefined) return demoteAt(rp.partNumber); // can't rebuild bounds
      sum += size;
      idx++;
    }
    if (sum !== rp.sizeBytes) return demoteAt(rp.partNumber); // sizes disagree
    plan.heals.push({ partNumber: rp.partNumber, etag: rp.etag, sizeBytes: rp.sizeBytes, firstIdx: covered + 1, lastIdx: idx - 1 });
    coveredByPn.set(rp.partNumber, idx - 1);
    covered = idx - 1;
  }

  plan.durableThrough = covered;
  return plan;
}

// flow: orphan sweep > per-session recovery (re-initiate, diff, apply, finish stops)
export async function recoveryBoot(): Promise<void> {
  await sweepOrphans();

  for (const session of tracker.sessionsByStatuses(["created", "recording", "stale", "stopping"])) {
    try {
      await recoverSession(session);
    } catch (err) {
      log.error("recovery failed", { session: session.id, err: String(err) });
    }
  }
}

// Abort any MPU with no session row — BEFORE recovering sessions, so a
// re-initiate can never race the sweep (audit fix F5).
async function sweepOrphans() {
  const known = tracker.uploadIds();
  for (const bucket of [env.BUCKET_MASTER, env.BUCKET_CLIP]) {
    for (const up of await s3parts.listUploads(bucket)) {
      if (!known.has(up.uploadId)) {
        await s3parts.abort(bucket, up.key, up.uploadId);
        log.warn("aborted orphan multipart upload", { bucket, key: up.key, uploadId: up.uploadId });
      }
    }
  }
}

async function recoverSession(session: SessionRow) {
  let cur = session;

  // crash between ledger insert and initiate: row exists, upload never opened
  if (!cur.upload_id) {
    const uploadId = await s3parts.initiate(cur.bucket!, cur.object_key!);
    tracker.setRecording(cur.id, uploadId);
    log.info("recovery re-initiated upload", { session: cur.id });
    return;
  }

  const remote = await listPartsOrNull(cur);
  if (remote === null) return healVanishedUpload(cur); // NoSuchUpload

  const plan = recoveryPlan(tracker.parts(cur.id), remote, tracker.segments(cur.id));
  for (const r of plan.retags) tracker.updatePartEtag(cur.id, r.partNumber, r.etag);
  for (const h of plan.heals) tracker.commitPart(cur.id, h);
  if (plan.demoteFrom !== null) {
    tracker.demotePartsFrom(cur.id, plan.demoteFrom, plan.durableThrough);
    log.warn("recovery demoted parts", { session: cur.id, from: plan.demoteFrom, durableThrough: plan.durableThrough });
  } else if (plan.heals.length > 0 || plan.retags.length > 0) {
    log.info("recovery healed parts", { session: cur.id, healed: plan.heals.length, retagged: plan.retags.length });
  }

  // stop crashed mid-flight: parts recovered above, finish the finalization
  if (cur.status === "stopping") {
    await finalizeRecording(tracker.getSession(cur.id)!);
  }
}

async function listPartsOrNull(session: SessionRow): Promise<RemotePart[] | null> {
  try {
    return await s3parts.listParts(session.bucket!, session.object_key!, session.upload_id!);
  } catch (err) {
    if (String(err).includes("NoSuchUpload")) return null;
    throw err;
  }
}

// Upload vanished: for a stopping session the likely cause is a complete that
// won the race before the crash — the finished object proves it. Otherwise the
// MPU was lost, so rebuild from zero and let the app re-send everything.
async function healVanishedUpload(session: SessionRow) {
  if (session.status === "stopping") {
    try {
      const stat = await minio.statObject(session.bucket!, session.object_key!);
      tracker.setCompleted(session.id, stat.size);
      tracker.enqueueJob(session.id, "finalize");
      log.info("recovery found completed object", { session: session.id, bytes: stat.size });
    } catch {
      tracker.setFinalizedEmpty(session.id);
      log.warn("recovery: upload vanished before any part, finalized empty", { session: session.id });
    }
    return;
  }
  tracker.demotePartsFrom(session.id, 1, -1);
  const uploadId = await s3parts.initiate(session.bucket!, session.object_key!);
  tracker.setRecording(session.id, uploadId);
  log.warn("recovery: upload vanished, re-initiated from zero", { session: session.id });
}
