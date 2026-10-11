// The ingest lease: how a reader tells a live capture from a leftover.
// The capture renews its own liveness, and every committed segment counts as
// activity too, so a paused capture holds its lease while storing nothing.
// One module so the sweep and the delete gate can never disagree.

import type { recordingIngest } from "../db/schema";

// No activity for this long and the sweep closes the ingest.
export const INGEST_IDLE_CLOSE_MS = 15_000;

// The lease a reader checks instead of a write: wider than the idle close, so
// an ingest the sweep is about to close is never mistaken for an orphan.
export const INGEST_LEASE_FRESH_MS = 20_000;

// the ingest is idle when its last activity sits at or before the cutoff
export const ingestIdleSince = (ingest: typeof recordingIngest.$inferSelect): Date =>
  new Date(
    Math.max(
      ingest.openedAt.getTime(),
      ingest.lastSegmentAt?.getTime() ?? 0,
      ingest.lastSeenAt?.getTime() ?? 0,
    ),
  );

// An open ingest whose lease is still fresh is a capture on the wire. Anything
// else — no row, a closed one, or a lease gone stale — is an orphan: the app
// died, the pipeline stopped, or the machine went away.
export const ingestLeaseAlive = (
  ingest: typeof recordingIngest.$inferSelect,
  now: Date = new Date(),
): boolean => now.getTime() - ingestIdleSince(ingest).getTime() <= INGEST_LEASE_FRESH_MS;
