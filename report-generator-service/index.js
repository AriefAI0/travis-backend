// Standalone report renderer, called by travis-backend over HTTP.
// The app owns the data and the template; this service only fetches the
// evidence images by key and fills the template.
// flow: POST /generate > prefetch images > render > docx bytes
import http from "node:http";
import { Client } from "minio";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import ImageModule from "docxtemplater-image-module-free";

/* ---------- config ---------- */

const PORT = Number(process.env.PORT ?? 3100);
const BUCKET_MEDIA = process.env.BUCKET_MEDIA ?? "travis-media";

// A payload is the report data plus one base64 template, so this is generous.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Fixed cell size in pixels; the image module takes no other unit.
const IMAGE_SIZE = [200, 150];

// 1x1 transparent PNG. A section with no image still gets a valid picture, so
// the image module never throws on an empty tag value.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// The image module's resolve() breaks on falsy tag values under renderAsync,
// so the app sends this sentinel instead of an empty string.
const NO_IMAGE = "none";

if (!process.env.MINIO_ENDPOINT) {
  console.error("MINIO_ENDPOINT is required");
  process.exit(1);
}

// Mirrors the app's lib/minio_storage/clients.ts: the endpoint is a URL.
const buildMinioClient = () => {
  const url = new URL(process.env.MINIO_ENDPOINT);
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    // pin the region so reads stay offline
    region: "us-east-1",
  });
};

const minio = buildMinioClient();

/* ---------- rendering ---------- */

const drainStream = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

// One image by object key. A miss is not fatal: a report with one blank
// picture beats no report at all.
const loadImage = async (objectKey) => {
  if (!objectKey) {
    return TRANSPARENT_PNG;
  }

  try {
    return await drainStream(await minio.getObject(BUCKET_MEDIA, objectKey));
  } catch {
    return TRANSPARENT_PNG;
  }
};

// Every distinct image key the template will ask for.
const collectImageKeys = (data) => {
  const keys = new Set();
  for (const item of data.items ?? []) {
    for (const section of item.sections ?? []) {
      // the sentinel is not a real object and never gets fetched
      if (section.image && section.image !== NO_IMAGE) keys.add(section.image);
    }
  }
  return keys;
};

// Fetch every image once, in parallel, so rendering never waits on MinIO.
const prefetchImages = async (keys) => {
  const entries = await Promise.all(keys.map(async (key) => [key, await loadImage(key)]));
  return new Map(entries);
};

// Pull docxtemplater's real error list out of its wrapper error.
const describeTemplateError = (err) => {
  const errors = err?.properties?.errors;
  if (errors?.length) {
    return errors.map((entry) => entry.message ?? String(entry)).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
};

// Fill a template with the app's gathered data.
// flow: image keys > parallel fetch > wire image module > render
const renderReport = async (template, data) => {
  const imageMap = await prefetchImages([...collectImageKeys(data)]);

  const imageModule = new ImageModule({
    centered: false,
    fileType: "docx",
    getImage: async (key) => imageMap.get(key) ?? TRANSPARENT_PNG,
    getSize: () => IMAGE_SIZE,
  });

  const doc = new Docxtemplater(new PizZip(template), {
    paragraphLoop: true,
    linebreaks: true,
    modules: [imageModule],
  });

  await doc.renderAsync(data);
  return doc.getZip().generate({ type: "nodebuffer" });
};

/* ---------- http ---------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

// Body: { data: <report template data>, template: <base64 docx> }
const handleGenerate = async (req, res) => {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "body must be JSON");
  }

  if (typeof body?.template !== "string" || body.template.length === 0) {
    throw new HttpError(400, "template must be a base64 string");
  }
  if (body.data === null || typeof body.data !== "object") {
    throw new HttpError(400, "data must be an object");
  }

  const docx = await renderReport(Buffer.from(body.template, "base64"), body.data);

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": docx.length,
  });
  res.end(docx);
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/generate") {
      return await handleGenerate(req, res);
    }
    return sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return sendJson(res, status, {
      error: status === 500 ? "template_error" : "bad_request",
      message: describeTemplateError(err),
    });
  }
});

server.listen(PORT, () => {
  console.log(`report generator listening on :${PORT}`);
});
