import { GRANTABLE_PAIRS, type Action, type GrantablePair, type Subject } from "./permissions";

const pair = (action: Action, subject: Subject): GrantablePair => ({ action, subject });

// Presets only pre-tick the boxes when an admin creates a user; the admin then
// adjusts. A preset is seed data, never a stored type on the user row.
// Source: travis-viewer-spec.md, "Presets".

// Everything the grid can grant, minus what the spec withholds from an admin:
// an admin does not publish the stream, and does not run an inspection, so
// `create Result` is out. `modify Result` stays — the spec has an admin
// editing an operator's result.
const adminRows = () =>
  GRANTABLE_PAIRS.filter(
    (grant) =>
      !(grant.action === "publish" && grant.subject === "Stream") &&
      !(grant.action === "create" && grant.subject === "Result"),
  );

// Capture, record, publish, and play back what it recorded. Reads the session
// and result data it writes. Source: the Operator sheet in
// travis-viewer-permissions-mockup.html, which ticks Playback > View.
// `read Stream` is NOT here: the spec's permission table has no such pair, and
// the mockup's Live stream group offers only Publish and Watch.
const operatorRows = (): GrantablePair[] => [
  pair("read", "Project"),
  pair("read", "Structure"),
  pair("read", "Session"),
  pair("read", "Result"),
  pair("read", "Recording"),
  pair("create", "Session"),
  pair("modify", "Session"),
  pair("create", "Result"),
  pair("modify", "Result"),
  pair("publish", "Stream"),
];

// Watch and read. No write right at all. `read Recording` is what plays a
// clip: the spec gives the viewer "play clips" and it holds no other way in.
const viewerRows = (): GrantablePair[] => [
  pair("read", "Project"),
  pair("read", "Structure"),
  pair("read", "Session"),
  pair("read", "Result"),
  pair("read", "Recording"),
  pair("read", "Report"),
  pair("watch", "Stream"),
];

export const PRESETS = {
  Admin: adminRows,
  Operator: operatorRows,
  Viewer: viewerRows,
} as const;

export type PresetName = keyof typeof PRESETS;

export const PRESET_NAMES = ["Admin", "Operator", "Viewer"] as const;

export const isPresetName = (value: string): value is PresetName =>
  (PRESET_NAMES as readonly string[]).includes(value);

// The rows a preset writes for a user.
export const presetRows = (preset: PresetName): GrantablePair[] => PRESETS[preset]();

const pairKey = (grant: GrantablePair) => `${grant.action}:${grant.subject}`;

// What the admin table shows. A set that matches a preset exactly reads as
// that preset; anything else reads as Custom, which is what happens the
// moment an admin adjusts one box.
export const presetLabelFor = (
  rows: Array<{ action: string; subject: string }>,
): PresetName | "Custom" => {
  const have = new Set(rows.map((row) => `${row.action}:${row.subject}`));

  for (const name of PRESET_NAMES) {
    const expected = presetRows(name);
    if (expected.length === have.size && expected.every((g) => have.has(pairKey(g)))) {
      return name;
    }
  }

  return "Custom";
};
