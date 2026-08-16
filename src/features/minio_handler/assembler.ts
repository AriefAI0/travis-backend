import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { tracker, type SessionRow } from "../../lib/db/minio_tracker";
import { s3parts } from "../../lib/minio_storage/s3sdk";

// Per-session RAM buffer. Segments accumulate until a contiguous run from
// durableThrough+1 totals >= PART_SIZE_BYTES, then it is uploaded as one part.
// Parts are always cut starting at durableThrough+1, so an index already inside
// an uploaded part can never be re-uploaded (a re-sent part number would
// overwrite good data — audit fix F2).
export class Assembler {
  private buffer = new Map<number, Uint8Array>();
  private bufferedBytes = 0;
  private nextPartNumber: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private session: SessionRow) {
    const parts = tracker.parts(session.id);
    this.nextPartNumber = (parts.at(-1)?.partNumber ?? 0) + 1;
  }

  get durableThrough() {
    return this.session.durable_through;
  }

  async append(idx: number, bytes: Uint8Array): Promise<void> {
    if (idx <= this.session.durable_through) return; // idempotent replay, bytes discarded
    if (this.bufferedBytes + bytes.byteLength > env.BUFFER_CAP_BYTES) {
      throw new AppError(503, "backpressure", "session buffer cap exceeded");
    }
    const existing = this.buffer.get(idx);
    if (existing) this.bufferedBytes -= existing.byteLength;
    this.buffer.set(idx, bytes);
    this.bufferedBytes += bytes.byteLength;
    tracker.upsertSegment(this.session.id, idx, bytes.byteLength);
    tracker.setHighestSeen(this.session.id, idx);
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
        if (!final && chunkBytes >= env.PART_SIZE_BYTES) break;
      }
      if (chunk.length === 0) return;
      if (!final && chunkBytes < env.PART_SIZE_BYTES) return;

      const body = concat(chunk);
      try {
        const etag = await s3parts.uploadPart(
          this.session.bucket!,
          this.session.object_key!,
          this.session.upload_id!,
          this.nextPartNumber,
          body,
        );
        tracker.commitPart(this.session.id, {
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
