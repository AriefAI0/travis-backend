// Sidebar: results grouped by session for a description or part-code target.
// Same batched evidence reads as the item sidebar.
import type { DbOrTx } from "../client";
import {
  listResultRecordsByDescriptionId,
  listResultRecordsByPartCodeId,
} from "../repositories/result.repository";
import { listSessionsByIds } from "./session.service";
import { listVideoClipPlaybackByResultIds } from "./video.service";
import { listResultImageSummariesByResultIds, mintTimelineThumbnailUrl } from "./result-media.service";
import { listPlayableClipIds, playbackUrl } from "./recording-playback.service";

export type TargetResultsQuery = {
  descriptionId?: number;
  partCodeId?: number;
};

const toIsoString = (value: Date) => value.toISOString();

// flow: results by target > sessions + evidence > group by session
export const getTargetResultSidebar = async (
  query: TargetResultsQuery,
  database?: DbOrTx,
) => {
  const results = query.descriptionId
    ? await listResultRecordsByDescriptionId(query.descriptionId, database)
    : query.partCodeId
      ? await listResultRecordsByPartCodeId(query.partCodeId, database)
      : [];

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

  const sessionById = new Map(
    sessionRecords.map((session) => [session.sessionId, session]),
  );
  const resultsBySessionId = new Map<number, typeof results>();
  for (const row of results) {
    const bucket = resultsBySessionId.get(row.sessionId) ?? [];
    bucket.push(row);
    resultsBySessionId.set(row.sessionId, bucket);
  }

  const sessions = await Promise.all(
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

  return {
    target: {
      descriptionId: query.descriptionId ?? null,
      partCodeId: query.partCodeId ?? null,
    },
    sessions,
  };
};
