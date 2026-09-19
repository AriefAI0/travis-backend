import { env } from "../../config/env";
import { minio } from "./clients";

// Mint a signed GET URL — playback/download links handed straight to the app
// (spec D10: long-lived by design on a local server). Same mechanism as the
// app's minio-mint-service, GET side only — segments are POSTed to us, never minted.
export function mintGetUrl(bucket: string, key: string): Promise<string> {
  return minio.presignedUrl("GET", bucket, key, env.PRESIGN_GET_TTL_SECONDS);
}

// Short window for a playback redirect. The playlist is fetched again for every
// segment, so each redirect mints its own URL and a leaked one dies in minutes.
export const PLAYBACK_REDIRECT_TTL_SECONDS = 300;

export function mintShortGetUrl(bucket: string, key: string): Promise<string> {
  return minio.presignedUrl("GET", bucket, key, PLAYBACK_REDIRECT_TTL_SECONDS);
}

// Direct-upload window for one evidence image. Short by design: the app PUTs
// immediately after create, so a long-lived write URL buys nothing and only
// widens the window in which a leaked URL can overwrite an object.
export const PRESIGN_PUT_TTL_SECONDS = 900;

// Mint a signed PUT URL — the app uploads image bytes straight to MinIO,
// same shape as recording parts. Write side only; never minted for reads.
export function mintPutUrl(bucket: string, key: string): Promise<string> {
  return minio.presignedUrl("PUT", bucket, key, PRESIGN_PUT_TTL_SECONDS);
}
