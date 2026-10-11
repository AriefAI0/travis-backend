import {
  imageEvidenceLeaves,
  imageExtension,
  raEvidenceStem,
  resultEvidenceStem,
} from "../../lib/minio_storage/paths";
import { AppError } from "../../lib/error";
import type { Caller } from "../../lib/caller";
import { mintPutUrl } from "../../lib/minio_storage/mint";
import { db, type DbOrTx } from "../client";
import { writeAudit } from "./audit.service";
import {
  createResultImageRecord,
  deleteResultImageById,
  findResultImageById,
  updateResultImageById,
} from "../repositories/result-image.repository";
import { findProjectByIdInternal } from "../repositories/project.repository";
import { findSessionById } from "../repositories/session.repository";
import { listVideoClipRecordsByResultId } from "../repositories/video-clip.repository";
import { getResultById, touchResult } from "./result.service";
import { resolveTargetLabel } from "./task-structure.service";

export type ImageUploadTicket = {
  imageId: number;
  storageStem: string;
  contentType: string;
  variant: "raw" | "annotated";
  url: string;
  expiresInSeconds: number;
};

const PUT_TTL_SECONDS = 900;

// resolve the parent result or refuse — a stem must never be invented
const requireResult = async (resultId: number, database?: DbOrTx) => {
  const resultRow = await getResultById(resultId, database);
  if (!resultRow) throw new AppError(404, "not_found", `result ${resultId} not found`);
  return resultRow;
};

const requireImage = async (imageId: number, database?: DbOrTx) => {
  const imageRow = await findResultImageById(imageId, database);
  if (!imageRow) throw new AppError(404, "not_found", `image ${imageId} not found`);
  return imageRow;
};

// flow: result row > project + session + target > evidence stem. The
// date is the master's start, or the session's creation for a session with no
// master (a photo-only inspection). The stem freezes on the image row, so a
// later rename cannot split one result's images across two directories.
const resolveImageStem = async (
  resultRow: {
    projectId: number;
    sessionId: number | null;
    descriptionId: number | null;
    partCodeId: number | null;
    resultId: number;
    displayNumber: number;
    inspectionTypeCode: string;
    isRa: boolean;
    createdAt: Date;
  },
  database?: DbOrTx,
) => {
  // The id comes from a result row the caller already fetched through a
  // scoped route, so the org check has already happened upstream. This only
  // reads the project's number and title for the media path.
  const project = await findProjectByIdInternal(resultRow.projectId, database);
  if (!project) {
    throw new AppError(404, "not_found", `project ${resultRow.projectId} not found`);
  }

  // An RA mark has no session and no clip, so its evidence sits under the
  // project folder alone — the 409 below stays for any other sessionless row.
  if (resultRow.sessionId === null) {
    if (!resultRow.isRa) {
      throw new AppError(409, "wrong_state", `result ${resultRow.resultId} has no session`);
    }

    return raEvidenceStem({
      projectNumber: project.displayNumber,
      projectTitle: project.title,
      markedAt: resultRow.createdAt,
      itemLabel: await resolveTargetLabel(resultRow, database),
    });
  }

  const session = await findSessionById(resultRow.sessionId, database);
  if (!session) {
    throw new AppError(404, "not_found", `session ${resultRow.sessionId} not found`);
  }

  // the target label names the evidence folder, exactly like the item did
  const targetLabel = await resolveTargetLabel(resultRow, database);

  const [clip] = await listVideoClipRecordsByResultId(resultRow.resultId, database);

  return resultEvidenceStem({
    projectNumber: project.displayNumber,
    projectTitle: project.title,
    displayNumber: session.displayNumber ?? session.sessionId,
    // the session carries the master anchors; fall back to its creation
    startEpoch: session.startEpoch ?? Math.floor(session.createdAt.getTime() / 1000),
    resultNumber: resultRow.displayNumber,
    itemLabel: targetLabel,
    clip: clip
      ? {
          resultNumber: resultRow.displayNumber,
          itemLabel: targetLabel,
          inspectionType: resultRow.inspectionTypeCode,
        }
      : undefined,
  });
};

