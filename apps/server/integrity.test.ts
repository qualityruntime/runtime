// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * That a file which changed on the volume is noticed.
 *
 * The bytes are altered here the way something outside the product would alter
 * them — by writing to the volume — because a test that goes through the API
 * cannot do it, which is the whole reason this check exists.
 */

import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema } from "@qualityruntime/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { describeVerification, verifyEverything, verifyOrganization } from "./integrity.ts";
import { fileStoreOnDisk } from "./storage-on-disk.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));
const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;
let directory: string;
let store: ReturnType<typeof fileStoreOnDisk>;

type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
type Request = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

const request = (tenant: Tenant, path: string, init: Request = {}) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    headers: { cookie: tenant.cookie, ...init.headers },
  });

/** A control, a piece of evidence, and a file on it. Returns the file's id. */
async function storedFile(tenant: Tenant, contents: string): Promise<string> {
  const control = await request(tenant, "/controls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Access review" }),
  });
  const controlId = (await json<{ data: { id: string } }>(control)).data.id;
  const evidence = await request(tenant, `/controls/${controlId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Minutes", occurredAt: "2026-07-01T09:00:00.000Z" }),
  });
  const evidenceId = (await json<{ data: { id: string } }>(evidence)).data.id;
  const uploaded = await request(tenant, `/evidence/${evidenceId}/files?filename=notes.txt`, {
    method: "POST",
    body: contents,
  });
  expect(uploaded.status).toBe(201);
  return (await json<{ data: { id: string } }>(uploaded)).data.id;
}

/** Where the volume keeps a given file. */
const pathOf = (fileId: string) => {
  const random = fileId.slice(fileId.indexOf("_") + 1);
  return join(directory, random.slice(0, 2), random.slice(2, 4), fileId);
};

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  directory = await mkdtemp(join(tmpdir(), "qualityruntime-"));
  store = fileStoreOnDisk(directory);
  app = createApp({
    db,
    store,
    auth: createAuth(db, {
      baseURL: "http://localhost",
      secret: "test-secret-of-at-least-32-characters",
    }),
  });

  const tenant = async (slug: string): Promise<Tenant> => {
    const signedUp = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada",
        email: `${slug}@example.test`,
        password: "correct horse",
      }),
    });
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const created = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: slug, slug }),
    });
    expect(created.status).toBe(200);
    return { cookie, organizationId: (await json<{ id: string }>(created)).id };
  };

  acme = await tenant("acme");
  globex = await tenant("globex");

  await client.exec(`
    create role qualityruntime_app nosuperuser nobypassrls;
    grant all on all tables in schema public to qualityruntime_app;
    alter table "control" owner to qualityruntime_app;
    alter table "audit_event" owner to qualityruntime_app;
    alter table "standard" owner to qualityruntime_app;
    alter table "requirement" owner to qualityruntime_app;
    alter table "control_requirement" owner to qualityruntime_app;
    alter table "evidence" owner to qualityruntime_app;
    alter table "file" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);
}, 60_000);

