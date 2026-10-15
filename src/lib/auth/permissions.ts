// The whole permission vocabulary in one place, so a tick box label, a stored
// row, and a route check all name the same thing.
// Source: travis-viewer-spec.md, "Permission list (tick boxes)".

export const ACTIONS = [
  "read",
  "create",
  "modify",
  "remove",
  "restore",
  "publish",
  "watch",
  "manage",
] as const;
export type Action = (typeof ACTIONS)[number];

export const SUBJECTS = [
  "Project",
  "Structure",
  "Session",
  "Result",
  "Recording",
  "Report",
  "Stream",
  "User",
  "Permission",
  "AuditLog",
] as const;
export type Subject = (typeof SUBJECTS)[number];

// The six-level tree chain, kept as one subject with a `level` condition
// rather than six near-identical subjects.
export const STRUCTURE_LEVELS = [
  "project",
  "taskGroup",
  "taskCode",
  "description",
  "type",
  "partCode",
] as const;
export type StructureLevel = (typeof STRUCTURE_LEVELS)[number];

// action > the subjects it may be granted on. The admin UI renders one tick
// box per pair, and a row outside this table is refused.
//
// Recording is not in the spec's table. The permissions mockup gives playback
// its own group with its own tick, and the recording routes exist, so playback
// can be granted or withheld without touching `read Session`.
export const GRANTABLE: Record<Action, Subject[]> = {
  read: ["Project", "Structure", "Session", "Result", "Recording", "Report", "AuditLog", "User"],
  create: ["Project", "Structure", "Session", "Result", "Report"],
  modify: ["Project", "Structure", "Session", "Result", "Report"],
  remove: ["Project", "Structure", "Result", "Report"],
  restore: ["Project", "Structure", "Session"],
  publish: ["Stream"],
  watch: ["Stream"],
  manage: ["User", "Permission"],
};

// A pair the tick-box grid can offer.
export type GrantablePair = { action: Action; subject: Subject };

export const GRANTABLE_PAIRS: GrantablePair[] = ACTIONS.flatMap((action) =>
  GRANTABLE[action].map((subject) => ({ action, subject })),
);

export const isGrantable = (action: string, subject: string): boolean =>
  (GRANTABLE as Record<string, string[] | undefined>)[action]?.includes(subject) ?? false;
