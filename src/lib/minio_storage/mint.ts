import { env } from "../../config/env";
import { minio } from "./clients";

// Mint a signed GET URL — playback/download links handed straight to the app
// (spec D10: long-lived by design on a local server). Same mechanism as the
// app's minio-mint-service, GET side only — segments are POSTed to us, never minted.
export function mintGetUrl(bucket: string, key: string): Promise<string> {
  return minio.presignedUrl("GET", bucket, key, env.PRESIGN_GET_TTL_SECONDS);
}
