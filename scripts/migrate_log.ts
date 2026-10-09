// Pre-deploy connection checks — answers "postgres or minio, which one broke?"
// Runs before drizzle push in the migrate container; exit 1 stops the deploy.
import { Pool } from "pg";
import { env } from "../src/config/env";
import { buildMinioClient } from "../src/lib/minio_storage/clients";

// hide secrets, keep host/port — wrong host is the #1 deploy bug
function maskUrl(raw: string): string {
  return raw.replace(/\/\/([^:/@]+):([^@]+)@/, "//$1:***@");
}

// map pg error codes to plain causes
function pgCause(err: Error & { code?: string }): string {
  const causes: Record<string, string> = {
    ECONNREFUSED: "nothing listening on that host:port — wrong port, service down, or firewall",
    ENOTFOUND: "hostname does not resolve — check the host in DATABASE_URL",
    EAI_AGAIN: "DNS lookup failed — check the host in DATABASE_URL",
    ETIMEDOUT: "host unreachable — wrong IP or firewall drops packets",
    "28P01": "wrong password (or wrong user)",
    "28000": "login rejected — wrong user, or pg_hba.conf refuses this host",
    "3D000": "database does not exist on that server",
  };
  return causes[err.code ?? ""] ?? err.message;
}

// map minio/s3 error codes to plain causes
function minioCause(err: Error & { code?: string }): string {
  const causes: Record<string, string> = {
    InvalidAccessKeyId: "wrong MINIO_ACCESS_KEY",
    SignatureDoesNotMatch: "wrong MINIO_SECRET_KEY",
    AccessDenied: "credentials valid but the key lacks access",
    ECONNREFUSED: "nothing listening on that endpoint — wrong port or MinIO down",
    ENOTFOUND: "endpoint hostname does not resolve",
    EAI_AGAIN: "DNS lookup failed — check the host in MINIO_ENDPOINT",
  };
  return causes[err.code ?? ""] ?? err.message;
}

// one PASS/FAIL line per target
async function check(
  name: string,
  target: string,
  cause: (err: Error & { code?: string }) => string,
  run: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await run();
    console.log(`[PASS] ${name} ${target}`);
    return true;
  } catch (err) {
    // stdout only: mixed streams reorder when piped (docker logs, CI)
    console.log(`[FAIL] ${name} ${target}`);
    console.log(`       cause: ${cause(err as Error & { code?: string })}`);
    return false;
  }
}

// 5s cap so an unreachable host fails fast instead of hanging the deploy
function withTimeout(work: Promise<unknown>, ms = 5000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no response in ${ms}ms — host unreachable or firewall drops packets`)),
      ms,
    );
  });
  // clear the losing timer so a passing check still exits immediately
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

// flow: env (import parses it) > postgres > minio > verdict
const pg = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, max: 1 });
const pgOk = await check("postgres", maskUrl(env.DATABASE_URL), pgCause, () => pg.query("SELECT 1"));
await pg.end();

const minio = buildMinioClient(env.MINIO_ENDPOINT, env.MINIO_ACCESS_KEY, env.MINIO_SECRET_KEY);
const minioOk = await check(
  "minio",
  `${env.MINIO_ENDPOINT} access-key=${env.MINIO_ACCESS_KEY}`,
  minioCause,
  () => withTimeout(minio.listBuckets()),
);

if (!pgOk || !minioOk) {
  console.log("\npreflight FAILED — fix the [FAIL] lines above, then redeploy");
  process.exit(1);
}
console.log("\npreflight passed — schema push starts now");
// explicit exit: a lingering keep-alive socket must not hold the container
process.exit(0);
