import { defineConfig } from "drizzle-kit";
import { env } from "./src/config/env";

// Migration tooling config — the USER runs db:generate/migrate/push, never the agent.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: { url: env.DATABASE_URL },
});