// flow: result row > results stem > insert row > audit, one transaction >
//       then the presigned PUT outside it
// The stem comes from the RESULT alone, never a clip: evidence images must
// survive a failed recording, so an image with no clip is the normal case.
// Minting the URL stays out of the transaction: it is network I/O, and a
// MinIO call must not hold a database transaction open.
export const createImageUploadTicket = async (
  input: { resultId: number; contentType: string; remarks?: string | null },
  caller: Caller,
  database?: DbOrTx,
): Promise<ImageUploadTicket> => {
  if (!imageExtension(input.contentType)) {
    throw new AppError(400, "bad_request", `unsupported contentType ${input.contentType}`);
  }

  const commit = async (tx: DbOrTx) => {
    const resultRow = await requireResult(input.resultId, tx);
    const stem = await resolveImageStem(resultRow, tx);

    const imageRow = await createResultImageRecord(
      {
        resultId: resultRow.resultId,
        storageStem: stem,
        contentType: input.contentType,
        remarks: input.remarks?.trim() || null,
      },
      tx,
    );
    if (!imageRow) throw new Error("result image insert returned no row");

    // report staleness keys on result.updatedAt — a new image must move it
    await touchResult(resultRow.resultId, tx);

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "create",
        resourceType: "ResultImage",
        resourceId: imageRow.imageId,
        after: imageRow,
      },
      tx,
    );

    return { imageRow, stem };
  };

  const { imageRow, stem } = database ? await commit(database) : await db.transaction(commit);

  const leaf = imageEvidenceLeaves(stem, imageRow.imageId, input.contentType).raw;
  return {
    imageId: imageRow.imageId,
    storageStem: stem,
    contentType: input.contentType,
    variant: "raw",
    url: await mintPutUrl(leaf.bucket, leaf.key),
    expiresInSeconds: PUT_TTL_SECONDS,
  };
};

// flow: image row > flag + audit in one transaction > annotated PUT url
// Same imageId as the raw write: annotation edits an image, never clones it.
export const createAnnotatedUploadTicket = async (
  imageId: number,
  caller: Caller,
  database?: DbOrTx,
): Promise<ImageUploadTicket> => {
  const commit = async (tx: DbOrTx) => {
    const imageRow = await requireImage(imageId, tx);

    // flag before the upload: a minted URL the app never PUTs leaves a false
    // true, which mints a 404-ing GET. A missed flag hides a real image forever.
    await updateResultImageById(imageId, { hasAnnotated: true }, tx);
    await touchResult(imageRow.resultId, tx);

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "modify",
        resourceType: "ResultImage",
        resourceId: imageId,
        before: imageRow,
        after: { ...imageRow, hasAnnotated: true },
      },
      tx,
    );

    return imageRow;
  };

  const imageRow = database ? await commit(database) : await db.transaction(commit);

  const leaf = imageEvidenceLeaves(imageRow.storageStem, imageId, imageRow.contentType).annotated;
  return {
    imageId,
    storageStem: imageRow.storageStem,
    contentType: imageRow.contentType,
    variant: "annotated",
    url: await mintPutUrl(leaf.bucket, leaf.key),
    expiresInSeconds: PUT_TTL_SECONDS,
  };
};

// remove the row; the objects are swept separately (no delete-on-read path)
export const removeResultImage = async (
  imageId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const commit = async (tx: DbOrTx) => {
    const imageRow = await requireImage(imageId, tx);
    const deleted = await deleteResultImageById(imageId, tx);
    await touchResult(imageRow.resultId, tx);

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "remove",
        resourceType: "ResultImage",
        resourceId: imageId,
        before: imageRow,
      },
      tx,
    );

    return deleted;
  };

  return database ? commit(database) : db.transaction(commit);
};
