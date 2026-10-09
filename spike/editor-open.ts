// Which entry points accept our generated report? A rejection here means the
// editor cannot open it, so the whole editor plan stops at this gate.
// flow: read bytes > try each opener > report accept/reject

const target = process.argv[2] ?? "/tmp/spike-report.docx";
const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());

const attempt = async (label: string, fn: () => unknown): Promise<void> => {
  try {
    const result = (await fn()) as { ok?: boolean; reason?: string; detail?: string };
    if (result && typeof result === "object" && "ok" in result) {
      console.log(
        result.ok
          ? `ACCEPT  ${label}`
          : `REJECT  ${label}: ${result.reason} ${result.detail ?? ""}`,
      );
      return;
    }
    console.log(`ACCEPT  ${label} (non-result return)`);
  } catch (error) {
    console.log(`THROW   ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const store = await import("@docx-editor.dev/core/store");
const exportMod = await import("@docx-editor.dev/core/export");
const root = await import("@docx-editor.dev/core");

console.log(`input: ${target} (${bytes.byteLength} bytes)\n`);

await attempt("store.readOoxmlPackage", () => store.readOoxmlPackage(bytes));
await attempt("store.readZip", () => store.readZip(bytes));
await attempt("openHeadlessDocument", () => root.openHeadlessDocument(bytes));

const openForExport = (exportMod as { openDocumentForExport?: (b: Uint8Array) => unknown })
  .openDocumentForExport;
if (openForExport) {
  await attempt("export.openDocumentForExport", () => openForExport(bytes));
}

const openFontBacked = (
  exportMod as { openFontBackedDocumentForExport?: (...a: unknown[]) => unknown }
).openFontBackedDocumentForExport;
if (openFontBacked) {
  await attempt("export.openFontBackedDocumentForExport", () => openFontBacked(bytes));
}
