import {
  createMongoAbility,
  subject,
  type ForcedSubject,
  type MongoAbility,
  type RawRuleOf,
} from "@casl/ability";

import type { PermissionRow } from "../../db/repositories/user-permission.repository";
import type { Action, StructureLevel, Subject } from "./permissions";

// MongoAbility, not the plain Ability: a Structure rule carries a `level`
// condition, and only the mongo matcher can evaluate conditions.
// can() types its subject as the tuple's raw second element, so the forced
// form has to be spelled out here for a condition-bearing instance to be
// accepted.
export type AppAbility = MongoAbility<[Action, Subject | ForcedSubject<Subject>]>;

// A subject instance, which is what CASL matches a `conditions` rule against.
// flow: level name > Structure subject carrying that level
export const structureAt = (level: StructureLevel) =>
  subject("Structure", { level }) as Subject | ForcedSubject<Subject>;

// flow: permission rows > CASL rules > ability
// Pure and uncached on purpose: the spec requires a revoke to bite on the very
// next request, and the rows are one indexed query.
// An empty row set grants nothing — the ability starts with no rules.
export const buildAbility = (rows: PermissionRow[]): AppAbility => {
  const rules = rows.map((row) => {
    const conditions =
      row.conditions && typeof row.conditions === "object"
        ? (row.conditions as Record<string, unknown>)
        : undefined;

    return {
      action: row.action as Action,
      subject: row.subject as Subject,
      ...(conditions ? { conditions } : {}),
    };
  });

  return createMongoAbility(rules as RawRuleOf<AppAbility>[]);
};
