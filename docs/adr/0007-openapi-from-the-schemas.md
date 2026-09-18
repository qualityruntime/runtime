# 7. OpenAPI is assembled from the schemas, not by a framework

Date: 2026-09-18

## Status

Accepted

## Context

`/api/v1` has five operations across two resources, and one of its stated aims is that AI clients can understand and operate it. A machine-readable description is how that stops being a claim.

Requests were already described in code: every body and query has a Zod schema that the server enforces. Responses were not — they were whatever the handler happened to return, guarded by a hand-written list of expected keys in a test.

Three ways to publish a document were considered:

- **`@hono/zod-openapi`** — routes are declared through its `createRoute` and `OpenAPIHono`, and the document falls out.
- **`hono-openapi`** — routes stay as they are and each gains a `describeRoute(…)` annotation.
- **Assemble it here**, from the schemas the routes already use.

## Decision

Assemble it. `apps/server/openapi.ts` builds the document from the same Zod schemas the routes validate against, and serves it at `/api/v1/openapi.json`.

Zod 4 converts a schema to JSON Schema itself — `z.toJSONSchema` — and OpenAPI 3.1 _is_ JSON Schema draft 2020-12, so the step a library would perform is one function call. `io: "input"` matters: a cursor is a string on the wire and a decoded position afterwards, and describing the output side would tell clients to send something they cannot send.

**The drift a library prevents is prevented by a test instead.** That is the real trade, so it is worth being concrete about. `openapi.test.ts` derives the operations the app actually registers from `app.routes` and requires the document to describe exactly those — no more, no fewer. A route added without an operation fails the suite, which is the guarantee `describeRoute` gives by construction.

Tests validate representative responses against the published schemas using a JSON Schema validator, including error responses such as 400, 401, 404, 409 and 413. Request examples check that the published constraints accept valid inputs and reject invalid ones. This checks the emitted contract as a client sees it; it does not prove equivalence for every possible request or response.

**Express constraints in JSON Schema where possible.** `z.toJSONSchema` drops a `refine` silently, which is the subtle failure here: the server keeps rejecting, the document stops saying so, and a client builds requests that cannot work. So the rules are written in forms JSON Schema has: a `pattern` for "no NUL" rather than a refinement; an `anyOf` over `name`, `description` and `status` restated through `meta` for "at least one field to change", since `minProperties` would count an unknown property the server drops; and a `\S` pattern so a name of only spaces is refused by the published schema and not merely after trimming.

Rules that the emitted schema does not express remain runtime checks and are explained in `description`. Cursor decoding is one example: the published schema describes a string, while the server also checks its encoding, ordering and key. The description directs clients to use the `nextCursor` of a previous page.

The same concern decides where trimming happens. Length and pattern are checked against what the client sent and the value is trimmed afterwards; trimming first would publish bounds describing a string nobody sent, and a name of 200 characters with a space in front would be accepted by the server and refused by its own schema.

**`@hono/zod-openapi` was rejected as too large a commitment** for what it delivers here. It decides how every route in the codebase is written, for a document; if it were later abandoned, every route would be rewritten. **`hono-openapi` was rejected on dependencies**: it is a reasonable library, but it brings a chain of young transitive packages, and a compliance product has a poor argument for adding supply chain to emit a JSON file it can already emit.

Neither rejection is permanent. The routes are untouched by this decision — only `openapi.ts` knows about the document — so adopting a library later costs deleting one module.

Some smaller choices:

**Response shapes became Zod schemas.** This is the substantive part, and would have been worth doing without a document: `controlResponse` and `auditEventResponse` are strict, so they describe the contract exactly and a test catches a field appearing or disappearing. The key-set assertion they replace could only ever check names.

**Path parameters are derived from the path.** The `{name}` segments are read out of the path string and given the pattern `packages/db/id.ts` generates for that kind of identifier, so a parameter cannot be left undescribed and the pattern cannot disagree with the CHECK constraint.

**Schemas are inlined rather than collected under `components`.** Hand-written `$ref`s would be a second description of the same thing to keep in step. The document repeats itself; nothing that reads it minds.

**No `servers`.** A client has the URL it fetched the document from, and any value here would be wrong behind a proxy.

**The published cookie name comes from Better Auth, not from a string here.** It prefixes the session cookie with `__Secure-` when the base URL is HTTPS, so a fixed name would be right in development and wrong in every deployment.

**The document needs no session.** It describes the API, not anyone's data, and a client that cannot read it before signing in is harder to use for no benefit.

## Consequences

Adding an operation means adding it in two places — the route and the operations list — and the suite fails until both exist. That is the cost of not having a library, paid at the moment the work is being done rather than discovered later by a client.

`ajv` is a test dependency, for validating the document the way a client would read it. Nothing at runtime depends on it.

Response schemas are documentation and test material, not runtime validation. Handlers do not parse what they return: it would cost something on every request to catch a class of bug the tests already catch, and a schema that throws in production turns a wrong field into an outage.

`/api/auth` is not described. It is Better Auth's API with its own contract and its own documentation, and copying it here would create a second description to keep current.

The document has no `info.version` that means anything yet — it says `0`, which is honest while the API is not stable. Versioning it is a decision for the first release, and `/api/v1` in the path is not that decision.
