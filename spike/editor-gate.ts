// End-to-end gate: generate a report with the fixed template and confirm the
// editor's readers accept it. Reads nothing from the running container.
// flow: generateReport > readOoxmlPackage > openDocumentForExport

import { generateReport } from "../src/features/reports/report-generator";

const projectId = Number(process.argv[2] ?? 1);

const docx = await generateReport(projectId);
console.log(`generated ${docx.byteLength} bytes for project ${projectId}`);

await Bun.write("/tmp/gate-report.docx", docx);

const store = await import("@docx-editor.dev/core/store");
const exportMod = await import("@docx-editor.dev/core/export");

const read = store.readOoxmlPackage(new Uint8Array(docx));
console.log(
  read.ok ? "ACCEPT  store.readOoxmlPackage" : `REJECT  store.readOoxmlPackage: ${read.reason}`,
);

const opened = (
  exportMod as { openDocumentForExport: (b: Uint8Array) => { ok?: boolean; reason?: string } }
).openDocumentForExport(new Uint8Array(docx));
console.log(
  opened.ok
    ? "ACCEPT  export.openDocumentForExport"
    : `REJECT  export.openDocumentForExport: ${opened.reason}`,
);

process.exit(read.ok && opened.ok ? 0 : 1);
