import pg from "pg";
import { env } from "../../src/config/env";

// Seed the Postgres chain an ingest create needs: master requires a session,
// clip requires a result (project > asset > component > item > session_item).
// One seeded project per call; deleting it cascades everything away.
export interface SeededHierarchy {
  projectId: number;
  sessionId: number;
  sessionItemId: number;
  itemId: number;
  resultId: number;
  cleanup: () => Promise<void>;
  // close the pool but keep the rows — for scripts that leave state to inspect
  disconnect: () => Promise<void>;
}

export async function seedRecordingHierarchy(): Promise<SeededHierarchy> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const id = crypto.randomUUID().slice(0, 8);

  try {
    const project = await pool.query<{ project_id: number }>(
      "insert into project (title) values ($1) returning project_id",
      [`seed-${id}`],
    );
    const projectId = project.rows[0]!.project_id;

    const asset = await pool.query<{ asset_id: number }>(
      "insert into asset (project_id, name) values ($1, $2) returning asset_id",
      [projectId, `seed-asset-${id}`],
    );
    const assetId = asset.rows[0]!.asset_id;

    const component = await pool.query<{ component_id: number }>(
      "insert into component (asset_id, project_id, name) values ($1, $2, $3) returning component_id",
      [assetId, projectId, `seed-component-${id}`],
    );
    const componentId = component.rows[0]!.component_id;

    const item = await pool.query<{ item_id: number }>(
      "insert into item (component_id, project_id, asset_id, item_label) values ($1, $2, $3, $4) returning item_id",
      [componentId, projectId, assetId, `seed-item-${id}`],
    );
    const itemId = item.rows[0]!.item_id;

    const session = await pool.query<{ session_id: number }>(
      "insert into session (project_id) values ($1) returning session_id",
      [projectId],
    );
    const sessionId = session.rows[0]!.session_id;

    const sessionItem = await pool.query<{ session_item_id: number }>(
      "insert into session_item (session_id, item_id) values ($1, $2) returning session_item_id",
      [sessionId, itemId],
    );
    const sessionItemId = sessionItem.rows[0]!.session_item_id;

    const result = await pool.query<{ result_id: number }>(
      "insert into result (session_item_id, inspection_type_code, project_id, asset_id, component_id, item_id, session_id) values ($1, 'GVI', $2, $3, $4, $5, $6) returning result_id",
      [sessionItemId, projectId, assetId, componentId, itemId, sessionId],
    );

    return {
      projectId,
      sessionId,
      sessionItemId,
      itemId,
      resultId: result.rows[0]!.result_id,
      cleanup: async () => {
        // video_clip -> master_video has NO cascade by design; clear clips first
        await pool.query(
          "delete from video_clip where master_video_id in (select mv.master_video_id from master_video mv join session s on s.session_id = mv.session_id where s.project_id = $1)",
          [projectId],
        );
        await pool.query("delete from project where project_id = $1", [projectId]);
        await pool.end();
      },
      disconnect: async () => {
        await pool.end();
      },
    };
  } catch (err) {
    await pool.end();
    throw err;
  }
}
