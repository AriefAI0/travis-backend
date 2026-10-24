import {
  imageEvidenceLeaves,
  imageExtension,
  raEvidenceStem,
  resultEvidenceStem,
} from "../../lib/minio_storage/paths";
import { AppError } from "../../lib/error";
import type { Caller } from "../../lib/caller";
import { mintGetUrl, mintPutUrl } from "../../lib/minio_storage/mint";
import {
  matchesImageMagic,
  MAX_ADMIN_IMAGE_BYTES,
  readObjectHead,
  removeExactMediaKeys,
} from "../../lib/minio_storage/result-image-objects";
import { minio } from "../../lib/minio_storage/clients";
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
  // admin uploads only: the object must pass this cap before finalize
  maxBytes?: number;
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
  options: { status?: "pending" | "ready"; maxBytes?: number } = {},
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
        status: options.status ?? "ready",
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
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  };
};

// Admin upload: one pending row on a completed result, then a finalize check.
export const createAdminImageUploadTicket = async (
  input: { resultId: number; contentType: string; remarks?: string | null },
  caller: Caller,
  database?: DbOrTx,
): Promise<ImageUploadTicket> => {
  const resultRow = await requireResult(input.resultId, database);
  if (resultRow.archivedAt !== null) {
    throw new AppError(404, "not_found", `result ${input.resultId} not found`);
  }
  if (resultRow.masterEndMs === null) {
    throw new AppError(
      409,
      "result_not_completed",
      `result ${input.resultId} is an open inspection`,
    );
  }

  return createImageUploadTicket(input, caller, database, {
    status: "pending",
    maxBytes: MAX_ADMIN_IMAGE_BYTES,
  });
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

type ImageRow = Awaited<ReturnType<typeof requireImage>>;

// Delete one image row and record it. Objects are already gone.
const deleteImageRow = async (imageRow: ImageRow, caller: Caller, tx: DbOrTx) => {
  const deleted = await deleteResultImageById(imageRow.imageId, tx);
  await touchResult(imageRow.resultId, tx);

  await writeAudit(
    {
      organizationId: caller.organizationId,
      userId: caller.userId,
      action: "remove",
      resourceType: "ResultImage",
      resourceId: imageRow.imageId,
      before: imageRow,
    },
    tx,
  );

  return deleted;
};

// Invalid bytes never become evidence: remove the object, then the row.
const rejectUpload = async (
  imageRow: ImageRow,
  caller: Caller,
  message: string,
  database?: DbOrTx,
): Promise<never> => {
  const leaf = imageEvidenceLeaves(
    imageRow.storageStem,
    imageRow.imageId,
    imageRow.contentType,
  ).raw;

  try {
    await removeExactMediaKeys([leaf.key]);
  } catch (error) {
    throw new AppError(
      500,
      "image_cleanup_failed",
      `image ${imageRow.imageId} failed validation and its object could not be removed: ${String(error)}`,
    );
  }

  const commit = async (tx: DbOrTx) => deleteImageRow(imageRow, caller, tx);
  if (database) {
    await commit(database);
  } else {
    await db.transaction(commit);
  }

  throw new AppError(
    400,
    "image_invalid",
    `image ${imageRow.imageId}: ${message}`,
  );
};

// flow: row > object stat > byte head > status ready, one short transaction
export const finalizeAdminImageUpload = async (
  imageId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const imageRow = await requireImage(imageId, database);
  if (imageRow.status === "ready") return imageRow;
  if (imageRow.status === "rejected") {
    throw new AppError(409, "image_rejected", `image ${imageId} was rejected`);
  }

  const leaf = imageEvidenceLeaves(
    imageRow.storageStem,
    imageRow.imageId,
    imageRow.contentType,
  ).raw;

  let size = 0;
  try {
    const stat = await minio.statObject(leaf.bucket, leaf.key);
    size = Number(stat.size);
  } catch {
    throw new AppError(
      409,
      "image_not_uploaded",
      `image ${imageId} has no stored object at ${leaf.key}`,
    );
  }

  if (size <= 0 || size > MAX_ADMIN_IMAGE_BYTES) {
    return rejectUpload(
      imageRow,
      caller,
      `object size ${size} must be between 1 and ${MAX_ADMIN_IMAGE_BYTES} bytes`,
      database,
    );
  }

  const head = await readObjectHead(leaf.bucket, leaf.key);
  if (!matchesImageMagic(head, imageRow.contentType)) {
    return rejectUpload(
      imageRow,
      caller,
      `bytes do not match ${imageRow.contentType}`,
      database,
    );
  }

  const commit = async (tx: DbOrTx) => {
    const updated = await updateResultImageById(imageId, { status: "ready" }, tx);
    if (!updated) throw new Error(`failed to finalize image ${imageId}`);
    await touchResult(imageRow.resultId, tx);

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "modify",
        resourceType: "ResultImage",
        resourceId: imageId,
        before: imageRow,
        after: updated,
      },
      tx,
    );

    return updated;
  };

  return database ? commit(database) : db.transaction(commit);
};

// Current variant and the stored leaf name, minted fresh on every request.
export const getImageDownloadUrl = async (
  imageId: number,
  database?: DbOrTx,
): Promise<{ imageId: number; filename: string; contentType: string; url: string }> => {
  const imageRow = await requireImage(imageId, database);
  if (imageRow.status !== "ready") {
    throw new AppError(409, "image_not_ready", `image ${imageId} is not ready`);
  }

  const leaves = imageEvidenceLeaves(
    imageRow.storageStem,
    imageRow.imageId,
    imageRow.contentType,
  );
  const leaf = imageRow.hasAnnotated ? leaves.annotated : leaves.raw;
  const filename = leaf.key.split("/").pop() ?? `image-${imageId}`;

  return {
    imageId,
    filename,
    contentType: imageRow.contentType,
    url: await mintGetUrl(leaf.bucket, leaf.key),
  };
};

// Permanent removal: exact raw and annotated objects go first. A failed object
// removal leaves the row so the admin can retry.
export const removeResultImage = async (
  imageId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const imageRow = await requireImage(imageId, database);
  const leaves = imageEvidenceLeaves(
    imageRow.storageStem,
    imageRow.imageId,
    imageRow.contentType,
  );
  await removeExactMediaKeys([leaves.raw.key, leaves.annotated.key]);

  const commit = async (tx: DbOrTx) => deleteImageRow(imageRow, caller, tx);
  return database ? commit(database) : db.transaction(commit);
};
