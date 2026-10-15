// The report editor page, served by the backend so the serve can set the
// editor's cookie. Bun's own HTML route cannot carry a Set-Cookie, so the page
// is built once and served from here.
//
// flow: build once > GET /editor/reports/:reportId > set the scoped cookie >
// the editor's same-origin fetch carries it
//
// The cookie is path-scoped to /api/v1/reports/<id>, so a tab editing one
// report never holds a credential for another.

import { Hono } from "hono";

import { setCookie } from "hono/cookie";
import { isUuid } from "../../lib/parse";
import {
  mintReportEditorToken,
  REPORT_EDITOR_COOKIE,
  REPORT_EDITOR_TTL_SECONDS,
} from "../../lib/report_editor_token";

type EditorBundle = {
  html: string;
  assets: Map<string, { body: Uint8Array; contentType: string }>;
};

// The page's asset links are relative to /editor/assets, where they are served
// from memory. Built once: the editor's bundle is 6 MB, and a rebuild per
// request would cost more than the page is worth.
let bundlePromise: Promise<EditorBundle> | null = null;

const EDITED_HTML_REF = /(src|href)="\.\/(chunk-[^"]+)"/g;

const build = async (): Promise<EditorBundle> => {
  const built = await Bun.build({
    entrypoints: [new URL("./editor.html", import.meta.url).pathname],
    target: "browser",
    minify: true,
  });
  if (!built.success) {
    throw new Error(`editor bundle failed: ${built.logs.map(String).join("; ")}`);
  }

  const assets = new Map<string, { body: Uint8Array; contentType: string }>();
  let html = "";

  for (const artifact of built.outputs) {
    const name = artifact.path.split("/").pop()!;
    if (artifact.type.startsWith("text/html")) {
      html = (await artifact.text()).replace(EDITED_HTML_REF, '$1="/editor/assets/$2"');
      continue;
    }
    assets.set(name, {
      body: new Uint8Array(await artifact.arrayBuffer()),
      contentType: artifact.type,
    });
  }

  return { html, assets };
};

const bundle = () => (bundlePromise ??= build());

export const editorRoutes = () => {
  const routes = new Hono();

  routes.get("/editor/assets/:name", async (c) => {
    const asset = (await bundle()).assets.get(c.req.param("name"));
    if (!asset) return c.notFound();

    return new Response(asset.body, {
      headers: {
        "content-type": asset.contentType,
        // content-addressed: the name changes when the bytes do
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  // flow: reportId > serve the page + set the report-scoped cookie
  routes.get("/editor/reports/:reportId", async (c) => {
    const reportId = c.req.param("reportId");

    // A non-uuid cannot name a report, so it gets the page and no cookie.
    if (isUuid(reportId)) {
      setCookie(c, REPORT_EDITOR_COOKIE, mintReportEditorToken(reportId), {
        httpOnly: true,
        sameSite: "Lax",
        path: `/api/v1/reports/${reportId}`,
        maxAge: REPORT_EDITOR_TTL_SECONDS,
      });
    }

    return c.html((await bundle()).html);
  });

  return routes;
};
