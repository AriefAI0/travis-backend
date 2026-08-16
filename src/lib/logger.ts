import { env } from "../config/env";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

// warn/error go to stderr so stdout stays a clean info-level stream.
function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (levels[level] < levels[env.LOG_LEVEL]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};
