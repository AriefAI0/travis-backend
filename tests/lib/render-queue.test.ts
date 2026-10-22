import { describe, expect, it } from "bun:test";
import { AppError } from "../../src/lib/error";
import { enqueueRender, isTransient } from "../../src/lib/render-queue";

// A job the test releases by hand, to hold the single slot open.
const deferred = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe("render queue", () => {
  it("runs jobs one at a time, in arrival order", async () => {
    let active = 0;
    let peak = 0;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        enqueueRender(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active--;
          return i;
        }),
      ),
    );

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(1);
  });

  it("refuses a job once twenty are queued", async () => {
    const gate = deferred();
    const held = Array.from({ length: 20 }, () => enqueueRender(() => gate.promise));

    const refused = enqueueRender(async () => "late");
    await expect(refused).rejects.toMatchObject({ code: "render_queue_full" });

    gate.release();
    await Promise.all(held);
  });

  it("retries a transient fault once, then succeeds", async () => {
    let tries = 0;
    const value = await enqueueRender(async () => {
      tries++;
      if (tries === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return "ok";
    });

    expect(value).toBe("ok");
    expect(tries).toBe(2);
  });

  it("never retries a permanent fault", async () => {
    let tries = 0;
    const job = enqueueRender(async () => {
      tries++;
      throw new AppError(500, "template_error", "The tag {x} has no closing pair");
    });

    await expect(job).rejects.toThrow("no closing pair");
    expect(tries).toBe(1);
  });

  it("calls a timeout transient and a template error permanent", () => {
    expect(isTransient(new AppError(504, "pdf_conversion_timeout", "late"))).toBe(true);
    expect(isTransient(new AppError(500, "template_error", "bad tag"))).toBe(false);
    expect(isTransient(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isTransient(new Error("plain"))).toBe(false);
  });
});
