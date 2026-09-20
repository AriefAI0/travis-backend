# travis-backend

Recording ingest server (Bun + Hono) for the travis app: receives sealed 2s
.TS segments, sews them into ONE multipart object per recording in MinIO, then
finalizes (ffmpeg stream-copy) into MKV + single-file HLS + thumbnail.
Stack: Bun + Hono + MinIO + sqlite (session tracker / job queue) + ffmpeg.

## Dev run (WSL)

```sh
bun install
cp .env.example .env        # then edit: endpoint/creds must match your MinIO
bun run dev                 # bun --watch src/index.ts, listens on PORT (8788)
```

Prereqs: a reachable MinIO (dev instance runs at `http://localhost:9002`) and
`ffmpeg` on PATH. Buckets are created automatically at boot. Tests:

```sh
bun test                    # spins up its own MinIO fixtures; needs ffmpeg
```

## Docker run

```sh
cp .env.example .env        # set MINIO_ACCESS_KEY / MINIO_SECRET_KEY
docker compose up --build
```

Compose starts `app` + `minio`. The app's `MINIO_ENDPOINT` is overridden to
`http://minio:9000` inside the compose network, so your `.env` endpoint value
is ignored there. Host ports: app `${PORT:-8788}`, MinIO API `9000`, MinIO
console `9001`. Both data volumes are named volumes (`app-data`, `minio-data`).

## Config

All configuration is env-only; `.env.example` documents every variable with
its default. Validated at boot by `src/config/env.ts` — the app fails fast on
a bad value.

## CORS for playback

The desktop renderer plays HLS from another origin, so both hops of a segment
request must answer CORS:

- The HLS routes (`/api/v2/hls/*`) echo `Access-Control-Allow-Origin` for
  origins listed in `CORS_ALLOWED_ORIGINS` (default
  `http://localhost:5173,null`; `null` is the packaged `file://` renderer).
- The MinIO media bucket needs a CORS rule of its own, because a segment
  request redirects the browser to a presigned MinIO URL. The `minio@8.0.7`
  client cannot set it, so apply it once per deployment:

```sh
mc alias set travis http://127.0.0.1:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
mc cors set travis/travis-media --config /dev/stdin <<'JSON'
{"CORSRules":[{"AllowedOrigins":["http://localhost:5173","null"],"AllowedMethods":["GET"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Length","Content-Range"],"MaxAgeSeconds":3600}]}
JSON
```

Verify the whole chain in the app: open a recording and press Play. A blocked
hop surfaces as a CORS error in the renderer console, not as a 4xx.

## Object layout

Every direct-media object lives in one bucket (`BUCKET_MEDIA`). A recording's
directory is frozen on its ingest row at admission, so a later project rename
never splits one recording across two trees.

```
travis-media/
  1-platform-north-2026-02-19/                 projectId + title slug + UTC date
    session-1-2026-02-19-1307/                 session-<displayNumber>-<date>-<HHMM>
      master-video/                            one master per session
        segments/0000000003.ts
        thumbnail.jpg                          written by the thumbnails job
        timeline/000012000.jpg                 filmstrip, 9-digit ms
      clips/
        455-anode-14-gvi/                      clipId + itemLabel slug + inspection
          segments/0000000001.ts
          evidence-img/
            55.png                             imageId; annotated twin 55-annotated.png
      results/                                 results with images but no clip
        231-anode-14/
          evidence-img/61.png
```

- The project folder carries the recording date. One project recorded on two
  days owns two top folders.
- Results images land under `clips/` when the result has a clip, and under
  `results/` when it does not. Both homes freeze per image row.
- Recordings predating this layout keep their old numeric directories
  (`<orgId>/<projectId>/<sessionId>/<YYYY>/<MM>/<DD>/<kind>/<targetId>`), written
  by a backfill onto `recording_ingest.key_prefix`. One minter family serves both.

## API surface

```
GET  /health                                  liveness
GET  /health/ready                            db+minio readiness
POST /api/minio_handler/sessions              create {kind, projectId, sessionId, recordingId | itemId, clipId}
GET  /api/minio_handler/sessions/:id          status (durableThrough, artifacts)
POST /api/minio_handler/sessions/:id/segments?index=N   upload one segment
POST /api/minio_handler/sessions/:id/heartbeat
POST /api/minio_handler/sessions/:id/stop     202 -> finalize job
```
## DB CLI command 
```
bun run db:generate # creates ./migrations/*.sql — REVIEW the SQL
bun run db:push # applies it to the travis database
```