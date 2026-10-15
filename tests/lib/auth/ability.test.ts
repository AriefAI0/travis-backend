import { describe, expect, it } from "bun:test";

import { buildAbility, structureAt } from "../../../src/lib/auth/ability";
import type { PermissionRow } from "../../../src/db/repositories/user-permission.repository";
import type { Action, Subject } from "../../../src/lib/auth/permissions";

// a stored row, with the columns buildAbility reads
const row = (
  action: Action,
  subject: Subject,
  conditions: Record<string, unknown> | null = null,
): PermissionRow => ({
  userPermissionId: 1,
  userId: "u1",
  action,
  subject,
  conditions,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("buildAbility", () => {
  it("grants nothing for an empty row set", () => {
    const ability = buildAbility([]);

    expect(ability.can("read", "Project")).toBe(false);
    expect(ability.can("manage", "User")).toBe(false);
  });

  it("grants each stored pair", () => {
    const ability = buildAbility([
      row("read", "Project"),
      row("modify", "Result"),
      row("watch", "Stream"),
    ]);

    expect(ability.can("read", "Project")).toBe(true);
    expect(ability.can("modify", "Result")).toBe(true);
    expect(ability.can("watch", "Stream")).toBe(true);
  });

  it("does not leak a granted action onto another subject", () => {
    const ability = buildAbility([row("read", "Project")]);

    expect(ability.can("read", "AuditLog")).toBe(false);
    expect(ability.can("read", "User")).toBe(false);
    expect(ability.can("modify", "Project")).toBe(false);
  });

  it("honours a level condition on Structure", () => {
    const ability = buildAbility([row("modify", "Structure", { level: "partCode" })]);

    expect(ability.can("modify", structureAt("partCode"))).toBe(true);
    expect(ability.can("modify", structureAt("taskGroup"))).toBe(false);
  });

  it("treats an unconditional Structure row as every level", () => {
    const ability = buildAbility([row("read", "Structure")]);

    expect(ability.can("read", structureAt("project"))).toBe(true);
    expect(ability.can("read", structureAt("partCode"))).toBe(true);
  });

  it("ignores an action it has no rule for", () => {
    const ability = buildAbility([row("read", "Project")]);

    expect(ability.can("remove", "Project")).toBe(false);
    expect(ability.can("publish", "Stream")).toBe(false);
  });
});
