import { expect, test } from "bun:test";
import { Assembler, type AssemblerStore } from "../../../src/features/minio_handler/assembler";
import type { SessionRow } from "../../../src/lib/db/minio_tracker";
import type { S3Parts } from "../../../src/lib/minio_storage/s3sdk";

// In-memory fakes: flush logic tested without MinIO or sqlite rows.
function fakeStore() {
  const committed: Array<{ partNumber: number; etag: string; sizeBytes: number; firstIdx: number; lastIdx: number }> = [];
  const segments = new Map<number, { size: number; state: string }>();
  let highestSeen = -1;
  const store: AssemblerStore & {
    committed: typeof committed;
    segments: typeof segments;
    highestSeen: () => number;
  } = {
    committed,
    segments,
    highestSeen: () => highestSeen,
    parts: () => committed.map((p) => ({ part_number: p.partNumber })), // snake rows, like tracker
    upsertSegment: (_s, idx, size) => segments.set(idx, { size, state: "received" }),
    setHighestSeen: (_s, i) => (highestSeen = Math.max(highestSeen, i)),
    commitPart: (_s, p) => {
      committed.push(p);
      for (let i = p.firstIdx; i <= p.lastIdx; i++) segments.get(i)!.state = "in_part";
    },
  };
  return store;
}

function fakeOps() {
  const uploads: Array<{ partNumber: number; bytes: number }> = [];
  const ops: Pick<S3Parts, "uploadPart"> & { uploads: typeof uploads } = {
    uploads,
    uploadPart: async (_b, _k, _u, partNumber, body) => {
      uploads.push({ partNumber, bytes: body.byteLength });
      return `etag-${partNumber}`;
    },
  };
  return ops;
}

function makeAssembler(store: AssemblerStore, ops: Pick<S3Parts, "uploadPart">, partSize: number, cap = 100_000) {
  const session = {
    id: crypto.randomUUID(),
    kind: "master" as const,
    bucket: "travis-raw",
    storage_stem: "projects/9/sessions/9/recordings/9",
    upload_id: "u",
    durable_through: -1,
  } as unknown as SessionRow;
  return new Assembler(session, { ops, store, partSizeBytes: partSize, bufferCapBytes: cap });
}

const b = (n = 10) => new Uint8Array(n);

test("holes block flushing; filling the hole flushes the whole contiguous run", async () => {
  const store = fakeStore();
  const a = makeAssembler(store, fakeOps(), 50);

  await a.append(0, b());
  await a.append(1, b());
  await a.append(3, b());
  await a.append(4, b());
  expect(a.durableThrough).toBe(-1);
  expect(store.committed).toEqual([]);

  await a.append(2, b());
  expect(a.durableThrough).toBe(4);
  expect(store.committed).toEqual([
    { partNumber: 1, etag: "etag-1", sizeBytes: 50, firstIdx: 0, lastIdx: 4 },
  ]);
  for (let i = 0; i <= 4; i++) expect(store.segments.get(i)!.state).toBe("in_part");
});

test("late gap-fill cuts only the gap, never re-covering uploaded indices (F2)", async () => {
  const store = fakeStore();
  const ops = fakeOps();
  const a = makeAssembler(store, ops, 30);

  await a.append(0, b());
  await a.append(1, b());
  await a.append(2, b());
  expect(a.durableThrough).toBe(2); // part 1 = segs 0-2

  await a.append(3, b());
  await a.append(5, b()); // hole at 4 blocks everything after 3
  await a.append(6, b());
  expect(a.durableThrough).toBe(2);

  await a.append(4, b()); // fills the gap: 3,4,5 flush; 6 waits
  expect(a.durableThrough).toBe(5);
  expect(store.segments.get(6)!.state).toBe("received");

  await a.flushFinal(); // final part may be any size
  expect(a.durableThrough).toBe(6);
  expect(store.committed.map((p) => [p.firstIdx, p.lastIdx, p.sizeBytes])).toEqual([
    [0, 2, 30],
    [3, 5, 30],
    [6, 6, 10],
  ]);
  expect(ops.uploads.map((u) => u.partNumber)).toEqual([1, 2, 3]);
});

test("re-POST of an already-durable index is discarded without touching state", async () => {
  const store = fakeStore();
  const a = makeAssembler(store, fakeOps(), 30);

  await a.append(0, b());
  await a.append(1, b());
  await a.append(2, b());
  expect(a.durableThrough).toBe(2);

  await a.append(1, b(7)); // different bytes for a durable index: ignored
  expect(a.durableThrough).toBe(2);
  expect(store.segments.get(1)!.size).toBe(10); // row untouched
  expect(store.committed.length).toBe(1);
});

