// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vite-plus/test";
import { createId, generateId, type IdType, idFormats, idPattern } from "./id.ts";

const models = Object.keys(idFormats) as IdType[];

describe.each(models)("%s", (model) => {
  const { prefix, length } = idFormats[model];

  it("carries the table's prefix and its own length", () => {
    const [head, random, ...rest] = createId(model).split("_");
    expect(head).toBe(prefix);
    expect(random).toHaveLength(length);
    expect(rest).toEqual([]);
  });

  it("matches its own pattern", () => {
    expect(createId(model)).toMatch(new RegExp(idPattern(model)));
  });

  it("matches no other table's pattern", () => {
    const id = createId(model);
    const others = models.filter((other) => other !== model);
    expect(others.filter((other) => new RegExp(idPattern(other)).test(id))).toEqual([]);
  });
});

describe("the identifier scheme", () => {
  it("uses one case, so nothing downstream can lose a row by normalizing", () => {
    for (const model of models) {
      const id = createId(model);
      expect(id).toBe(id.toLowerCase());
    }
  });

  it("gives every table a distinct prefix", () => {
    const prefixes = models.map((model) => idFormats[model].prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("gives an ordinary row identifier 16 characters", () => {
    // One rule for everything that is only ever a primary key. See ADR 0002.
    const ordinary = models.filter((model) => model !== "invitation");
    expect(ordinary.map((model) => idFormats[model].length)).toEqual(ordinary.map(() => 16));
  });

  it("gives an identifier used in a possession-based flow more", () => {
    // Better Auth takes an invitation by id in accept/reject/get, so guessing
    // one is worth something. A row identifier that is only a key is not.
    expect(idFormats.invitation.length).toBeGreaterThan(idFormats.user.length);
  });

  it("supplies Better Auth's generateId for every model it writes", () => {
    for (const model of models) {
      expect(generateId({ model })).toMatch(new RegExp(idPattern(model)));
    }
  });

  it("refuses a table that has not been given a format", () => {
    expect(() => generateId({ model: "passkey" })).toThrow(/passkey/);
  });
});
