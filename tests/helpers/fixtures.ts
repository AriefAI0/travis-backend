// Real MPEG-TS fixtures — H.264 ultrafast + AAC, ~2s keyframe-aligned segments.
// Sliced from ONE continuous encode: the transport layer (CC + PCR) has no
// junction resets at all, so the raw sewn master.ts plays clean in any player.
// 128k audio because 64k mono aac emits one glitchy frame.
// (synthetic bytes can't survive ffmpeg remux in later phases; spec Testing.)
export async function generateSegments(dir: string, count: number): Promise<string[]> {
  await Bun.$`mkdir -p ${dir}`.quiet();
  const duration = count * 2 + 4;
  const master = `${dir}/master.ts`;

  // flow: encode once > find keyframe offsets > slice at packet boundaries
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=duration=${duration}:size=320x240:rate=24`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${duration}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-g",
      "48",
      "-b:v",
      "1500k",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "mpegts",
      master,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg fixture generation failed: ${err.slice(0, 500)}`);
  }

  // keyframe (pos, pts) pairs — csv fields arrive in ffprobe's own order, match by shape
  const probe = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pos,pts_time,flags",
      "-of",
      "csv=p=0",
      master,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [pcode, csv] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
  if (pcode !== 0) throw new Error("ffprobe keyframe scan failed");
  const keyframes: { pos: number; pts: number }[] = [];
  for (const row of csv.trim().split("\n")) {
    const fields = row.split(",");
    if (!fields.some((f) => f.includes("K"))) continue; // keyframes only
    const pos = Number(fields.find((f) => /^\d+$/.test(f)));
    const pts = Number(fields.find((f) => f.includes(".")));
    if (Number.isFinite(pos) && Number.isFinite(pts)) keyframes.push({ pos, pts });
  }

  // cut at the keyframe nearest each 2s mark; edges[0]=0, edges[count]=last cut
  const cuts: number[] = [];
  for (let k = 1; k <= count; k++) {
    const target = k * 2;
    const best = keyframes.reduce((a, b) => (Math.abs(b.pts - target) < Math.abs(a.pts - target) ? b : a));
    cuts.push(best.pos - (best.pos % 188)); // snap to TS packet boundary
  }
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] <= cuts[i - 1]) throw new Error(`fixture cut not monotonic at ${i}`);
  }

  // slice the continuous stream — bytes are never re-muxed
  const buf = new Uint8Array(await Bun.file(master).arrayBuffer());
  const edges = [0, ...cuts];
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf[edges[i]] !== 0x47) throw new Error(`cut ${i} not on a TS sync byte`);
    const path = `${dir}/seg${String(i).padStart(5, "0")}.ts`;
    await Bun.write(path, buf.subarray(edges[i], edges[i + 1]));
    paths.push(path);
  }
  await Bun.$`rm -f ${master}`.quiet();
  return paths;
}
