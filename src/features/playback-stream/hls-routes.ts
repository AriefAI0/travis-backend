// HLS transport: a scoped playback token covers the playlist and every child.
// A segment request answers 302 to a short presigned MinIO GET; no bytes proxied.

import { Hono } from "hono";
import type { Context } from "hono";

import type { DbOrTx } from "../../db/client";
import { corsAllowedOrigins, env } from "../../config/env";
import { notFound } from "../../lib/error";
import { mintShortGetUrl } from "../../lib/minio_storage/mint";
import { v2SegmentIndexName } from "../../lib/minio_storage/paths";
import { parseId } from "../../lib/parse";
import { findPlayableSegment, readPlaylistSource, buildPlaylist } from "./hls";
import { verifyPlaybackToken, type PlaybackScope } from "../../lib/playback_token";

// relative child URIs keep the playlist host-agnostic
const segmentUri = (token: string) => (sequence: number) =>
  `./${v2SegmentIndexName(sequence)}?t=${encodeURIComponent(token)}`;

// the renderer plays from another origin, so both hops answer CORS
const applyCors = (c: Context): void => {
  const origin = c.req.header("origin");
  if (origin === undefined || !corsAllowedOrigins.includes(origin)) return;
  c.header("access-control-allow-origin", origin);
  c.header("vary", "Origin");
};

// the browser preflights a cross-origin media GET
const preflight = (c: Context) => {
  applyCors(c);
  return c.body(null, 204, {
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "600",
  });
};

// Factory form: tests inject the test db.
export const hlsRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  const playlist = async (c: Context, kind: PlaybackScope["kind"]) => {
    const scope: PlaybackScope = { kind, id: parseId(c, "id") };
    const token = c.req.query("t") ?? "";
    verifyPlaybackToken(token, scope);

    const source = await readPlaylistSource(scope, database);
    applyCors(c);
    return c.body(buildPlaylist(source, segmentUri(token)), 200, {
      "content-type": "application/vnd.apple.mpegurl",
      "cache-control": "no-store",
    });
  };

  const segment = async (c: Context, kind: PlaybackScope["kind"]) => {
    const scope: PlaybackScope = { kind, id: parseId(c, "id") };
    const token = c.req.query("t") ?? "";
    verifyPlaybackToken(token, scope);

    // the leaf pattern guarantees digits; the guard keeps the type honest
    const sequence = Number((c.req.param("leaf") ?? "").replace(/\.ts$/, ""));
    if (!Number.isSafeInteger(sequence)) throw notFound("Segment");

    const stored = await findPlayableSegment(scope, sequence, database);
    if (!stored) throw notFound("Segment");

    applyCors(c);
    return c.redirect(await mintShortGetUrl(env.BUCKET_MEDIA, stored.objectKey), 302);
  };

  routes.get("/api/v2/hls/master/:id/index.m3u8", (c) => playlist(c, "master"));
  routes.get("/api/v2/hls/master/:id/:leaf{[0-9]+[.]ts}", (c) => segment(c, "master"));
  routes.get("/api/v2/hls/clip/:id/index.m3u8", (c) => playlist(c, "clip"));
  routes.get("/api/v2/hls/clip/:id/:leaf{[0-9]+[.]ts}", (c) => segment(c, "clip"));

  routes.options("/api/v2/hls/master/:id/index.m3u8", preflight);
  routes.options("/api/v2/hls/master/:id/:leaf{[0-9]+[.]ts}", preflight);
  routes.options("/api/v2/hls/clip/:id/index.m3u8", preflight);
  routes.options("/api/v2/hls/clip/:id/:leaf{[0-9]+[.]ts}", preflight);

  return routes;
};
