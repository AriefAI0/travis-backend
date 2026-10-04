// Manual drill: restricted-access routes against the running container.
//
// Build and start the stack first:  docker compose up -d --build
// Then:  bun run tests/checks/restricted-access-drill.ts
//
// flow: seed a task chain over HTTP > mark a target RA > list > refuse the
// duplicate > unmark > drop the project and watch the cascade clean up

const BASE = process.env.DRILL_BASE_URL ?? "http://localhost:8788";

// the remark round-trip check reads this exact string back
const PROBE_REMARK = "structure blocks robot entry";

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
  const project = await request("POST", "/api/v1/projects", { title: "zz-ra-drill" });
  check("create project", project.status === 201, `status ${project.status}`);
  const projectId = project.data.projectId as number;

  const group = await request("POST", "/api/v1/task-groups", { projectId, code: "9R1" });
  check("create task group", group.status === 201, `status ${group.status}`);
  const taskCode = await request("POST", "/api/v1/task-codes", {
    taskGroupId: group.data.taskGroupId,
    code: "9R2",
  });
  check("create task code", taskCode.status === 201, `status ${taskCode.status}`);
  const description = await request("POST", "/api/v1/descriptions", {
    taskCodeId: taskCode.data.taskCodeId,
    label: "drill leg",
  });
  check("create description", description.status === 201, `status ${description.status}`);
  const descriptionId = description.data.descriptionId as number;
  const type = await request("POST", "/api/v1/types", { descriptionId, code: "9R3" });
  check("create type", type.status === 201, `status ${type.status}`);
  const partCode = await request("POST", "/api/v1/part-codes", {
    typeId: type.data.typeId,
    code: "9R4",
  });
  check("create part code", partCode.status === 201, `status ${partCode.status}`);

  // mark RA on the description with a remark, then on the part code
  const mark = await request("POST", "/api/v1/restricted-access", {
    projectId,
    descriptionId,
    remarks: PROBE_REMARK,
  });
  check("mark description RA", mark.status === 201, `status ${mark.status}`);
  check("row is a sessionless RA result", mark.data?.inspectionTypeCode === "RA" && mark.data?.sessionId === null && mark.data?.isRa === true);
  const markPart = await request("POST", "/api/v1/restricted-access", {
    projectId,
    partCodeId: partCode.data.partCodeId,
  });
  check("mark part code RA", markPart.status === 201, `status ${markPart.status}`);

  // the rules: duplicate refused, both targets refused, unknown target 404
  const duplicate = await request("POST", "/api/v1/restricted-access", {
    projectId,
    descriptionId,
  });
  check("duplicate RA refused", duplicate.status === 409, `status ${duplicate.status}`);
  const both = await request("POST", "/api/v1/restricted-access", {
    projectId,
    descriptionId,
    partCodeId: partCode.data.partCodeId,
  });
  check("both targets refused", both.status === 400, `status ${both.status}`);
  const unknown = await request("POST", "/api/v1/restricted-access", {
    projectId,
    descriptionId: 999999,
  });
  check("unknown target is 404", unknown.status === 404, `status ${unknown.status}`);

  // list reads the project's marks
  const list = await request("GET", `/api/v1/projects/${projectId}/restricted-access`);
  check("list shows two marks", list.data?.length === 2, `${list.data?.length ?? 0} marks`);
  check(
    "list carries the remark",
    list.data?.some((row: any) => row.remarks === PROBE_REMARK),
  );

  // unmark one, unmark it again
  const unmarked = await request("DELETE", `/api/v1/restricted-access/${mark.data.resultId}`);
  check("unmark description RA", unmarked.status === 200, `status ${unmarked.status}`);
  const again = await request("DELETE", `/api/v1/restricted-access/${mark.data.resultId}`);
  check("unmark again is 404", again.status === 404, `status ${again.status}`);

  // dropping the project cascades the marks away
  await request("DELETE", `/api/v1/projects/${projectId}`);
  const after = await request("GET", `/api/v1/projects/${projectId}/restricted-access`);
  check(
    "project delete cascades RA rows",
    Array.isArray(after.data) && after.data.length === 0,
    `${after.data?.length ?? "?"} marks`,
  );

  console.log(failures === 0 ? "DRILL PASS" : `DRILL FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error("DRILL ERROR", err);
  process.exit(1);
});
