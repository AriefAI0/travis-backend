import { createServer } from "node:net";

export interface TestServer {
  baseUrl: string;
  port: number;
  stop(): Promise<void>;
  kill(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Boots the real server as a child process with env overrides — the true HTTP
// boundary. Phase 3 reuses kill() for crash-recovery tests.
export async function startServer(overrides: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    env: { ...process.env, ...overrides, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain pipes so the child never blocks on a full buffer.
  void (async () => {
    for await (const _ of proc.stdout) {
    }
  })();
  void (async () => {
    for await (const _ of proc.stderr) {
    }
  })();

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error("server exited during boot");
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        return {
          baseUrl,
          port,
          stop: async () => {
            proc.kill();
            await proc.exited;
          },
          kill: () => proc.kill("SIGKILL"),
        };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  throw new Error("server did not become healthy in 20s");
}
