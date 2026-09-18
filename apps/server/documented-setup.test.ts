// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The setup the documents print, run as they print it.
 *
 * `privileges.test.ts` constructs the expected privileges directly. This test
 * checks that the documented setup produces them: it extracts SQL from both
 * deployment and development docs, creates roles as a superuser, applies
 * migrations as the migrator, runs the revokes, and exercises the runtime role.
 * This also checks grants needed during setup, such as creating the migration
 * journal's schema, which final privilege assertions alone would miss.
 *
 * Two kinds of drift are caught. A document that no longer *works* fails the
 * walk through the product. A document that quietly grants *more* fails the
 * bound at the end, which asks PostgreSQL what the runtime role actually ended
 * up holding rather than trusting the statements to be the ones intended.
 *
 * What is not covered, and is not pretended to be:
 *
 * The roles are reached with `SET ROLE` on one PGlite session, so no connection
 * string is ever opened — `LOGIN` is asserted as an attribute rather than used,
 * and the passwords not at all. That session's *user* stays the superuser, so
 * `SET ROLE` succeeds from anywhere regardless of what the documents grant:
 * every escape that works by becoming another role is invisible here by
 * construction, which is why membership is asked about directly below rather
 * than demonstrated.
 *
 * Nothing outside the SQL runs, so a `docker` invocation naming the wrong
 * container is still only prose. And the database is built fresh, so the
 * one-off grant `docs/deployment.md` gives for a database that already has
 * tables is not executed — on this one it would do nothing.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { assertTenantIsolation, schema } from "@qualityruntime/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";

const repository = new URL("../../", import.meta.url);
const migrationsFolder = fileURLToPath(new URL("packages/db/migrations", repository));

