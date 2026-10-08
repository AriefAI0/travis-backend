// Manual drill: delete a project and prove its MinIO folder is emptied.
//
// Run from the backend dir, with DATABASE_URL and MINIO_* pointing at the dev
// stack:  bun run tests/checks/delete-project-media.ts
//
// flow: seed project + clip + real objects > DELETE > assert rows and objects gone
// ponytail: writes to the dev bucket and the dev DB. It removes its own fixture
// on the way out, so nothing is left behind on a pass or a fail.

import { eq } from "drizzle-orm";

import { app } from "../../src/app";
import { env } from "../../src/config/env";
import { db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { minio } from "../../src/lib/minio_storage/clients";
import { buildMasterKeyPrefix } from "../../src/lib/minio_storage/paths";

const TITLE = "zz-delete-drill";

let failures = 0;

// one line per check: a drill is read at a glance
const check = (label: string, passed: boolean, detail = ""): void => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const countObjects = async (prefix: string): Promise<number> => {
  let found = 0;
  for await (const obj of minio.listObjects(env.BUCKET_MEDIA, prefix, true)) {
    if (obj.name) found += 1;
  }
  return found;
};

const removeFolder = async (prefix: string): Promise<void> => {
  for await (const obj of minio.listObjects(env.BUCKET_MEDIA, prefix, true)) {
    if (obj.name) await minio.removeObject(env.BUCKET_MEDIA, obj.name);
  }
};

const main = async (): Promise<void> => {
  // created through the route so the ordinal is real: a hand-picked
  // display_number would collide with a live project
  const created = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: TITLE }),
  });
  const { data: project } = (await created.json()) as {
    data: { projectId: number; displayNumber: number; title: string };
  };
  check("project created", created.status === 201, `status ${created.status}`);

  // the shape that returned 404 before the cascade fix: one clip under a session
  const [session] = await db
    .insert(schema.session)
    .values({ projectId: project.projectId, displayNumber: 1, startEpoch: 1000 })
    .returning();
  const [group] = await db
    .insert(schema.taskGroup)
    .values({ projectId: project.projectId, code: "100" })
    .returning();
  const [taskCode] = await db
    .insert(schema.taskCode)
    .values({ taskGroupId: group!.taskGroupId, code: "101" })
    .returning();
  const [description] = await db
    .insert(schema.description)
    .values({ taskCodeId: taskCode!.taskCodeId, label: "JL-01" })
    .returning();
  const [result] = await db
    .insert(schema.result)
    .values({
      displayNumber: 1,
      inspectionTypeCode: "GVI",
      projectId: project.projectId,
      sessionId: session!.sessionId,
      descriptionId: description!.descriptionId,
      layer: 1,
      masterStartMs: 0,
    })
    .returning();
  await db.insert(schema.videoClip).values({
    resultId: result!.resultId,
    sessionId: session!.sessionId,
    startOffsetMs: 0,
  });

  const startEpoch = Math.floor(Date.now() / 1000);
  const keyPrefix = buildMasterKeyPrefix({
    projectNumber: project.displayNumber,
    projectTitle: project.title,
    displayNumber: 1,
    startEpoch,
  });
  const folder = keyPrefix.split("/")[0]!;

  await db.insert(schema.recordingIngest).values({
    kind: "master",
    sessionId: session!.sessionId,
    ticketHash: "drill-ticket-hash",
    keyDate: "2026-01-01",
    keyPrefix,
    // closed: an open ingest is refused by design, and that is a separate check
    closedAt: new Date(),
  });

  const written = [`${keyPrefix}/segments/0000000000.ts`, `${keyPrefix}/thumbnail.jpg`];
  for (const key of written) {
    await minio.putObject(env.BUCKET_MEDIA, key, Buffer.from("drill"));
  }
  check("objects written under the frozen folder", (await countObjects(folder)) === written.length);

  const res = await app.request(`/api/v1/projects/${project.projectId}`, { method: "DELETE" });
  check("DELETE returns 200", res.status === 200, `status ${res.status}`);

  check("bucket folder emptied", (await countObjects(folder)) === 0);

  const projects = await db
    .select()
    .from(schema.project)
    .where(eq(schema.project.projectId, project.projectId));
  check("project row gone", projects.length === 0);

  const clips = await db
    .select()
    .from(schema.videoClip)
    .where(eq(schema.videoClip.sessionId, session!.sessionId));
  check("clip row gone", clips.length === 0);

  const ingests = await db
    .select()
    .from(schema.recordingIngest)
    .where(eq(schema.recordingIngest.sessionId, session!.sessionId));
  check("ingest row gone", ingests.length === 0);

  // a failed delete leaves the fixture standing; take it back out
  if (failures > 0) {
    console.log("cleaning up the leftover fixture");
    await removeFolder(folder);
    try {
      await db.delete(schema.project).where(eq(schema.project.projectId, project.projectId));
    } catch (err) {
      console.log(`fixture cleanup failed: ${String(err)}`);
    }
  }

  console.log(failures === 0 ? "\nDRILL PASS" : `\nDRILL FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
