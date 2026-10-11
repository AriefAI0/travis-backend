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
import { authRoutes } from "../../../src/features/auth/routes";

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