describe("verifying what is stored", () => {
  it("is satisfied by files nobody has touched", async () => {
    await storedFile(acme, "the minutes as recorded");

    const verification = await verifyOrganization(db, store, acme.organizationId);

    expect(verification.checked).toBeGreaterThan(0);
    expect(verification.findings).toEqual([]);
  });

  it("notices bytes that changed on the volume", async () => {
    // Nothing in the product can do this, which is the point: a file whose
    // contents change without its row changing is exactly what the checksum is
    // there to catch.
    const fileId = await storedFile(acme, "what was attested");
    await writeFile(pathOf(fileId), "what somebody put there instead");

    const { findings } = await verifyOrganization(db, store, acme.organizationId);

    const finding = findings.find((each) => each.fileId === fileId);
    expect(finding?.fault).toBe("altered");
    expect(finding?.found).not.toBe(finding?.expected);
    expect(finding?.filename).toBe("notes.txt");
  });

  it("notices bytes that are gone", async () => {
    const fileId = await storedFile(acme, "here for now");
    await rm(pathOf(fileId));

    const { findings } = await verifyOrganization(db, store, acme.organizationId);

    expect(findings.find((each) => each.fileId === fileId)?.fault).toBe("missing");
  });

  it("notices a change of one byte", async () => {
    // A corruption need not be dramatic to matter.
    const fileId = await storedFile(acme, "aaaaaaaaaa");
    await writeFile(pathOf(fileId), "aaaaaaaaab");

    const { findings } = await verifyOrganization(db, store, acme.organizationId);

    expect(findings.find((each) => each.fileId === fileId)?.fault).toBe("altered");
  });

  it("reports a file it cannot read instead of giving up on the rest", async () => {
    // A report that stops at the first fault is the one thing this cannot
    // afford to produce: whatever tampered with one file may have tampered
    // with the next, and an unreadable file is a fault, not an exception.
    const unreadable = await storedFile(acme, "no longer readable");
    const altered = await storedFile(acme, "also tampered with");
    await chmod(pathOf(unreadable), 0o000);
    await writeFile(pathOf(altered), "changed after the unreadable one");

    try {
      const { findings } = await verifyOrganization(db, store, acme.organizationId);

      expect(findings.find((each) => each.fileId === unreadable)?.fault).toBe("unreadable");
      // Visited after the unreadable one, and still reported.
      expect(findings.find((each) => each.fileId === altered)?.fault).toBe("altered");
    } finally {
      await chmod(pathOf(unreadable), 0o600);
    }
  });

  it("says which evidence a bad file belongs to", async () => {
    // Whoever reads this has to find the record, not the file.
    const fileId = await storedFile(acme, "traceable");
    await writeFile(pathOf(fileId), "tampered");

    const { findings } = await verifyOrganization(db, store, acme.organizationId);

    expect(findings.find((each) => each.fileId === fileId)?.evidenceId).toMatch(/^evd_/);
  });
});

describe("verifying every organization", () => {
  it("checks each one inside its own tenant context", async () => {
    // Tampered on purpose, and belonging to Globex: if the reads were not
    // scoped, verifying Acme would find Globex's bad file, and verifying
    // everything would find it once per organization rather than once.
    const theirs = await storedFile(globex, "theirs, and broken");
    await writeFile(pathOf(theirs), "broken differently");

    const acmeOnly = await verifyOrganization(db, store, acme.organizationId);
    const everything = await verifyEverything(db, store);

    expect(acmeOnly.findings.map((finding) => finding.fileId)).not.toContain(theirs);
    expect(acmeOnly.findings.every((f) => f.organizationId === acme.organizationId)).toBe(true);
    expect(everything.findings.filter((finding) => finding.fileId === theirs)).toHaveLength(1);
  });

  it("finds a bad file wherever it is", async () => {
    const fileId = await storedFile(globex, "theirs, altered");
    await writeFile(pathOf(fileId), "not theirs any more");

    const { findings } = await verifyEverything(db, store);

    const finding = findings.find((each) => each.fileId === fileId);
    expect(finding?.organizationId).toBe(globex.organizationId);
  });

  it("finds nothing in a deployment holding nothing", async () => {
    // Builds a database of its own, which is most of a second before any
    // assertion runs — and several seconds on a loaded machine, where the
    // default timeout is not enough. The `beforeAll` hooks allow for the
    // same thing.
    const empty = createTestDatabase(new PGlite());
    await migrate(empty, { migrationsFolder });

    const verification = await verifyEverything(empty, store);

    expect(verification).toEqual({ checked: 0, findings: [] });
  }, 60_000);
});

