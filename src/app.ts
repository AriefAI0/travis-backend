import { Hono } from "hono";
import { healthRoutes } from "./features/health/routes";
import { onError } from "./lib/error";

export const app = new Hono();

app.onError(onError);
app.route("/", healthRoutes);

export type AppType = typeof app;
