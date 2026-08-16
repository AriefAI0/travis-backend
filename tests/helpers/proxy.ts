import { connect as netConnect, createServer as netServer, type Socket as NetSocket } from "node:net";

export interface TcpProxy {
  port: number;
  disconnect(): void;
  reconnect(): void;
  close(): void;
}

// TCP pipe with a kill switch: the server-under-test points MINIO_ENDPOINT at
// the proxy, so tests can cut MinIO off mid-session without touching the real
// service (spec Testing #5). node:net + pipe() — backpressure and the
// data-before-connect race are handled by the stream machinery, not by us.
export function tcpProxy(targetPort: number, targetHost = "127.0.0.1"): TcpProxy {
  let broken = false;
  let closed = false;
  const sockets: NetSocket[] = [];

  const server = netServer((client) => {
    if (broken || closed) {
      client.destroy(); // dead proxy: refuse new connections immediately
      return;
    }
    const upstream = netConnect(targetPort, targetHost);
    sockets.push(client, upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const kill = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", kill);
    upstream.on("error", kill);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  server.listen(0, "127.0.0.1");

  // Rupture every live connection — in-flight requests fail fast with a reset.
  const dropAll = () => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
  };

  return {
    port: (server.address() as { port: number }).port,
    disconnect() {
      broken = true;
      dropAll();
    },
    reconnect() {
      broken = false;
    },
    close() {
      closed = true;
      broken = true;
      dropAll();
      server.close();
    },
  };
}
