import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { tracker, type SessionRow } from "../../lib/db/minio_tracker";
import { s3parts, type S3Parts } from "../../lib/minio_storage/s3sdk";

// Storage surface the assembler needs — injectable so unit tests run flush
// logic against in-memory fakes (no MinIO, no sqlite rows).
export interface AssemblerStore {
  upsertSegment(sessionId: string, idx: number, sizeBytes: number): void;
  setHighestSeen(sessionId: string, index: number): void;
  commitPart(
    sessionId: string,
    part: { partNumber: number; etag: string; sizeBytes: number; firstIdx: number; lastIdx: number },
  ): void;
  parts(sessionId: string): { part_number: number }[];
}

export interface AssemblerDeps {
  ops?: Pick<S3Parts, "uploadPart">;
  store?: AssemblerStore;
  partSizeBytes?: number;
  bufferCapBytes?: number;
}

// Per-session RAM buffer. Segments accumulate until a contiguous run from
// durableThrough+1 totals >= partSizeBytes, then it is uploaded as one part.
// Parts are always cut starting at durableThrough+1, so an index already inside
// an uploaded part can never be re-uploaded (a re-sent part number would
// overwrite good data — audit fix F2).
export class Assembler {
  private buffer = new Map<number, Uint8Array>();
  private bufferedBytes = 0;
  private nextPartNumber: number;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly ops: Pick<S3Parts, "uploadPart">;
  private readonly store: AssemblerStore;
  private readonly partSize: number;
  private readonly cap: number;

  constructor(private session: SessionRow, deps: AssemblerDeps = {}) {
    this.ops = deps.ops ?? s3parts;
    this.store = deps.store ?? tracker;
    this.partSize = deps.partSizeBytes ?? env.PART_SIZE_BYTES;
    this.cap = deps.bufferCapBytes ?? env.BUFFER_CAP_BYTES;
    // Resume counter from the ledger — snake_case rows, matching tracker.part()'s shape.
    this.nextPartNumber = (this.store.parts(session.id).at(-1)?.part_number ?? 0) + 1;
  }

  get durableThrough() {
    return this.session.durable_through;
  }

  async append(idx: number, bytes: Uint8Array): Promise<void> {
    if (idx <= this.session.durable_through) return; // idempotent replay, bytes discarded
    // Over cap: reject — EXCEPT segments at/below the buffered frontier. Those
    // fill holes or replace slots, and only they can unlock a flush; rejecting
    // them would deadlock a full buffer forever.
    let frontier = -1;
    for (const k of this.buffer.keys()) if (k > frontier) frontier = k;
    if (this.bufferedBytes + bytes.byteLength > this.cap && idx > frontier) {
      throw new AppError(503, "backpressure", "session buffer cap exceeded");
    }
    const existing = this.buffer.get(idx);
    if (existing) this.bufferedBytes -= existing.byteLength; // replace buffered slot
    this.buffer.set(idx, bytes);
    this.bufferedBytes += bytes.byteLength;
    this.store.upsertSegment(this.session.id, idx, bytes.byteLength);
    this.store.setHighestSeen(this.session.id, idx);
    await this.serialize(() => this.flush(false));
  }

  // Final flush at stop: any contiguous bytes, any size (the last listed part is
  // exempt from the 5 MB minimum). Never uploads an empty part (audit fix F3).
  async flushFinal(): Promise<void> {
    await this.serialize(() => this.flush(true));
  }

  private serialize(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn, fn);
    return this.chain;
  }

  private async flush(final: boolean) {
    let nextIdx = this.session.durable_through + 1;
    for (;;) {
      const chunk: Uint8Array[] = [];
      let chunkBytes = 0;
      let lastIdx = nextIdx - 1;
      while (this.buffer.has(nextIdx)) {
        const seg = this.buffer.get(nextIdx)!;
        chunk.push(seg);
        chunkBytes += seg.byteLength;
        lastIdx = nextIdx;
        nextIdx++;
        if (!final && chunkBytes >= this.partSize) break;
      }
      if (chunk.length === 0) return;
      if (!final && chunkBytes < this.partSize) return;

      const body = concat(chunk);
      try {
        const etag = await this.ops.uploadPart(
          this.session.bucket!,
          this.session.object_key!,
          this.session.upload_id!,
          this.nextPartNumber,
          body,
        );
        this.store.commitPart(this.session.id, {
          partNumber: this.nextPartNumber,
          etag,
          sizeBytes: body.byteLength,
          firstIdx: lastIdx - chunk.length + 1,
          lastIdx,
        });
      } catch (err) {
        throw new AppError(503, "storage_unavailable", `part upload failed: ${String(err)}`);
      }
      for (let i = lastIdx - chunk.length + 1; i <= lastIdx; i++) {
        this.bufferedBytes -= this.buffer.get(i)!.byteLength;
        this.buffer.delete(i);
      }
      this.session.durable_through = lastIdx;
      this.nextPartNumber++;
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
