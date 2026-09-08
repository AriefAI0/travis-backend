// One-off remux probe: does the fixture master remux whole but fail sliced?
import { mkdirSync } from "node:fs";

const dir = `/tmp/ffx-${Date.now()}`;
mkdirSync(dir, { recursive: true });
const duration = 10;
const master = `${dir}/master.ts`;

const proc = Bun.spawn(
  [
    "ffmpeg", "-y", "-f", "lavfi", "-i", `testsrc=duration=${duration}:size=320x240:rate=24`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "48",
    "-b:v", "1500k", "-c:a", "aac", "-b:a", "128k", "-f", "mpegts", master,
  ],
  { stdout: "ignore", stderr: "pipe" }
);
console.log("ENCODE", await proc.exited);

const remux = Bun.spawn(["ffmpeg", "-y", "-i", master, "-c", "copy", `${dir}/full.mkv`], {
  stdout: "ignore", stderr: "pipe",
});
console.log("FULL_REMUX", await remux.exited);

const buf = new Uint8Array(await Bun.file(master).arrayBuffer());
const cut = Math.floor(buf.length * 0.25);
const head = buf.slice(0, cut - (cut % 188));
await Bun.write(`${dir}/head.ts`, head);
const r2 = Bun.spawn(["ffmpeg", "-y", "-i", `${dir}/head.ts`, "-c", "copy", `${dir}/head.mkv`], {
  stdout: "ignore", stderr: "pipe",
});
const c2 = await r2.exited;
console.log("HEAD_REMUX", c2);
if (c2 !== 0) console.log((await new Response(r2.stderr).text()).slice(-400));
