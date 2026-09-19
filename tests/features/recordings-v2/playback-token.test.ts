import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import {
  mintPlaybackToken,
  PLAYBACK_TOKEN_TTL_SECONDS,
  playbackTokenExpiry,
  verifyPlaybackToken,
  type PlaybackScope,
} from "../../../src/features/recordings-v2/playback-token";
import { env } from "../../../src/config/env";

const MASTER: PlaybackScope = { kind: "master", id: 41 };
const OTHER: PlaybackScope = { kind: "master", id: 42 };
const CLIP: PlaybackScope = { kind: "clip", id: 41 };

describe("playback tokens", () => {
  test("a minted token verifies against its own scope", () => {
    const token = mintPlaybackToken(MASTER);
    expect(() => verifyPlaybackToken(token, MASTER)).not.toThrow();
    expect(token.startsWith("v1.")).toBe(true);
  });

  test("the token carries kind, id, and expiry — and no secret", () => {
    const token = mintPlaybackToken(MASTER, 1_800_000_000);
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    expect(payload).toEqual({ k: "master", i: 41, e: 1_800_000_000 });
    expect(token).not.toContain(env.PLAYBACK_TOKEN_SECRET);
  });

  test("a cross-recording token fails", () => {
    const token = mintPlaybackToken(OTHER);
    expect(() => verifyPlaybackToken(token, MASTER)).toThrow(/different recording/i);
  });

  test("a clip token never authorizes a master of the same id", () => {
    const token = mintPlaybackToken(CLIP);
    expect(() => verifyPlaybackToken(token, MASTER)).toThrow(/different recording/i);
    expect(() => verifyPlaybackToken(token, CLIP)).not.toThrow();
  });

  test("an expired token fails, a live one passes", () => {
    const now = new Date("2026-09-20T12:00:00.000Z");
    const live = mintPlaybackToken(MASTER, playbackTokenExpiry(now));
    expect(() => verifyPlaybackToken(live, MASTER, now)).not.toThrow();

    const expired = mintPlaybackToken(MASTER, Math.floor(now.getTime() / 1000) - 1);
    expect(() => verifyPlaybackToken(expired, MASTER, now)).toThrow(/expired/i);
  });

  test("the default lifetime is bounded", () => {
    expect(PLAYBACK_TOKEN_TTL_SECONDS).toBeGreaterThan(60 * 60);
    expect(PLAYBACK_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
  });

  test("malformed and tampered tokens fail", () => {
    const token = mintPlaybackToken(MASTER);
    const [version, payload, signature] = token.split(".") as [string, string, string];

    expect(() => verifyPlaybackToken(null, MASTER)).toThrow(/malformed/i);
    expect(() => verifyPlaybackToken("", MASTER)).toThrow(/malformed/i);
    expect(() => verifyPlaybackToken("v1.onlytwo", MASTER)).toThrow(/malformed/i);
    expect(() => verifyPlaybackToken(`v2.${payload}.${signature}`, MASTER)).toThrow(/malformed/i);
    expect(() => verifyPlaybackToken(`${version}.${payload}.AAAA`, MASTER)).toThrow(
      /signature/i,
    );

    // a re-encoded payload with the old signature is refused
    const forged = Buffer.from(JSON.stringify({ k: "master", i: 42, e: 4_000_000_000 }))
      .toString("base64url");
    expect(() => verifyPlaybackToken(`${version}.${forged}.${signature}`, MASTER)).toThrow(
      /signature/i,
    );
  });

  test("a payload that is not JSON fails, and never throws a parse error", () => {
    const payload = Buffer.from("not json").toString("base64url");
    const signature = (mintPlaybackToken(MASTER).split(".") as string[])[2]!;
    expect(() => verifyPlaybackToken(`v1.${payload}.${signature}`, MASTER)).toThrow(
      /signature|malformed/i,
    );
  });
});

// the secret is not optional: boot must fail without it
describe("PLAYBACK_TOKEN_SECRET boot gate", () => {
  const bootEnv = {
    PATH: process.env.PATH ?? "",
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "access",
    MINIO_SECRET_KEY: "secret",
  };

  const bootEnvModule = async (extra: Record<string, string>) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `await import("${new URL("../../../src/config/env.ts", import.meta.url).pathname}");`,
      ],
      {
        // a temp cwd keeps the repo .env out of the child's environment
        cwd: tmpdir(),
        env: { ...bootEnv, ...extra },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr };
  };

  test("boot fails without the secret and names it", async () => {
    const { code, stderr } = await bootEnvModule({});
    expect(code).toBe(1);
    expect(stderr).toContain("PLAYBACK_TOKEN_SECRET");
  });

  test("boot succeeds with a long enough secret", async () => {
    const { code } = await bootEnvModule({ PLAYBACK_TOKEN_SECRET: "s".repeat(48) });
    expect(code).toBe(0);
  });

  test("a short secret is refused", async () => {
    const { code, stderr } = await bootEnvModule({ PLAYBACK_TOKEN_SECRET: "too-short" });
    expect(code).toBe(1);
    expect(stderr).toContain("PLAYBACK_TOKEN_SECRET");
  });
});
