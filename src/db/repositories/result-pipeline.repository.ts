
import { eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import {
  resultPipeline,
  resultPipelineFinding,
} from "../schema";

/* =========================================================
   Types
   ========================================================= */

export type CreateResultPipelineFindingInput = {
  resultId: number;
  category:
    | "damage"
    | "debris"
    | "riser_bend"
    | "stabilization"
    | "burial"
    | "freespans"
    | "leak_observation"
    | "Crossings"
    | "features";

  damageDimensions: string;
  damageType:
    | "bare_metal"
    | "crack"
    | "groove"
    | "bitumen_exposed"
    | "reinforcement_bar_exposed"
    | null;

  debrisType: "hard" | "soft" | null;
  debrisDescription: string;

  riserBendCondition:
    | "seabed_support"
    | "stabilization"
    | "in_suspension"
    | null;

  stabilizationType: string;
  stabilizationCondition: "supporting" | "not_supporting" | null;

  burialStart: string;
  burialEnd: string;

  freespansStart: string;
  freespansEnd: string;
  freespansLength: string;
  freespansHeight: string;

  leakType: string;
  leakDescription: string;

  crossingType: "over" | "under" | null;
  crossingContact: "touching" | "not_touching" | null;
  crossingGapDistance: string;
  crossingDamageMovement: string;

  featuresType: string;
  featuresCondition: "good" | "bad" | "damage" | null;

  remarks: string;
};

export type CreateResultPipelineInput = {
  resultId: number;
  location: string;
  depthEl: string | null;
  orientation:
    | "12_oclock"
    | "1_oclock"
    | "2_oclock"
    | "3_oclock"
    | "4_oclock"
    | "5_oclock"
    | "6_oclock"
    | "7_oclock"
    | "8_oclock"
    | "9_oclock"
    | "10_oclock"
    | "11_oclock"
    | null;
};

/* =========================================================
   PIPELINE parent record
   ========================================================= */

export const createResultPipeline = async (
  data: CreateResultPipelineInput,
  database: DbOrTx = db,
) =>
  (
    await database
      .insert(resultPipeline)
      .values(data)
      .returning()
  )[0] ?? null;

export const getResultPipelineByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  (
    await database
      .select()
      .from(resultPipeline)
      .where(eq(resultPipeline.resultId, resultId))
      .limit(1)
  )[0] ?? null;

export const listResultPipelineByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<Map<number, typeof resultPipeline.$inferSelect>> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultPipeline)
    .where(inArray(resultPipeline.resultId, resultIds));

  return new Map(rows.map((row) => [row.resultId, row]));
};

export const deleteResultPipeline = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<boolean> => {
  const rows = await database
    .delete(resultPipeline)
    .where(eq(resultPipeline.resultId, resultId))
    .returning();

  return rows.length > 0;
};

/* =========================================================
   PIPELINE findings
   ========================================================= */

export const createResultPipelineFinding = async (
  data: CreateResultPipelineFindingInput,
  database: DbOrTx = db,
) =>
  (
    await database
      .insert(resultPipelineFinding)
      .values(data)
      .returning()
  )[0] ?? null;

export const listResultPipelineFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(resultPipelineFinding)
    .where(eq(resultPipelineFinding.resultId, resultId))
    .orderBy(resultPipelineFinding.findingId);

export const listResultPipelineFindingsByResultIds = async (
  resultIds: number[],
  database: DbOrTx = db,
): Promise<
  Map<number, (typeof resultPipelineFinding.$inferSelect)[]>
> => {
  if (resultIds.length === 0) {
    return new Map();
  }

  const rows = await database
    .select()
    .from(resultPipelineFinding)
    .where(inArray(resultPipelineFinding.resultId, resultIds))
    .orderBy(resultPipelineFinding.findingId);

  const grouped = new Map<
    number,
    (typeof resultPipelineFinding.$inferSelect)[]
  >();

  for (const row of rows) {
    const existing = grouped.get(row.resultId) ?? [];
    existing.push(row);
    grouped.set(row.resultId, existing);
  }

  return grouped;
};

export const deleteResultPipelineFindingsByResultId = async (
  resultId: number,
  database: DbOrTx = db,
): Promise<number> => {
  const rows = await database
    .delete(resultPipelineFinding)
    .where(eq(resultPipelineFinding.resultId, resultId))
    .returning();

  return rows.length;
};
