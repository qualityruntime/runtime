// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a deployment may configure, and the one combination it may not.
 */

import { describe, expect, it } from "vite-plus/test";
import { sessionCookiePath } from "./auth.ts";
import { assertStorageOutsideCookiePath } from "./environment.ts";

describe("where the object store may answer", () => {
  const server = "https://quality.example";
  const credentials = { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "secret" };
  const at = (endpoint: string | undefined, bucket = "evidence") => ({
    ...credentials,
    bucket,
    endpoint,
  });

  it.each([
    ["a host of its own", at("https://storage.example")],
    ["a host of its own under /api", at("https://storage.example/api")],
    ["another port of this host", at("http://localhost:9000")],
    ["this host, away from /api", at("https://quality.example/storage")],
    // `/api` path-matches `/apistorage` for nobody: a cookie path matches to a
    // segment boundary, so this is a different place entirely.
    ["this host, at a path that merely starts the same way", at("https://quality.example/apist")],
    ["this host, with a bucket that starts the same way", at("https://quality.example", "apist")],
  ])("allows %s", (_case, storage) => {
    const baseURL = storage.endpoint?.startsWith("http://localhost")
      ? "http://localhost:3000"
      : server;
    expect(() => assertStorageOutsideCookiePath(storage, baseURL, sessionCookiePath)).not.toThrow();
  });

  it.each([
    ["an endpoint of exactly /api", at("https://quality.example/api")],
    ["an endpoint below /api", at("https://quality.example/api/storage")],
    ["a trailing slash, which is the same place", at("https://quality.example/api/")],
    // The endpoint alone looks harmless here: it is the bucket that lands the
    // download under `/api`, which is why the check is made on the two
    // together rather than on `STORAGE_ENDPOINT`.
    ["a bucket named for this server's own path", at("https://quality.example", "api")],
  ])("refuses %s, where the session cookie is sent", (_case, storage) => {
    // `{endpoint}/{bucket}/{key}` puts the download under a path the cookie
    // matches, and a browser following the redirect attaches it.
    expect(() => assertStorageOutsideCookiePath(storage, server, sessionCookiePath)).toThrow(
      /hostname of its own/,
    );
  });

  it("allows AWS itself, which has no endpoint and never shares a hostname", () => {
    expect(() =>
      assertStorageOutsideCookiePath(at(undefined), server, sessionCookiePath),
    ).not.toThrow();
  });
});
