import { expect, test } from "bun:test";
// recoveryPlan is pure — module imports have side effects (env, sqlite open)
// but the function itself only transforms its inputs.
import { recoveryPlan } from "../../../src/features/minio_handler/recovery";
import type { PartRow } from "../../../src/lib/db/minio_tracker";
import type { RemotePart } from "../../../src/lib/minio_storage/s3sdk";

const segs = (n: number, size = 10) => Array.from({ length: n }, (_, i) => ({ idx: i, size_bytes: size }));
const lp = (pn: number, first: number, last: number, size: number, etag = `e${pn}`): PartRow => ({
  part_number: pn,
  etag,
  size_bytes: size,
  first_idx: first,
  last_idx: last,
});
const rp = (pn: number, size: number, etag = `e${pn}`): RemotePart => ({ partNumber: pn, etag, sizeBytes: size });

test("ledger and MinIO agree: everything stays, durableThrough advances", () => {
  const plan = recoveryPlan([lp(1, 0, 2, 30), lp(2, 3, 5, 30)], [rp(1, 30), rp(2, 30)], segs(6));
  expect(plan.demoteFrom).toBeNull();
  expect(plan.heals).toEqual([]);
  expect(plan.retags).toEqual([]);
  expect(plan.durableThrough).toBe(5);
});

test("remote-only part is healed by rebuilding bounds from segment sizes", () => {
  const plan = recoveryPlan([lp(1, 0, 2, 30)], [rp(1, 30), rp(2, 20)], segs(6));
  expect(plan.demoteFrom).toBeNull();
  expect(plan.heals).toEqual([{ partNumber: 2, etag: "e2", sizeBytes: 20, firstIdx: 3, lastIdx: 4 }]);
  expect(plan.durableThrough).toBe(4);
});

test("multiple remote-only parts heal in sequence", () => {
  const plan = recoveryPlan([lp(1, 0, 2, 30)], [rp(1, 30), rp(2, 20), rp(3, 10)], segs(6));
  expect(plan.demoteFrom).toBeNull();
  expect(plan.heals.map((h) => [h.firstIdx, h.lastIdx])).toEqual([
    [3, 4],
    [5, 5],
  ]);
  expect(plan.durableThrough).toBe(5);
});

test("unrebuildable remote-only part (missing segment rows) demotes from it", () => {
  const plan = recoveryPlan([lp(1, 0, 2, 30)], [rp(1, 30), rp(2, 20)], segs(3));
  expect(plan.demoteFrom).toBe(2);
  expect(plan.durableThrough).toBe(2);
});

test("remote-only part whose size no segment sum matches demotes", () => {
  // 10-byte segments can never sum to 25
  const plan = recoveryPlan([lp(1, 0, 2, 30)], [rp(1, 30), rp(2, 25)], segs(6));
  expect(plan.demoteFrom).toBe(2);
  expect(plan.durableThrough).toBe(2);
});

test("ledger part missing in MinIO demotes from it (segments await re-send)", () => {
  const plan = recoveryPlan([lp(1, 0, 2, 30), lp(2, 3, 5, 30)], [rp(1, 30)], segs(6));
  expect(plan.demoteFrom).toBe(2);
  expect(plan.durableThrough).toBe(2);
});

test("etag mismatch with equal size keeps bytes and retags to MinIO's etag", () => {
  const plan = recoveryPlan([lp(1, 0, 2, 30, "old")], [rp(1, 30, "new")], segs(3));
  expect(plan.demoteFrom).toBeNull();
  expect(plan.retags).toEqual([{ partNumber: 1, etag: "new" }]);
  expect(plan.durableThrough).toBe(2);
});

test("size mismatch between ledger and MinIO demotes from that part", () => {
  const plan = recoveryPlan([lp(1, 0, 2, 30)], [rp(1, 40)], segs(3));
  expect(plan.demoteFrom).toBe(1);
  expect(plan.durableThrough).toBe(-1);
});

test("hole in remote part numbering cascades: part 3 dies with part 2", () => {
  const plan = recoveryPlan(
    [lp(1, 0, 2, 30), lp(2, 3, 5, 30), lp(3, 6, 8, 30)],
    [rp(1, 30), rp(3, 30)],
    segs(9),
  );
  expect(plan.demoteFrom).toBe(2);
  expect(plan.durableThrough).toBe(2);
});

test("empty ledger and empty listing: nothing to do", () => {
  const plan = recoveryPlan([], [], segs(0));
  expect(plan.demoteFrom).toBeNull();
  expect(plan.durableThrough).toBe(-1);
});

test("remote-only part numbered below the ledger top is a contradiction: demote", () => {
  const plan = recoveryPlan([lp(2, 3, 5, 30)], [rp(1, 30), rp(2, 30)], segs(6));
  expect(plan.demoteFrom).toBe(1);
  expect(plan.durableThrough).toBe(-1);
});
