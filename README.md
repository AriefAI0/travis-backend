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
request must answer CORS. Only the backend half needs configuring:

- **Backend route** (`/api/v2/hls/*`): echoes `Access-Control-Allow-Origin` for
  origins listed in `CORS_ALLOWED_ORIGINS` (default
  `http://localhost:5173,null`; `null` is the packaged `file://` renderer).
- **MinIO hop**: a segment request redirects the browser to a presigned MinIO
  URL, and MinIO answers CORS for every origin by default. Nothing to set up.

MinIO has no per-bucket CORS rule: it does not implement the S3 CORS API
(`PutBucketCors` answers "not implemented"), and `mc cors set` fails against it
for that reason. CORS is a server-wide setting instead:

```
MINIO_API_CORS_ALLOW_ORIGIN   default "*"; comma-separated origins to restrict
```

Leave it at the default for development. Restricting it is a hardening step for
a deployment where the media host is reachable from a browser you do not
control, and it must then include the renderer's origin (plus `null` for the
packaged `file://` build) or playback breaks at the segment hop.

To confirm the chain by hand, ask MinIO for a header on any origin:

```sh
curl -s -i -H 'Origin: http://localhost:5173' http://localhost:9002/travis-media/anything | grep -i access-control
```

In the app, open a recording and press Play. A blocked hop surfaces as a CORS
error in the renderer console, not as a 4xx.

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
## Schema changes and deploys

Schema changes ship as SQL files, decided at dev time. Never run
`drizzle-kit push` against production — it prompts on live data and dies
without a TTY.

Schema change, on your dev machine:

```sh
bun run db:generate   # writes migrations/NNNN_*.sql from src/db/schema.ts
```

- Read the SQL before committing. When it constrains populated tables, put the
  dedupe or backfill statements in front of the constraint, in the same file.
- Commit `schema.ts` and the SQL together. A schema change without its SQL
  file deploys nothing.
- For risky changes, test on a copy first: `pg_dump` prod, restore, run
  `bun run db:migrate` against the copy.

Deploy to production — nothing else needed on the server:

```sh
docker compose up -d --build    # or update the stack in Portainer
```

The `migrate` container applies pending SQL headless in one transaction, then
the app boots. A failed migration rolls back fully and the container exits
non-zero, so the app stays down instead of running on a half-applied schema.