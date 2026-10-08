// Manual drill: planned-inspection routes against the running container.
//
// Build and start the stack first:  docker compose up -d --build
// Then:  bun run tests/checks/planned-inspection-drill.ts
//
// flow: seed a task chain over HTTP > plan two types > list > refuse the
// duplicate > delete one > drop the project and watch the cascade clean up

const BASE = process.env.DRILL_BASE_URL ?? "http://localhost:8788";

let failures = 0;

// one line per check: a drill is read at a glance
const check = (label: string, passed: boolean, detail = ""): void => {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

type Reply = { status: number; data: any };

const request = async (method: string, path: string, body?: unknown): Promise<Reply> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json()) as { data?: unknown } | null;
  return { status: res.status, data: (parsed?.data as any) ?? null };
};

const run = async (): Promise<void> => {
  // seed: project > group > task code > description > type > part code
  const project = await request("POST", "/api/v1/projects", { title: "zz-planned-drill" });
  check("create project", project.status === 201, `status ${project.status}`);
  const projectId = project.data.projectId as number;

  const group = await request("POST", "/api/v1/task-groups", { projectId, code: "9Z1" });
  check("create task group", group.status === 201, `status ${group.status}`);
  const taskCode = await request("POST", "/api/v1/task-codes", {
    taskGroupId: group.data.taskGroupId,
    code: "9Z2",
  });
  check("create task code", taskCode.status === 201, `status ${taskCode.status}`);
  const description = await request("POST", "/api/v1/descriptions", {
    taskCodeId: taskCode.data.taskCodeId,
    label: "drill leg",
  });
  check("create description", description.status === 201, `status ${description.status}`);
  const descriptionId = description.data.descriptionId as number;
  const type = await request("POST", "/api/v1/types", { descriptionId, code: "9Z3" });
  check("create type", type.status === 201, `status ${type.status}`);
  const partCode = await request("POST", "/api/v1/part-codes", {
    typeId: type.data.typeId,
    code: "9Z4",
  });
  check("create part code", partCode.status === 201, `status ${partCode.status}`);

  // plan two types on the description, one on the part code
  const plannedGvi = await request("POST", "/api/v1/planned-inspections", {
    projectId,
    inspectionTypeCode: "GVI",
    descriptionId,
  });
  check("plan GVI on description", plannedGvi.status === 201, `status ${plannedGvi.status}`);
  const plannedCvi = await request("POST", "/api/v1/planned-inspections", {
    projectId,
    inspectionTypeCode: "CVI",
    descriptionId,
  });
  check("plan CVI on description", plannedCvi.status === 201, `status ${plannedCvi.status}`);
  const plannedPart = await request("POST", "/api/v1/planned-inspections", {
    projectId,
    inspectionTypeCode: "GVI",
    partCodeId: partCode.data.partCodeId,
  });
  check(
    "plan GVI on part code (same type, other target)",
    plannedPart.status === 201,
    `status ${plannedPart.status}`,
  );

  // the rules: duplicate refused, both targets refused
  const duplicate = await request("POST", "/api/v1/planned-inspections", {
    projectId,
    inspectionTypeCode: "GVI",
    descriptionId,
  });
  check("duplicate type refused", duplicate.status === 409, `status ${duplicate.status}`);
  const both = await request("POST", "/api/v1/planned-inspections", {
    projectId,
    inspectionTypeCode: "MGI",
    descriptionId,
    partCodeId: partCode.data.partCodeId,
  });
  check("both targets refused", both.status === 400, `status ${both.status}`);

  // list reads the project's rows
  const list = await request("GET", `/api/v1/projects/${projectId}/planned-inspections`);
  check("list shows three rows", list.data?.length === 3, `${list.data?.length ?? 0} rows`);

  // delete one, delete it again
  const removed = await request(
    "DELETE",
    `/api/v1/planned-inspections/${plannedGvi.data.plannedInspectionId}`,
  );
  check("delete planned GVI", removed.status === 200, `status ${removed.status}`);
  const again = await request(
    "DELETE",
    `/api/v1/planned-inspections/${plannedGvi.data.plannedInspectionId}`,
  );
  check("delete again is 404", again.status === 404, `status ${again.status}`);

  // dropping the project cascades the planned rows away
  await request("DELETE", `/api/v1/projects/${projectId}`);
  const after = await request("GET", `/api/v1/projects/${projectId}/planned-inspections`);
  check(
    "project delete cascades planned rows",
    Array.isArray(after.data) && after.data.length === 0,
    `${after.data?.length ?? "?"} rows`,
  );

  console.log(failures === 0 ? "DRILL PASS" : `DRILL FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error("DRILL ERROR", err);
  process.exit(1);
});
