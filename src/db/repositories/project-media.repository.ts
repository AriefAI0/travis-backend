// Project-scoped media gathering, read BEFORE the rows are deleted: the frozen
// key prefixes and stored stems are the only record of where objects live.
// flow: sessions > clips + ingests > folders, evidence rows, still keys

import { eq, inArray, or } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingIngest, result, resultImage, session, videoClip } from "../schema";

export type ProjectEvidenceRow = {
  storageStem: string;
  imageId: number;
  contentType: string;
  hasAnnotated: boolean;
};

export type ProjectMediaTargets = {
  // frozen ingest prefixes, swept whole: segments, poster, filmstrip and any
  // evidence beside a clip all sit below the prefix the ingest owned
  prefixes: string[];
  // evidence rows: their leaf names are minted, never stored
  imageRows: ProjectEvidenceRow[];
  // poster and filmstrip stills a clip row stores its own key for
  thumbnailKeys: string[];
  // ingests still on the wire: one means a live writer holds the prefix
  openIngests: number;
};

export const listProjectMediaTargets = async (
  projectId: number,
  database: DbOrTx = db,
): Promise<ProjectMediaTargets> => {
  const sessions = await database
    .select({ sessionId: session.sessionId })
    .from(session)
    .where(eq(session.projectId, projectId));

  // result carries project_id, so evidence needs no session hop
  const imageRows = await database
    .select({
      storageStem: resultImage.storageStem,
      imageId: resultImage.imageId,
      contentType: resultImage.contentType,
      hasAnnotated: resultImage.hasAnnotated,
    })
    .from(resultImage)
    .innerJoin(result, eq(result.resultId, resultImage.resultId))
    .where(eq(result.projectId, projectId));

  const sessionIds = sessions.map((row) => row.sessionId);

  if (sessionIds.length === 0) {
    return { prefixes: [], imageRows, thumbnailKeys: [], openIngests: 0 };
  }

  const clips = await database
    .select({ clipId: videoClip.clipId, thumbnailKey: videoClip.thumbnailKey })
    .from(videoClip)
    .where(inArray(videoClip.sessionId, sessionIds));

  const clipIds = clips.map((row) => row.clipId);

  // master ingests hang off the session, clip ingests off the clip
  const ingests = await database
    .select({ keyPrefix: recordingIngest.keyPrefix, closedAt: recordingIngest.closedAt })
    .from(recordingIngest)
    .where(
      clipIds.length === 0
        ? inArray(recordingIngest.sessionId, sessionIds)
        : or(
            inArray(recordingIngest.sessionId, sessionIds),
            inArray(recordingIngest.clipId, clipIds),
          ),
    );

  return {
    prefixes: [...new Set(ingests.map((row) => row.keyPrefix))].filter(Boolean),
    imageRows,
    thumbnailKeys: clips
      .map((row) => row.thumbnailKey)
      .filter((key): key is string => key !== null && key.length > 0),
    openIngests: ingests.filter((row) => row.closedAt === null).length,
  };
};
