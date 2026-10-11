// The report editor page.
//
// It shows one stored report and writes it back through the editor's own
// File > Save. The packaged chrome is the whole interface, so this file adds no
// UI of its own: only a load path, a save path, and the text for either failing.
// flow: fetch name + bytes > mount editor > File > Save > PUT bytes back

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DocxEditor, type DocxEditorRef } from "@docx-editor.dev/react";
import "@docx-editor.dev/react/styles.css";

const reportId = location.pathname.split("/").filter(Boolean).pop() ?? "";
const metaUrl = `/api/v1/reports/${reportId}`;
const docxUrl = `${metaUrl}/docx`;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// error responses are problem+json, so the caller-facing text is `title`
const readProblem = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as { title?: string } | null;
  return body?.title ?? `${response.status} ${response.statusText}`;
};

const problem = (error: unknown) => (error instanceof Error ? error.message : String(error));

const Editor = () => {
  const editor = useRef<DocxEditorRef>(null);
  const [docx, setDocx] = useState<Uint8Array | null>(null);
  const [name, setName] = useState("Report");
  const [problemText, setProblemText] = useState("Loading the report…");
  // the version this page loaded; the server refuses a save at any other one
  const version = useRef<number | null>(null);

  // flow: read name and bytes together > mount
  useEffect(() => {
    void (async () => {
      try {
        const [meta, bytes] = await Promise.all([fetch(metaUrl), fetch(docxUrl)]);
        if (!meta.ok) throw new Error(await readProblem(meta));
        if (!bytes.ok) throw new Error(await readProblem(bytes));

        const report = (await meta.json()) as { data: { name: string; version: number } };
        setName(report.data.name);
        document.title = report.data.name;
        version.current = report.data.version;

        setDocx(new Uint8Array(await bytes.arrayBuffer()));
      } catch (error) {
        setProblemText(problem(error));
      }
    })();
  }, []);

  // The editor's File > Save. A failed write must be loud: the alternative is
  // a user believing edits are stored when they are not.
  //
  // A 409 means the report moved on — a refresh landed, or another tab saved —
  // and this copy is stale. The server writes nothing, so the user reloads
  // instead of overwriting whatever came after them.
  const save = async () => {
    const current = await editor.current?.save();
    if (!current) return;

    try {
      const response = await fetch(docxUrl, {
        method: "PUT",
        headers: { "Content-Type": DOCX_MIME, "x-report-version": String(version.current ?? "") },
        body: new Uint8Array(current),
      });
      if (!response.ok) throw new Error(await readProblem(response));

      const written = (await response.json()) as { data: { version: number } };
      version.current = written.data.version;
    } catch (error) {
      alert(`Could not save the report: ${problem(error)}`);
    }
  };

  if (!docx) {
    // the load and failure path only — no styling
    return <p>{problemText}</p>;
  }

  return (
    <DocxEditor
      ref={editor}
      document={docx}
      mode="edit"
      chrome
      title={name}
      onSave={save}
      // PDF and Print route through docx-to-pdf, which is Node-only and paid,
      // and no exporter is wired for Markdown. A row that errors is worse than
      // an absent row, so all three come out of File.
      menu={{
        children: (
          <DocxEditor.Menu.File>
            <DocxEditor.Menu.ExportPdf hidden />
            <DocxEditor.Menu.Print hidden />
            <DocxEditor.Menu.ExportMarkdown hidden />
          </DocxEditor.Menu.File>
        ),
      }}
      // no `fonts` config on purpose: layout uses the fixed-width measurer, so
      // the HarfBuzz wasm is never fetched
      onFontError={(error) => console.warn("report editor font error:", error)}
    />
  );
};

createRoot(document.getElementById("root")!).render(<Editor />);
