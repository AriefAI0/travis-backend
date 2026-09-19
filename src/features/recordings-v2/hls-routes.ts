// HLS transport: a scoped playback token covers the playlist and every child.
// A segment request answers 302 to a short presigned MinIO GET; no bytes proxied.

import { Hono } from "hono";
import type { Context } from "hono";

import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { notFound } from "../../lib/error";
import { mintShortGetUrl } from "../../lib/minio_storage/mint";
import { v2SegmentIndexName } from "../../lib/minio_storage/paths";
import { parseId } from "../../lib/parse";
import { findPlayableSegment, readPlaylistSource, buildPlaylist } from "./hls";
import { verifyPlaybackToken, type PlaybackScope } from "./playback-token";

// relative child URIs keep the playlist host-agnostic
const segmentUri = (token: string) => (sequence: number) =>
  `./${v2SegmentIndexName(sequence)}?t=${encodeURIComponent(token)}`;

// Factory form: tests inject the test db.
export const hlsRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  const playlist = async (c: Context, kind: PlaybackScope["kind"]) => {
    const scope: PlaybackScope = { kind, id: parseId(c, "id") };
    const token = c.req.query("t") ?? "";
    verifyPlaybackToken(token, scope);

    const source = await readPlaylistSource(scope, database);
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

    return c.redirect(await mintShortGetUrl(env.BUCKET_MEDIA, stored.objectKey), 302);
  };

  routes.get("/api/v2/hls/master/:id/index.m3u8", (c) => playlist(c, "master"));
  routes.get("/api/v2/hls/master/:id/:leaf{[0-9]+[.]ts}", (c) => segment(c, "master"));
  routes.get("/api/v2/hls/clip/:id/index.m3u8", (c) => playlist(c, "clip"));
  routes.get("/api/v2/hls/clip/:id/:leaf{[0-9]+[.]ts}", (c) => segment(c, "clip"));

  return routes;
};