test("re-POST of a buffered index replaces the slot (no double count)", async () => {
  const store = fakeStore();
  const a = makeAssembler(store, fakeOps(), 20, 25);

  await a.append(0, b(10)); // 10 < partSize: stays buffered
  await a.append(0, b(12)); // replace: 12 buffered, not 22 (cap is 25 — 22+8 would reject below)
  await a.append(1, b(8));
  // 12 + 8 = 20 reaches partSize and flushes as one part — replace worked
  expect(a.durableThrough).toBe(1);
  expect(store.committed).toEqual([{ partNumber: 1, etag: "etag-1", sizeBytes: 20, firstIdx: 0, lastIdx: 1 }]);
});

test("a fresh assembler over an existing ledger resumes part numbering (restart)", async () => {
  const store = fakeStore();
  const ops = fakeOps();
  const session = {
    id: crypto.randomUUID(),
    kind: "master" as const,
    bucket: "travis-raw",
    storage_stem: "projects/9/sessions/9/recordings/9",
    upload_id: "u",
    durable_through: -1,
  } as unknown as SessionRow;

  // first process: cuts part 1 (segs 0-2), then dies
  const a1 = new Assembler(session, { ops, store, partSizeBytes: 30 });
  await a1.append(0, b());
  await a1.append(1, b());
  await a1.append(2, b());
  expect(a1.durableThrough).toBe(2);

  // restarted process: new assembler over the same persisted ledger + session row
  const a2 = new Assembler({ ...session, durable_through: a1.durableThrough }, { ops, store, partSizeBytes: 30 });
  await a2.append(3, b());
  await a2.append(4, b());
  await a2.append(5, b());
  expect(a2.durableThrough).toBe(5);
  expect(ops.uploads.map((u) => u.partNumber)).toEqual([1, 2]); // no part-1 collision
});

test("mixed segment sizes cut parts at byte boundaries, not segment edges", async () => {
  const store = fakeStore();
  const ops = fakeOps();
  const a = makeAssembler(store, ops, 100);

  // sizes: 30+45+40=115 (part 1 spills past the 100B mark), 55+20+60=135 (part 2)
  const sizes = [30, 45, 40, 55, 20, 60];
  for (let i = 0; i < sizes.length; i++) await a.append(i, b(sizes[i]));

  expect(ops.uploads).toEqual([
    { partNumber: 1, bytes: 115 },
    { partNumber: 2, bytes: 135 },
  ]);
  expect(store.committed.map((p) => [p.firstIdx, p.lastIdx, p.sizeBytes])).toEqual([
    [0, 2, 115],
    [3, 5, 135],
  ]);
  expect(a.durableThrough).toBe(5);
});

test("a segment larger than partSize becomes its own oversized part", async () => {
  const store = fakeStore();
  const ops = fakeOps();
  const a = makeAssembler(store, ops, 50);

  await a.append(0, b(80)); // single seg crosses the threshold alone
  expect(ops.uploads).toEqual([{ partNumber: 1, bytes: 80 }]);
  expect(a.durableThrough).toBe(0);

  await a.append(1, b(10)); // small tail waits for flushFinal
  expect(a.durableThrough).toBe(0);

  await a.flushFinal();
  expect(ops.uploads).toEqual([
    { partNumber: 1, bytes: 80 },
    { partNumber: 2, bytes: 10 },
  ]);
  expect(a.durableThrough).toBe(1);
});

test("backpressure: cap rejects before storing, session stays resumable", async () => {
  const store = fakeStore();
  const a = makeAssembler(store, fakeOps(), 30, 40);

  await a.append(0, b(10));
  await a.append(1, b(10));
  await a.append(3, b(10));
  await a.append(4, b(10)); // 40 buffered, hole at 2

  let err: unknown;
  try {
    await a.append(5, b(10));
  } catch (e) {
    err = e;
  }
  expect((err as { status?: number })?.status).toBe(503);
  expect((err as { code?: string })?.code).toBe("backpressure");
  expect(store.segments.has(5)).toBe(false); // rejected bytes never entered state

  await a.append(2, b(10)); // hole fills: flushes 0-2 (30 bytes)
  expect(a.durableThrough).toBe(2);
  expect(store.committed.map((p) => p.lastIdx)).toEqual([2]);
});
