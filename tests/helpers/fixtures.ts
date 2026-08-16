// Real MPEG-TS fixtures — H.264 ultrafast + AAC, ~2s keyframe-aligned segments
// (synthetic bytes can't survive ffmpeg remux in later phases; spec Testing).
export async function generateSegments(dir: string, count: number): Promise<string[]> {
  await Bun.$`mkdir -p ${dir}`.quiet();
  const duration = count * 2 + 4;
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
      "64k",
      "-f",
      "segment",
      "-segment_time",
      "2",
      "-reset_timestamps",
      "1",
      `${dir}/seg%05d.ts`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg fixture generation failed: ${err.slice(0, 500)}`);
  }
  const paths = Array.from({ length: count }, (_, i) => `${dir}/seg${String(i).padStart(5, "0")}.ts`);
  for (const p of paths) {
    if (!(await Bun.file(p).exists())) throw new Error(`fixture segment missing: ${p}`);
  }
  return paths;
}
