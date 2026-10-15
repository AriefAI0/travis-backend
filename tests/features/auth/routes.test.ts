import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { bearer, createTestUser, TEST_PASSWORD } from "../../helpers/auth";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { json } from "../../helpers/json";
import { authRoutes, withoutFetchMetadata } from "../../../src/features/auth/routes";

const app = appFor(testDb, authRoutes);

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// better-auth skips its origin and CSRF checks entirely when NODE_ENV is
// "test", so a browser-still-refused case cannot be asserted here: it answers
// 200 whether the strip runs or not. The strip's own contract is asserted
// instead, which is the part this backend owns.
describe("withoutFetchMetadata", () => {
  const build = (headers: Record<string, string>) =>
    new Request("http://localhost/api/v1/auth/sign-in/email", { method: "POST", headers });

  it("drops the three browser headers", () => {
    const stripped = withoutFetchMetadata(
      build({
        origin: "http://localhost:5173",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      }),
    );

    expect(stripped.headers.get("sec-fetch-site")).toBeNull();
    expect(stripped.headers.get("sec-fetch-mode")).toBeNull();
    expect(stripped.headers.get("sec-fetch-dest")).toBeNull();
  });

  // The whole point: the Origin check stays in charge after the strip.
  it("keeps the origin and every other header", () => {
    const stripped = withoutFetchMetadata(
      build({ origin: "http://elsewhere.local", "content-type": "application/json" }),
    );

    expect(stripped.headers.get("origin")).toBe("http://elsewhere.local");
    expect(stripped.headers.get("content-type")).toBe("application/json");
  });

  it("hands back the same request when there is nothing to strip", () => {
    const request = build({ origin: "http://localhost:5173" });

    expect(withoutFetchMetadata(request)).toBe(request);
  });
});

describe("auth routes", () => {
  it("signs in and returns the token in the set-auth-token header", async () => {
    const user = await createTestUser();

    const res = await post("/api/v1/auth/sign-in/email", {
      email: user.email,
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
    // the bearer plugin is a cookie bridge: the token arrives as a header,
    // never in the JSON body
    const token = res.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    expect(await res.text()).not.toContain(token!);
  });

  it("signs in with a username instead of an email", async () => {
    await createTestUser({ username: "admin", email: "real@example.local" });

    const res = await post("/api/v1/auth/sign-in/email", {
      email: "Admin",
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-token")).toBeTruthy();
  });

  it("refuses an unknown username as an invalid identifier", async () => {
    const res = await post("/api/v1/auth/sign-in/email", {
      email: "nobody-here",
      password: TEST_PASSWORD,
    });

    // not an email and not a known handle: better-auth rejects the format
    expect(res.status).toBe(400);
    expect(res.headers.get("set-auth-token")).toBeNull();
  });

  it("refuses a wrong password", async () => {
    const user = await createTestUser();

    const res = await post("/api/v1/auth/sign-in/email", {
      email: user.email,
      password: "not-the-password",
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("set-auth-token")).toBeNull();
  });

  it("refuses an unknown account", async () => {
    const res = await post("/api/v1/auth/sign-in/email", {
      email: "nobody@example.local",
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(401);
  });

  it("closes sign-up: an admin creates every account", async () => {
    const res = await post("/api/v1/auth/sign-up/email", {
      email: "self@example.local",
      password: TEST_PASSWORD,
      name: "Self Serve",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a password under the 12 character floor", async () => {
    const user = await createTestUser();

    const res = await post("/api/v1/auth/sign-in/email", {
      email: user.email,
      password: "short",
    });

    expect(res.status).toBe(401);
  });

  it("reads a session from a bearer token", async () => {
    const user = await createTestUser();

    const res = await app.request("/api/v1/auth/get-session", {
      headers: bearer(user.token),
    });

    expect(res.status).toBe(200);
    const body = await json<{ user?: { email?: string } }>(res);
    expect(body.user?.email).toBe(user.email);
  });

  // The desktop app signs in from the main process, whose fetch sends
  // `sec-fetch-mode: cors` and no Origin. better-auth read that as a browser
  // refusing to say where it came from, and turned every sign-in into a 403.
  it("signs in a desktop client that sends fetch metadata but no origin", async () => {
    const user = await createTestUser();

    const res = await post(
      "/api/v1/auth/sign-in/email",
      { email: user.email, password: TEST_PASSWORD },
      { "sec-fetch-mode": "cors" },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-token")).toBeTruthy();
  });

  it("revokes the session on sign-out", async () => {
    const user = await createTestUser();

    const out = await post("/api/v1/auth/sign-out", {}, bearer(user.token));
    expect(out.status).toBe(200);

    // the same token is dead: get-session answers a bare null
    const after = await app.request("/api/v1/auth/get-session", {
      headers: bearer(user.token),
    });
    const body = await json<{ user?: unknown } | null>(after);
    expect(after.status).toBe(200);
    expect(body?.user ?? null).toBeNull();
  });
});
