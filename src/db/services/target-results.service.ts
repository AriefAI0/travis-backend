// Sidebar: results grouped by session for a description or part-code target.
// Same batched evidence reads as the item sidebar.
import type { DbOrTx } from "../client";
import {
  listResultRecordsByDescriptionId,
  listResultRecordsByPartCodeId,
  listResultRecordsByTargetIds,
} from "../repositories/result.repository";
import { listSessionsByIds } from "./session.service";
import { listVideoClipPlaybackByResultIds } from "./video.service";
import { listResultImageSummariesByResultIds, mintTimelineThumbnailUrl } from "./result-media.service";
import { listPlayableClipIds, playbackUrl } from "./recording-playback.service";

export type TargetResultsQuery = {
  descriptionId?: number;
  partCodeId?: number;
};

export type TargetResultsBatchQuery = {
  descriptionIds: number[];
  partCodeIds: number[];
};

type ResultRow = Awaited<ReturnType<typeof listResultRecordsByDescriptionId>>[number];

const toIsoString = (value: Date) => value.toISOString();

// one evidence pass for a whole result set; the maps keep the loop query-free
const loadEvidenceLookups = async (results: ResultRow[], database?: DbOrTx) => {
  const sessionIds = [...new Set(results.map((row) => row.sessionId))];
  const resultIds = results.map((row) => row.resultId);

  const [sessionRecords, imagesByResultId, clipsByResultId] = await Promise.all([
    listSessionsByIds(sessionIds, database),
    listResultImageSummariesByResultIds(resultIds, database),
    listVideoClipPlaybackByResultIds(resultIds, database),
  ]);

  const playableClipIds = await listPlayableClipIds(
    [...clipsByResultId.values()].flat().map((clip) => clip.clipId),
    database,
  );

  return {
    sessionById: new Map(sessionRecords.map((session) => [session.sessionId, session])),
    imagesByResultId,
    clipsByResultId,
    playableClipIds,
  };
};

type EvidenceLookups = Awaited<ReturnType<typeof loadEvidenceLookups>>;

// flow: rows + lookups > group by session > sidebar sessions
const buildSessions = async (results: ResultRow[], lookups: EvidenceLookups) => {
  const { sessionById, imagesByResultId, clipsByResultId, playableClipIds } = lookups;

  const resultsBySessionId = new Map<number, ResultRow[]>();
  for (const row of results) {
    const bucket = resultsBySessionId.get(row.sessionId) ?? [];
    bucket.push(row);
    resultsBySessionId.set(row.sessionId, bucket);
  }

  return Promise.all(
    [...resultsBySessionId.keys()]
      .sort((a, b) => a - b)
      .map(async (sessionId) => {
        const sessionRecord = sessionById.get(sessionId);
        const rows = resultsBySessionId.get(sessionId) ?? [];

        return {
          sessionId,
          sessionName: sessionRecord?.name ?? null,
          sessionDisplayNumber: sessionRecord?.displayNumber ?? null,
          results: await Promise.all(
            rows.map(async (row) => {
              const entryImages = imagesByResultId.get(row.resultId) ?? [];
              return {
                resultId: row.resultId,
                inspectionTypeCode: row.inspectionTypeCode,
                inspectionTypeName: row.inspectionTypeCode,
                layer: row.layer,
                displayNumber: row.displayNumber,
                masterStartMs: row.masterStartMs,
                masterEndMs: row.masterEndMs,
                remarks: row.remarks,
                createdAt: toIsoString(row.createdAt),
                updatedAt: toIsoString(row.updatedAt),
                images: entryImages,
                posterUrl: entryImages[0]?.url ?? null,
                clips: await Promise.all(
                  (clipsByResultId.get(row.resultId) ?? []).map(async (clipPlayback) => ({
                    clipId: clipPlayback.clipId,
                    resultId: clipPlayback.resultId,
                    startOffsetMs: clipPlayback.startOffsetMs,
                    endOffsetMs: clipPlayback.endOffsetMs,
                    durationMs: clipPlayback.durationMs,
                    startEpochMs: clipPlayback.startEpochMs,
                    endEpochMs: clipPlayback.endEpochMs,
                    videoUrl: playableClipIds.has(clipPlayback.clipId)
                      ? playbackUrl({ kind: "clip", id: clipPlayback.clipId })
                      : null,
                    thumbnailUrl: await mintTimelineThumbnailUrl(clipPlayback.thumbnailKey),
                  })),
                ),
              };
            }),
          ),
        };
      }),
  );
};

// flow: results by target > lookups > group by session
export const getTargetResultSidebar = async (
  query: TargetResultsQuery,
  database?: DbOrTx,
) => {
  const results = query.descriptionId
    ? await listResultRecordsByDescriptionId(query.descriptionId, database)
    : query.partCodeId
      ? await listResultRecordsByPartCodeId(query.partCodeId, database)
      : [];

  return {
    target: {
      descriptionId: query.descriptionId ?? null,
      partCodeId: query.partCodeId ?? null,
    },
    sessions: await buildSessions(results, await loadEvidenceLookups(results, database)),
  };
};

// flow: results by target ids > one lookup pass > one sidebar per target
// keys match the app's node keys: "description:<id>" / "partCode:<id>"
export const getTargetResultsBatch = async (
  query: TargetResultsBatchQuery,
  database?: DbOrTx,
) => {
  const results = await listResultRecordsByTargetIds(
    query.descriptionIds,
    query.partCodeIds,
    database,
  );

  // every requested target gets an entry, empty when it has no results
  const targets = [
    ...query.descriptionIds.map((descriptionId) => ({
      key: `description:${descriptionId}`,
      target: { descriptionId, partCodeId: null },
      rows: [] as ResultRow[],
    })),
    ...query.partCodeIds.map((partCodeId) => ({
      key: `partCode:${partCodeId}`,
      target: { descriptionId: null, partCodeId },
      rows: [] as ResultRow[],
    })),
  ];
  const targetByKey = new Map(targets.map((entry) => [entry.key, entry]));

  for (const row of results) {
    const key =
      row.descriptionId !== null ? `description:${row.descriptionId}` : `partCode:${row.partCodeId}`;
    targetByKey.get(key)?.rows.push(row);
  }

  const lookups = await loadEvidenceLookups(results, database);

  return Object.fromEntries(
    await Promise.all(
      targets.map(async ({ key, target, rows }) => [
        key,
        { target, sessions: await buildSessions(rows, lookups) },
      ]),
    ),
  );
};
