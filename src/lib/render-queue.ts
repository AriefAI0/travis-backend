// One render at a time, in arrival order, shared by both report paths.
//
// A burst of requests becomes a line instead of a pile of competing renders.
// The queue is in-process on purpose: one container runs one app, and a job
// that dies with the process leaves a row the boot sweep closes.
// flow: enqueue > wait for the slot > run > retry once if transient
import { AppError } from "./error";
import { log } from "./logger";

// Jobs allowed to wait before a new one is refused. The cap protects memory:
// each waiting job holds its request data.
const MAX_DEPTH = 20;

// One retry, one second apart. A transient fault is usually a dropped socket
// that is back by then.
const RETRY_DELAY_MS = 1_000;

// Socket-level faults worth a second try.
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

// A 5xx worth a second try. Everything else in the 5xx range describes the
// data or the template, which will fail the same way twice.
const PERMANENT_CODES = new Set([
  "template_error",
  "pdf_converter_missing",
  "region_mismatch",
  "region_order_mismatch",
]);

// A fault that clears on its own: a socket drop or a converter timeout.
export const isTransient = (err: unknown): boolean => {
  if (err instanceof AppError) {
    return err.status >= 500 && !PERMANENT_CODES.has(err.code);
  }
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
};

// The slot itself. Work queues behind whatever ran last, and a failed job
// never breaks the chain.
let gate: Promise<unknown> = Promise.resolve();
let pending = 0;

// Jobs in flight plus jobs waiting.
export const renderQueueDepth = () => pending;

// Run one job when the slot frees up.
export const enqueueRender = <T>(work: () => Promise<T>): Promise<T> => {
  if (pending >= MAX_DEPTH) {
    return Promise.reject(
      new AppError(
        503,
        "render_queue_full",
        `${pending} renders are queued; ask again when the queue drains`,
      ),
    );
  }
  pending++;

  const task = async (): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      if (!isTransient(err)) throw err;
      log.warn("render retry", { err: String(err) });
      await Bun.sleep(RETRY_DELAY_MS);
      return work();
    }
  };

  const run = gate.then(task, task);
  // the chain never rejects, so a failed job cannot strand the next one
  gate = run.catch(() => undefined);
  return run.finally(() => {
    pending--;
  }) as Promise<T>;
};
