// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What `If-Match` is read to mean.
 *
 * The routes are tested over HTTP; this is the header grammar on its own,
 * because the cases that matter — a list, a star, a weak tag — are awkward to
 * reach through a route and easy to get subtly wrong.
 */

import { describe, expect, it } from "vite-plus/test";
import { ifMatch, setVersion } from "./preconditions.ts";

describe("reading If-Match", () => {
  const tag = '"424242"';

  it("treats an absent header as no request for a guarantee", () => {
    // Not a failure: a client that does not ask keeps the old behaviour, which
    // is what stops this from breaking every simple client (ADR 0019).
    expect(ifMatch(undefined, tag)).toBe("absent");
  });

  it("matches the tag it was given", () => {
    expect(ifMatch(tag, tag)).toBe("met");
  });

  it("fails a tag that names another version", () => {
    expect(ifMatch('"1"', tag)).toBe("failed");
  });

  it("takes a star to mean any version, provided there is one", () => {
    expect(ifMatch("*", tag)).toBe("met");
  });

  it("accepts a list, and matches if any of it does", () => {
    expect(ifMatch(`"1", ${tag}, "3"`, tag)).toBe("met");
    expect(ifMatch('"1", "2"', tag)).toBe("failed");
  });

  it("never matches a weak tag", () => {
    // `If-Match` is a strong comparison (RFC 9110). Nothing here issues a weak
    // tag, and one arriving means a client or a proxy invented it.
    expect(ifMatch(`W/${tag}`, tag)).toBe("failed");
  });

  it("does not find a wildcard inside a tag", () => {
    // A tag is opaque and quoted: a comma or an asterisk between the quotes is
    // part of it. Splitting the field on every comma exposed the `*` in
    // `"old,*,other"` and let any write through.
    expect(ifMatch('"old,*,other"', tag)).toBe("failed");
    expect(ifMatch('"*"', tag)).toBe("failed");
    expect(ifMatch('"a,b", "c"', tag)).toBe("failed");
    expect(ifMatch(`"a,b", ${tag}`, tag)).toBe("met");
  });

  it("takes a wildcard only as the whole field", () => {
    // RFC 9110 allows `*` alone or a list of tags, never a mixture. A list
    // carrying one is malformed, and writing anyway is the wrong way to be
    // wrong.
    expect(ifMatch("  *  ", tag)).toBe("met");
    expect(ifMatch("\u00a0*\u00a0", tag)).toBe("failed");
    expect(ifMatch(`*, ${tag}`, tag)).toBe("failed");
    expect(ifMatch(`${tag}, *`, tag)).toBe("failed");
  });

  it("ignores empty elements wherever they are", () => {
    // RFC 9110 §5.6.1 asks a recipient to tolerate them rather than refuse a
    // list that is otherwise perfectly good.
    expect(ifMatch(`, ${tag}`, tag)).toBe("met");
    expect(ifMatch(`${tag},`, tag)).toBe("met");
    expect(ifMatch(`"1",, ${tag}`, tag)).toBe("met");
    expect(ifMatch(`,,\t ${tag} ,,`, tag)).toBe("met");
    // A field of nothing but separators names no tag, so it matches none.
    expect(ifMatch(",,,", tag)).toBe("failed");
  });

  it("fails a field that is not tags at all", () => {
    expect(ifMatch("42", tag)).toBe("failed");
    expect(ifMatch(`${tag} ${tag}`, tag)).toBe("failed");
    expect(ifMatch(`"unterminated`, tag)).toBe("failed");
    // One good tag does not excuse a malformed one beside it.
    expect(ifMatch(`${tag}, "not valid"`, tag)).toBe("failed");
    expect(ifMatch(`${tag}, "tab\there"`, tag)).toBe("failed");
  });

  it("fails an empty header rather than treating it as absent", () => {
    // A header that is present and says nothing is a client that meant to send
    // a tag. Refusing is the safe reading; `absent` would write regardless.
    expect(ifMatch("", tag)).toBe("failed");
    expect(ifMatch("  ", tag)).toBe("failed");
  });
});

describe("versioning a set", () => {
  // Its callers happen to sort before handing it anything, so nothing about
  // these guarantees is observable through a route. They are the function's
  // own, and this is where they can be held to.
  it("is the same for the same members, in any order", () => {
    expect(setVersion(["b", "a", "c"])).toBe(setVersion(["a", "b", "c"]));
  });

  it("is different for different members", () => {
    expect(setVersion(["a", "b"])).not.toBe(setVersion(["a", "c"]));
    expect(setVersion(["a", "b"])).not.toBe(setVersion(["a"]));
  });

  it("gives the empty set a version of its own", () => {
    // "Mapped to nothing" is a state a caller can hold and write against, not
    // the absence of one.
    expect(setVersion([])).toMatch(/^[0-9a-f]{64}$/);
    expect(setVersion([])).not.toBe(setVersion([""]));
  });

  it("counts a repeated member once, as a set does", () => {
    expect(setVersion(["a", "a"])).toBe(setVersion(["a"]));
  });

  it("does not confuse one member with two", () => {
    // The serialisation must be unambiguous: a member containing a comma is
    // still one member.
    expect(setVersion(["a,b"])).not.toBe(setVersion(["a", "b"]));
  });
});
