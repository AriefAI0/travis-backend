import {
  imageEvidenceLeaves,
  imageExtension,
  resultEvidenceStem,
} from "../../lib/minio_storage/paths";
import { AppError } from "../../lib/error";
import { mintPutUrl } from "../../lib/minio_storage/mint";
import type { DbOrTx } from "../client";
import {
  createResultImageRecord,
  deleteResultImageById,
  findResultImageById,
  updateResultImageById,
} from "../repositories/result-image.repository";
import { findProjectById } from "../repositories/project.repository";
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
    sessionId: number;
    descriptionId: number | null;
    partCodeId: number | null;
    resultId: number;
    displayNumber: number;
    inspectionTypeCode: string;
  },
  database?: DbOrTx,
) => {
  const project = await findProjectById(resultRow.projectId, database);
  if (!project) {
    throw new AppError(404, "not_found", `project ${resultRow.projectId} not found`);
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

// flow: result row > results stem > insert row > leaf from assigned imageId > PUT url
// The stem comes from the RESULT alone, never a clip: evidence images must
// survive a failed recording, so an image with no clip is the normal case.
export const createImageUploadTicket = async (
  input: { resultId: number; contentType: string; remarks?: string | null },
  database?: DbOrTx,
): Promise<ImageUploadTicket> => {
  if (!imageExtension(input.contentType)) {
    throw new AppError(400, "bad_request", `unsupported contentType ${input.contentType}`);
  }

  const resultRow = await requireResult(input.resultId, database);
  const stem = await resolveImageStem(resultRow, database);

  const imageRow = await createResultImageRecord(
    {
      resultId: resultRow.resultId,
      storageStem: stem,
      contentType: input.contentType,
      remarks: input.remarks?.trim() || null,
    },
    database,
  );
  if (!imageRow) throw new Error("result image insert returned no row");

  // report staleness keys on result.updatedAt — a new image must move it
  await touchResult(resultRow.resultId, database);

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

// flow: image row > annotated leaf > flag the row > PUT url
// Same imageId as the raw write: annotation edits an image, never clones it.
export const createAnnotatedUploadTicket = async (
  imageId: number,
  database?: DbOrTx,
): Promise<ImageUploadTicket> => {
  const imageRow = await requireImage(imageId, database);

  // flag before the upload: a minted URL the app never PUTs leaves a false
  // true, which mints a 404-ing GET. A missed flag hides a real image forever.
  await updateResultImageById(imageId, { hasAnnotated: true }, database);
  await touchResult(imageRow.resultId, database);

  const leaf = imageEvidenceLeaves(
    imageRow.storageStem,
    imageId,
    imageRow.contentType,
  ).annotated;
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
export const removeResultImage = async (imageId: number, database?: DbOrTx) => {
  const imageRow = await requireImage(imageId, database);
  const deleted = await deleteResultImageById(imageId, database);
  await touchResult(imageRow.resultId, database);
  return deleted;
};
