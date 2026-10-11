// Editor access: one expiring token per report, handed to the browser as an
// httpOnly cookie when the backend serves the editor page.
//
// The editor is a browser tab with no login, so it cannot carry a bearer. The
// cookie IS its authorization, and it is bound to one report id: a token for
// another report never opens this one.
//
// Signed with the playback key, with a purpose claim in the payload so a
// playback token can never be replayed as an editor token.
// flow: mint(purpose + reportId + expiry) > HMAC-SHA256 > v1.<payload>.<sig>

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config/env";

export const REPORT_EDITOR_COOKIE = "report_editor";

// one editing session; short enough that a leaked cookie dies on its own
export const REPORT_EDITOR_TTL_SECONDS = 60 * 60;

const VERSION = "v1";
// the purpose claim: a token signed for another surface cannot stand in here
const PURPOSE = "report-editor";

const sign = (payload: string): string =>
  createHmac("sha256", env.PLAYBACK_TOKEN_SECRET).update(payload).digest("base64url");

export const reportEditorTokenExpiry = (now: Date = new Date()): number =>
  Math.floor(now.getTime() / 1000) + REPORT_EDITOR_TTL_SECONDS;

export function mintReportEditorToken(reportId: string, expiresAt?: number): string {
  const claims = { s: PURPOSE, i: reportId, e: expiresAt ?? reportEditorTokenExpiry() };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${VERSION}.${payload}.${sign(`${VERSION}.${payload}`)}`;
}

// The cookie path answers yes or no rather than throwing: a bad cookie falls
// back to the bearer check, which decides on its own.
export function verifyReportEditorToken(
  token: string | null,
  reportId: string,
  now: Date = new Date(),
): boolean {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) return false;
  const [version, payload, signature] = parts as [string, string, string];

  const expected = Buffer.from(sign(`${version}.${payload}`), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  let claims: { s?: unknown; i?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  if (claims.s !== PURPOSE || claims.i !== reportId || typeof claims.e !== "number") return false;
  return claims.e * 1000 > now.getTime();
}