/** A fence opening or closing, indented or not, and the language it declares. */
const fence = /^\s*(?:```|~~~)(\w*)/;

/**
 * Statements that hand out privileges.
 *
 * Anything under these headings that sets privileges up and is *not* one of the
 * blocks below is a statement an operator runs and this does not — so it is an
 * error. That is the whole failure mode: a document saying one thing while the
 * suite proves another.
 */
const setsUpPrivileges = /\b(?:GRANT|REVOKE|CREATE\s+ROLE|ALTER\s+DEFAULT\s+PRIVILEGES)\b/i;

/**
 * The SQL blocks a document's section tells an operator to run, in order.
 *
 * A fenced ```sql block is taken whole; a fenced shell block is taken for the
 * body of each `<<'SQL'` heredoc, which is how `docs/development.md` writes the
 * same statements.
 *
 * Everything it does not understand is an error rather than a skip. A shell
 * block that mentions `psql` but carries no heredoc this can read — `psql -c`,
 * `<<EOF`, `<<-'SQL'` — would otherwise be statements an operator runs and this
 * ignores, which is the exact failure this file exists to prevent.
 */
function documentedSql(markdown: string, heading: string, document: string): [string, string] {
  const lines = markdown.split("\n").map((line) => line.replace(/\r$/, ""));
  const headings = lines.flatMap((line, index) => (line === heading ? [index] : []));
  if (headings.length === 0) throw new Error(`${document} has no section "${heading}".`);
  if (headings.length > 1) {
    throw new Error(`${document} has ${headings.length} sections called "${heading}".`);
  }

  const depth = heading.split(" ", 1)[0]!.length;
  const ends = new RegExp(`^#{1,${depth}} `);
  const heredoc = /<<'SQL'\n([\s\S]*?)\nSQL(\n|$)/g;

  const blocks: string[] = [];
  let language: string | null = null;
  let body: string[] = [];

  /** One fenced block: what of it is SQL to run, and what must not be missed. */
  const take = (source: string) => {
    if (language === "sql") {
      blocks.push(source);
      return;
    }
    for (const [, sql] of source.matchAll(heredoc)) blocks.push(sql!);
    // `psql -c '…'`, a `<<EOF`, a redirect from a file: forms an operator acts
    // on and this cannot read. Checked on what is left after the heredocs, so a
    // block carrying both is not excused by the half that was understood.
    if (setsUpPrivileges.test(source.replace(heredoc, " "))) {
      throw new Error(`${document}: SQL under "${heading}" that this cannot read:\n${source}`);
    }
  };

  for (const line of lines.slice(headings[0]! + 1)) {
    const boundary = fence.exec(line);
    if (language === null) {
      // A heading only ends the section outside a fence: a shell comment at the
      // start of a line looks exactly like one.
      if (ends.test(line)) break;
      if (boundary) {
        language = (boundary[1] || "").toLowerCase() || "text";
        body = [];
      }
      continue;
    }
    if (boundary) {
      take(body.join("\n"));
      language = null;
      continue;
    }
    body.push(line);
  }
  if (language !== null) {
    throw new Error(`${document}: an unterminated code fence under "${heading}".`);
  }

  // Two steps, always: what is run before the first migration, and what is
  // taken back once the tables exist. Any other count means the document
  // changed shape and this file is no longer reading it correctly.
  if (blocks.length !== 2) {
    throw new Error(
      `${document}: expected 2 SQL blocks under "${heading}", found ${blocks.length}.`,
    );
  }
  return [blocks[0]!, blocks[1]!];
}

/**
 * The documents name the database the deployment created; PGlite has its own.
 *
 * The only substitution made, and a narrow one: everything that decides whether
 * the setup works — every role name, grant, revoke and their order — is run
 * exactly as written. `\b` keeps it from touching `qualityruntime_staging` or
 * any other database name, which then fails loudly, as it should.
 */
const forThisDatabase = (sql: string, database: string) =>
  sql.replace(/ON DATABASE qualityruntime\b/g, `ON DATABASE "${database}"`);

const runtime = "qualityruntime";
const migrator = "qualityruntime_migrator";

const documents = [
  { path: "docs/deployment.md", heading: "### Two roles" },
  { path: "docs/development.md", heading: "## Database" },
] as const;

describe.each(documents)("the setup in $path", ({ path, heading }) => {
  it("creates the roles, applies the migrations, and runs the product", async () => {
    const markdown = await readFile(fileURLToPath(new URL(path, repository)), "utf8");
    const [before, after] = documentedSql(markdown, heading, path);

    const client = new PGlite();
    const db = drizzle({ client, schema, casing: "snake_case" });
    const [here] = (await client.query<{ name: string }>("select current_database() as name")).rows;

    // As a superuser, which is what both documents say this block needs.
    await client.exec(forThisDatabase(before, here!.name));

    // As the migrator: the tables it creates are the tables it owns, and the
    // default privileges set above are what carry them to the runtime role.
    await client.exec(`SET ROLE ${migrator};`);
    await migrate(db, { migrationsFolder });
    await client.exec("RESET ROLE;");

    await client.exec(forThisDatabase(after, here!.name));

    // Both roles are reached by a connection string, so both have to be able to
    // open one. `SET ROLE` works just as well without `LOGIN`, which is why
    // this is asserted rather than demonstrated.
    const attributes = {
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      // A replication connection streams the write-ahead log, which is every
      // tenant's rows with no policy anywhere in the path.
      rolreplication: false,
      rolcreaterole: false,
      rolcreatedb: false,
    };
    const { rows: roles } = await client.query<Record<string, unknown>>(
      `select rolname, ${Object.keys(attributes).join(", ")} from pg_roles
       where rolname in ($1, $2) order by rolname`,
      [runtime, migrator],
    );
    expect(roles).toEqual([
      { rolname: runtime, ...attributes },
      { rolname: migrator, ...attributes },
    ]);

    await client.exec(`SET ROLE ${runtime};`);
    // The server's own start-up check, on the role the document produced.
    await expect(assertTenantIsolation(db)).resolves.toBeUndefined();

    const app = createApp({
      db,
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

    const asJson = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

    const signedUp = await app.request(
      "/api/auth/sign-up/email",
      asJson({ name: "Ada", email: "ada@example.test", password: "correct horse" }),
    );
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");

    const created = await app.request("/api/auth/organization/create", {
      ...asJson({ name: "Acme", slug: "acme" }),
      headers: { "content-type": "application/json", cookie },
    });
    expect(created.status).toBe(200);
    const organizationId = (await json<{ id: string }>(created)).id;

    const base = `/api/v1/organizations/${organizationId}`;
    type Request = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
    const request = (suffix: string, init: Request = {}) =>
      app.request(`${base}${suffix}`, { ...init, headers: { cookie, ...init.headers } });

    // Every route there is, on privileges the document alone produced.
    const control = await request("/controls", asJson({ name: "Access review" }));
    expect(control.status).toBe(201);
    const controlId = (await json<{ data: { id: string } }>(control)).data.id;

    const activated = await request(`/controls/${controlId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(activated.status).toBe(200);

    const history = await request(`/history?resource=${controlId}`);
    expect(history.status).toBe(200);

    // The refusals the revoke block exists for.
    const refused = async (statement: string) => {
      const failure = await client.exec(statement).then(
        () => null,
        (error: Error) => error,
      );
      return failure?.message ?? "";
    };

    expect(await refused(`UPDATE "audit_event" SET "action" = 'rewritten'`)).toMatch(/denied/i);
    expect(await refused(`DELETE FROM "audit_event"`)).toMatch(/denied/i);
    expect(await refused(`UPDATE "file" SET "filename" = 'renamed'`)).toMatch(/denied/i);
    expect(await refused(`DELETE FROM "organization"`)).toMatch(/denied/i);

    await client.exec("RESET ROLE;");

    // `ALTER DEFAULT PRIVILEGES` decides what will be true of tables that do
    // not exist yet, and the bound below can only ask about tables that do. So
    // make the one the next migration would make, and bound that too.
    await client.exec(`SET ROLE ${migrator};`);
    await client.exec(`CREATE TABLE "the_next_migration" ("id" text primary key);`);
    await client.exec("RESET ROLE;");

    // And the bound, which is the half that catches a document granting *more*.
    // Asked of PostgreSQL rather than read off the statements, so it holds
    // however the privilege was arrived at.
    //
    // A role the runtime role is a *member* of is a role it can `SET ROLE` to,
    // and every `has_…_privilege` below follows inheritance only. A membership
    // granted `WITH INHERIT FALSE` carries every privilege of the table owner
    // and shows up in none of them, so it is asked about separately.
    const { rows: memberships } = await client.query<{ rolname: string }>(
      `select r.rolname from pg_roles r
       where r.rolname <> $1 and pg_has_role($1, r.oid, 'MEMBER')
       order by r.rolname`,
      [runtime],
    );
    expect(memberships).toEqual([]);

    // Every schema, not only `public`: `drizzle` is a schema the migrator
    // creates, and a table owned anywhere is a table outside the policies.
    const ordinary = `n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
                      and n.nspname not like 'pg\\_temp%' and n.nspname not like 'pg\\_toast%'`;

    const { rows: excess } = await client.query<{ relname: string; privilege: string }>(
      `select c.relname, p.privilege_type as privilege
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest(array[
         'TRUNCATE', 'REFERENCES', 'TRIGGER',
         'SELECT WITH GRANT OPTION', 'INSERT WITH GRANT OPTION',
         'UPDATE WITH GRANT OPTION', 'DELETE WITH GRANT OPTION'
       ]) as p(privilege_type)
       where ${ordinary} and c.relkind = 'r'
         and has_table_privilege($1, c.oid, p.privilege_type)
       order by c.relname, p.privilege_type`,
      [runtime],
    );
    expect(excess).toEqual([]);

    // Creating a table is how a role comes to own one, and owning one is how it
    // escapes the policies. Neither document may hand that over, in any schema.
    const { rows: creatable } = await client.query<{ nspname: string }>(
      `select n.nspname from pg_namespace n
       where ${ordinary} and has_schema_privilege($1, n.oid, 'CREATE')
       order by n.nspname`,
      [runtime],
    );
    expect(creatable).toEqual([]);

    const { rows: database } = await client.query<{ create: boolean }>(
      `select has_database_privilege($1, current_database(), 'CREATE') as create`,
      [runtime],
    );
    expect(database[0]).toEqual({ create: false });

    const { rows: owned } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles r on r.oid = c.relowner
       where ${ordinary} and r.rolname = $1
       order by c.relname`,
      [runtime],
    );
    expect(owned).toEqual([]);

    await client.close();
  }, 60_000);
});

/**
 * The other document a deployment copies rather than reads.
 *
 * `.env.example` is where an operator starts, so a setting the code requires and
 * the example omits is a server that will not boot, discovered at boot. Derived
 * from the source rather than listed here, so neither side can drift alone.
 */
describe(".env.example", () => {
  /**
   * Every environment variable this repository reads.
   *
   * Found by looking rather than by keeping a list: a list is a thing to forget
   * to add to, and the setting that goes missing from the example is the one
   * nobody thought about. Source files and the one test that needs a database
   * of its own; `node_modules` and build output are not ours to scan.
   */
  const named = async () => {
    const found = new Set<string>();
    const roots = [new URL("apps/", repository), new URL("packages/", repository)];
    const walk = async (directory: URL): Promise<void> => {
      for (const entry of await readdir(fileURLToPath(directory), { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
        if (entry.isDirectory()) {
          await walk(child);
        } else if (entry.name.endsWith(".ts")) {
          const text = await readFile(fileURLToPath(child), "utf8");
          const reads = [
            /requireEnv\("([A-Z_]+)"\)/g,
            /(?:process|Bun)\.env\.([A-Z_]+)/g,
            /(?:process|Bun)\.env\["([A-Z_]+)"\]/g,
          ];
          for (const pattern of reads) {
            for (const [, name] of text.matchAll(pattern)) if (name) found.add(name);
          }
        }
      }
    };
    for (const root of roots) await walk(root);
    return found;
  };

  it("names every setting the server reads, and nothing it does not", async () => {
    const example = await readFile(fileURLToPath(new URL(".env.example", repository)), "utf8");
    // A commented-out key still documents the setting; it marks it optional.
    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z_]+)=/gm)].map(([, name]) => name!),
    );

    const required = await named();
    expect([...required].filter((name) => !documented.has(name)).sort()).toEqual([]);
    expect([...documented].filter((name) => !required.has(name)).sort()).toEqual([]);
  });
});
