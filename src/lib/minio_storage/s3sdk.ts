import { minio } from "./clients";

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface RemotePart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface S3Parts {
  initiate(bucket: string, key: string): Promise<string>;
  uploadPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string>;
  listParts(bucket: string, key: string, uploadId: string): Promise<RemotePart[]>;
  complete(bucket: string, key: string, uploadId: string, parts: CompletedPart[]): Promise<void>;
  abort(bucket: string, key: string, uploadId: string): Promise<void>;
  listUploads(bucket: string): Promise<{ uploadId: string; key: string }[]>;
}

// The minio SDK has no public API for manual multipart ops; presignedUrl with
// query params (proved live in .planning/spikes/spike-minio-parts.ts) is the transport.
async function presign(method: string, bucket: string, key: string, params: Record<string, string>) {
  const client = minio as unknown as {
    presignedUrl(method: string, bucket: string, key: string, expiry: number, params: Record<string, string>): Promise<string>;
  };
  return client.presignedUrl(method, bucket, key, 300, params);
}

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<(?:[a-z]+:)?${name}>([^<]+)<`));
  return match?.[1] ?? null;
}

function partBlocks(xml: string): string[] {
  return xml.match(/<(?:[a-z]+:)?Part>[\s\S]*?<\/(?:[a-z]+:)?Part>/g) ?? [];
}

function uploadBlocks(xml: string): string[] {
  return xml.match(/<(?:[a-z]+:)?Upload>[\s\S]*?<\/(?:[a-z]+:)?Upload>/g) ?? [];
}

async function assertOk(res: Response, what: string) {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export const s3parts: S3Parts = {
  async initiate(bucket, key) {
    const url = await presign("POST", bucket, key, { uploads: "" });
    const res = await fetch(url, { method: "POST" });
    await assertOk(res, "initiate multipart");
    const uploadId = tag(await res.text(), "UploadId");
    if (!uploadId) throw new Error("initiate multipart: no UploadId in response");
    return uploadId;
  },

  async uploadPart(bucket, key, uploadId, partNumber, body) {
    const url = await presign("PUT", bucket, key, { partNumber: String(partNumber), uploadId });
    const res = await fetch(url, { method: "PUT", body });
    const etag = res.headers.get("etag");
    if (!res.ok || !etag) throw new Error(`uploadPart ${partNumber}: ${res.status} (etag ${etag ?? "missing"})`);
    return etag;
  },

  async listParts(bucket, key, uploadId) {
    const url = await presign("GET", bucket, key, { uploadId });
    const res = await fetch(url);
    await assertOk(res, "listParts");
    const xml = await res.text();
    return partBlocks(xml).map((block) => ({
      partNumber: Number(tag(block, "PartNumber")),
      etag: tag(block, "ETag") ?? "",
      sizeBytes: Number(tag(block, "Size") ?? 0),
    }));
  },

  async complete(bucket, key, uploadId, parts) {
    const body = `<CompleteMultipartUpload>${parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join("")}</CompleteMultipartUpload>`;
    const url = await presign("POST", bucket, key, { uploadId });
    const res = await fetch(url, { method: "POST", body });
    await assertOk(res, "complete multipart");
  },

  async abort(bucket, key, uploadId) {
    const url = await presign("DELETE", bucket, key, { uploadId });
    const res = await fetch(url, { method: "DELETE" });
    await assertOk(res, "abort multipart");
  },

  async listUploads(bucket) {
    const url = await presign("GET", bucket, "", { uploads: "" });
    const res = await fetch(url);
    await assertOk(res, "listMultipartUploads");
    const xml = await res.text();
    return uploadBlocks(xml).map((block) => ({
      uploadId: tag(block, "UploadId") ?? "",
      key: tag(block, "Key") ?? "",
    }));
  },
};
