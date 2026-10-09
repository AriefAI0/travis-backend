// Browser entry for the report page. The page fetches the bytes (a saved copy
// or a fresh render) and calls mount(); this module owns editing and saving.
//
// Loaded as a module only once a report exists, so the idle page never pays for
// the 3 MB bundle. A failed import leaves the page's generate dialog in place.
//
// flow: mount(bytes) > editor on the host > save / regenerate

import { createDocxEditor, type DocxEditorInstance } from "@docx-editor.dev/core";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// element lookup that throws rather than returning null, so a missing node
// surfaces as a caught error instead of a null deref later
const must = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
};

const readProblem = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { title?: string } | null;
  return body?.title ?? `${response.status} ${response.statusText}`;
};

let editor: DocxEditorInstance | null = null;

// Mount the editor over already-fetched bytes and wire the toolbar.
// flow: create editor > wire save/regenerate > dirty tracking
export const mount = (bytes: Uint8Array, projectId: string): void => {
  const status = must<HTMLElement>("[data-report-status]");
  const saveButton = must<HTMLButtonElement>("[data-report-save]");
  const regenerateButton = must<HTMLButtonElement>("[data-report-regenerate]");
  const downloadLink = must<HTMLAnchorElement>("[data-report-download]");

  // the editor is long-lived; a remount (regenerate) should not leak listeners
  editor?.destroy();

  editor = createDocxEditor({
    container: must<HTMLElement>("[data-report-editor]"),
    document: bytes,
    mode: "edit",
    // no `fonts` config on purpose: layout uses the fixed-width measurer, so the
    // HarfBuzz wasm is tree-shaken out of this bundle and never fetched
    onFontError: (error: unknown) => {
      console.warn("report editor font error:", error);
    },
  });

  let dirty = false;
  const setDirty = (value: boolean): void => {
    dirty = value;
    saveButton.disabled = !value;
  };

  editor.on?.("change", () => {
    if (!dirty) setDirty(true);
    status.textContent = "Unsaved changes";
  });

  // closing the tab mid-edit is the one loss no dialog can prevent
  window.addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });

  // save() rejects on write refusals; keep the editor mounted and say so
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    status.textContent = "Saving…";
    try {
      const saved = await editor!.save();
      const response = await fetch(`/api/v1/projects/${projectId}/report/saved`, {
        method: "PUT",
        headers: { "Content-Type": DOCX_MIME },
        body: new Uint8Array(saved),
      });
      if (!response.ok) throw new Error(await readProblem(response));
      setDirty(false);
      status.textContent = "Saved";
    } catch (error) {
      status.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
      saveButton.disabled = false;
    }
  });

  // Regenerate rebuilds from current data and replaces the stored report, so
  // reopening the link shows what this session ended with.
  regenerateButton.addEventListener("click", async () => {
    if (dirty && !confirm("Replace the report with a fresh render? Unsaved changes will be lost.")) {
      return;
    }
    status.textContent = "Rebuilding…";
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/report/docx`);
      if (!response.ok) throw new Error(await readProblem(response));
      const fresh = new Uint8Array(await response.arrayBuffer());

      // store first: the editor should never show something the server lacks
      const stored = await fetch(`/api/v1/projects/${projectId}/report/saved`, {
        method: "PUT",
        headers: { "Content-Type": DOCX_MIME },
        body: fresh,
      });
      if (!stored.ok) throw new Error(await readProblem(stored));

      editor!.load(fresh);
      setDirty(false);
      status.textContent = "Regenerated";
    } catch (error) {
      status.textContent = `Could not regenerate: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  // Download always hands back what is on screen, not the stored copy
  downloadLink.addEventListener("click", async (event) => {
    event.preventDefault();
    const current = await editor!.save();
    const url = URL.createObjectURL(new Blob([current], { type: DOCX_MIME }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `report-${projectId}.docx`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  setDirty(false);
  status.textContent = "";
};
