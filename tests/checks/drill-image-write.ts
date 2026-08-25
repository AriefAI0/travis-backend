// live drill: evidence image write end to end against the running server
// flow: create ticket > PUT bytes > read back > poster rule > annotated > delete
import { listOpenInspectionsBySessionId } from "../../src/db/services/inspection.service";

const BASE = "http://localhost:8788";

// 1x1 PNGs: red raw snip, blue annotated twin
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+LwM6AAAAAElFTkSuQmCC",
  "base64",
);
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const line = (label: string, value: unknown) =>
  console.log(label, typeof value === "string" ? value : JSON.stringify(value));

// find an open result with no clip on session 8
const open = await listOpenInspectionsBySessionId(8);
const bare = open.find((o) => o.clip === null);
if (!bare) throw new Error("no clip-less open result on session 8 — seed one first");
line("RESULT", `${bare.resultId} (${bare.inspectionTypeCode}), clip: null`);

type Ticket = { imageId: number; storageStem: string; url: string; variant: string };

// 1) create the raw ticket on a result with NO clip
const create = await fetch(`${BASE}/api/v1/results/${bare.resultId}/images`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ contentType: "image/png" }),
});
const ticket = ((await create.json()) as { data: Ticket }).data;
line("CREATE", `${create.status} imageId=${ticket.imageId} variant=${ticket.variant}`);
line("STEM", ticket.storageStem);
line("PUT-URL", ticket.url.slice(0, 110) + "...");

// 2) PUT the real PNG straight to MinIO
const put = await fetch(ticket.url, { method: "PUT", body: RED_PNG });
line("PUT-BYTES", `${put.status} (${RED_PNG.length} bytes)`);

// 3) read it back through the minted GET from the evidence read
const evidence = await (
  await fetch(`${BASE}/api/v1/results/${bare.resultId}/evidence`)
).json();
const getUrl = evidence.data.images[0].url;
const back = await fetch(getUrl);
const bytes = Buffer.from(await back.arrayBuffer());
line("READ-BACK", `${back.status} bytes-match=${bytes.equals(RED_PNG)}`);

// 4) second snip: poster must stay the FIRST image
const second = await fetch(`${BASE}/api/v1/results/${bare.resultId}/images`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ contentType: "image/png" }),
});
const ticket2 = ((await second.json()) as { data: Ticket }).data;
await fetch(ticket2.url, { method: "PUT", body: RED_PNG });
const sidebar = await (
  await fetch(`${BASE}/api/v1/items/${bare.itemId}/results`)
).json();
const entry = sidebar.data.sessions[0].results.find(
  (r: { resultId: number }) => r.resultId === bare.resultId,
);
line("POSTER-FIRST", `images=${entry.images.length} poster-is-first=${entry.posterUrl === entry.images[0].url}`);

// 5) annotated twin on the FIRST image
const anno = await fetch(`${BASE}/api/v1/images/${ticket.imageId}/annotated`, {
  method: "POST",
});
const annoTicket = ((await anno.json()) as { data: Ticket }).data;
const annoPut = await fetch(annoTicket.url, { method: "PUT", body: BLUE_PNG });
line("ANNOTATED", `${anno.status} PUT=${annoPut.status}`);
const sidebar2 = await (
  await fetch(`${BASE}/api/v1/items/${bare.itemId}/results`)
).json();
const entry2 = sidebar2.data.sessions[0].results.find(
  (r: { resultId: number }) => r.resultId === bare.resultId,
);
const flips = entry2.images[0].url.includes("_annotated.png");
line("ANNOTATED-FLIP", `url-flipped=${flips} poster-follows=${entry2.posterUrl === entry2.images[0].url}`);

// 6) delete the second image; repeat must 404
const del = await fetch(`${BASE}/api/v1/images/${ticket2.imageId}`, { method: "DELETE" });
const del2 = await fetch(`${BASE}/api/v1/images/${ticket2.imageId}`, { method: "DELETE" });
line("DELETE", `first=${del.status} repeat=${del2.status}`);