describe("what it tells a person", () => {
  it("says so plainly when everything matches", () => {
    expect(describeVerification({ checked: 12, findings: [] })).toContain("All match");
  });

  it("does not call checking nothing a match", () => {
    // Pointed at a restore that never loaded, a pass would be the one wrong
    // answer that looks right.
    const report = describeVerification({ checked: 0, findings: [] });

    expect(report).not.toContain("match");
    expect(report).toContain("nothing was checked");
    expect(report).toContain("DATABASE_URL");
  });

  it("names the file, the record, and both checksums", () => {
    const report = describeVerification({
      checked: 3,
      findings: [
        {
          fileId: "fil_v1stgxr8z5jdhi6b",
          organizationId: "org_v1stgxr8z5jdhi6b",
          evidenceId: "evd_v1stgxr8z5jdhi6b",
          filename: "minutes.pdf",
          fault: "altered",
          expected: "a".repeat(64),
          found: "b".repeat(64),
        },
      ],
    });

    expect(report).toContain("fil_v1stgxr8z5jdhi6b");
    expect(report).toContain("evd_v1stgxr8z5jdhi6b");
    expect(report).toContain("minutes.pdf");
    expect(report).toContain("a".repeat(64));
    expect(report).toContain("b".repeat(64));
  });

  it("names an unreadable file and why", () => {
    const report = describeVerification({
      checked: 1,
      findings: [
        {
          fileId: "fil_v1stgxr8z5jdhi6b",
          organizationId: "org_v1stgxr8z5jdhi6b",
          evidenceId: "evd_v1stgxr8z5jdhi6b",
          filename: "locked.pdf",
          fault: "unreadable",
          expected: "a".repeat(64),
          detail: "EACCES: permission denied",
        },
      ],
    });

    expect(report).toContain("UNREADABLE");
    expect(report).toContain("EACCES");
  });

  it("says a volume that is wholly absent may be a volume that is absent", () => {
    // Every file missing is what an unmounted volume looks like, and the
    // cheaper thing to rule out before going to the backups.
    const gone = (id: string) =>
      ({
        fileId: id,
        organizationId: "org_v1stgxr8z5jdhi6b",
        evidenceId: "evd_v1stgxr8z5jdhi6b",
        filename: "minutes.pdf",
        fault: "missing",
        expected: "a".repeat(64),
      }) as const;

    const everything = describeVerification({
      checked: 2,
      findings: [gone("fil_a"), gone("fil_b")],
    });
    const some = describeVerification({ checked: 3, findings: [gone("fil_a"), gone("fil_b")] });

    expect(everything).toContain("STORAGE_DIRECTORY");
    expect(some).not.toContain("STORAGE_DIRECTORY");
  });

  it("distinguishes a file that is gone from one that changed", () => {
    const report = describeVerification({
      checked: 1,
      findings: [
        {
          fileId: "fil_v1stgxr8z5jdhi6b",
          organizationId: "org_v1stgxr8z5jdhi6b",
          evidenceId: "evd_v1stgxr8z5jdhi6b",
          filename: "gone.pdf",
          fault: "missing",
          expected: "a".repeat(64),
        },
      ],
    });

    expect(report).toContain("MISSING");
    expect(report).not.toContain("ALTERED");
  });
});

describe("the volume itself", () => {
  it("holds one file per row, and nothing a row does not claim", async () => {
    // An orphan — bytes with no row — would show up here as an extra path, and
    // nothing else would ever notice it. A row whose bytes are gone is the
    // other direction, so one is removed here rather than relying on a case in
    // another `describe` having done it.
    await rm(pathOf(await storedFile(acme, "about to go missing")));

    const paths = await leaves(directory);
    const { checked, findings } = await verifyEverything(db, store);
    const missing = findings.filter((finding) => finding.fault === "missing").length;

    expect(missing).toBeGreaterThan(0);
    expect(paths.length).toBe(checked - missing);
  });
});

/** Every file under `directory`, as paths relative to it. */
async function leaves(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await leaves(root, path)));
    else found.push(path);
  }
  return found;
}
