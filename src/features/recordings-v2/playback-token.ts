// Scoped playback access: one expiring token per recording, signed with a key
// that is not the ingest ticket or the deployment token.
// flow: mint(kind + id + expiry) > HMAC-SHA256 > v1.<payload>.<signature>

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../../config/env";
import { AppError } from "../../lib/error";

export type PlaybackScope = {
  kind: "master" | "clip";
  id: number;
};

// long enough for one playback session, short enough to bound a leak
export const PLAYBACK_TOKEN_TTL_SECONDS = 12 * 60 * 60;

const VERSION = "v1";

const sign = (payload: string): string =>
  createHmac("sha256", env.PLAYBACK_TOKEN_SECRET).update(payload).digest("base64url");

export const playbackTokenExpiry = (now: Date = new Date()): number =>
  Math.floor(now.getTime() / 1000) + PLAYBACK_TOKEN_TTL_SECONDS;

// mint one token bound to a recording; the id is the masterVideoId or the clipId
export function mintPlaybackToken(scope: PlaybackScope, expiresAt?: number): string {
  const claims = { k: scope.kind, i: scope.id, e: expiresAt ?? playbackTokenExpiry() };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${VERSION}.${payload}.${sign(`${VERSION}.${payload}`)}`;
}

const reject = (code: string, message: string) => new AppError(401, code, message);

// constant-time compare of the signature, then the claims
function signatureMatches(payload: string, presented: string): boolean {
  const expected = Buffer.from(sign(payload), "utf8");
  const actual = Buffer.from(presented, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// verify a token against the scope the request asks for
export function verifyPlaybackToken(
  token: string | null,
  scope: PlaybackScope,
  now: Date = new Date(),
): void {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    throw reject("playback_token_malformed", "Playback token is malformed");
  }
  const [version, payload, signature] = parts as [string, string, string];

  if (!signatureMatches(`${version}.${payload}`, signature)) {
    throw reject("playback_token_invalid", "Playback token signature does not match");
  }

  let claims: { k?: unknown; i?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw reject("playback_token_malformed", "Playback token payload is not JSON");
  }
  if (typeof claims.k !== "string" || typeof claims.i !== "number" || typeof claims.e !== "number") {
    throw reject("playback_token_malformed", "Playback token claims are incomplete");
  }

  if (claims.e * 1000 <= now.getTime()) {
    throw reject("playback_token_expired", "Playback token has expired");
  }

  // a valid token for another recording never authorizes this one
  if (claims.k !== scope.kind || claims.i !== scope.id) {
    throw reject("playback_token_scope", "Playback token covers a different recording");
  }
}
