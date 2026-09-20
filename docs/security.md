# Security

The security model: trust boundaries, authentication, authorization, tenant isolation, file access, secrets, and AI and dependency security.

For vulnerability reporting, see [`.github/SECURITY.md`](../.github/SECURITY.md).

## Tenant authorization

A request names the organization it acts in **in its path** — `/api/v1/organizations/{organizationId}/…` — and `organizationContext` resolves that to the caller's `member` row before any handler runs ([ADR 0004](adr/0004-organization-in-the-request-path.md)). Membership, resolved per request, authorizes domain API access (TENANT-01); these handlers do not yet restrict actions by role. A caller who is not a member gets 404 rather than 403, so an identifier cannot be probed for membership.

`session.activeOrganizationId` is a different thing: the organization the user last selected, remembered so a UI can offer it again. It is **a preference, not a scope and not a permission** — the routes never read it, and nothing should treat possession of a session carrying an organization id as proof of access to that organization, or filter by it alone.

## Tenant isolation

Authorization decides whether a caller may act in an organization. Isolation makes the answer stick: once a request is scoped to an organization, the database will not let it read or write outside one.

The two are not interchangeable. Isolation contains a query that forgets its tenant predicate, and a code path that reaches a tenant-owned table with no tenant context at all. It does **not** second-guess the authorization decision — hand `withOrganization` an organization the caller has no membership in and it will faithfully scope to that organization. Resolving the caller's `member` row remains the thing that decides access.

PostgreSQL enforces it. Every tenant-owned table has row-level security enabled and forced, with a policy comparing `organization_id` to a transaction-local setting, and domain code reaches those tables only through `withOrganization`:

```ts
const controls = await withOrganization(db, organizationId, (tx) => tx.select().from(control));
```

A transaction with no organization set sees nothing and can write nothing, so forgetting the context fails closed. [ADR 0003](adr/0003-tenant-isolation-with-row-level-security.md) records the design and its limits.

**The application must connect to PostgreSQL as a non-superuser role without `BYPASSRLS`.** PostgreSQL exempts both from every policy, and no migration can prevent it. The server checks at startup and refuses to run as either, with `row_security = off`, or when row security is not enabled and forced on every domain table. See [deployment](deployment.md).

Better Auth's tables are outside this: it resolves a user's memberships before any organization is known, so `member` and `invitation` carry no policy and are reached through Better Auth's own authorization.

`audit_event` is isolated the same way but narrower: its policies name `SELECT` and `INSERT` and nothing else, so a tenant can read and add to its history and no application code path can rewrite or erase it ([ADR 0005](adr/0005-audit-history.md)).

**Any member can read all of it.** `GET /history` serves the organization's whole audit history — actor labels, impersonation attribution, and the `before`/`after` of every change, including records since deleted ([ADR 0018](adr/0018-one-history-rather-than-one-per-record.md)). Membership is the authorization boundary for the domain API; its handlers do not gate actions on `member.role`. Better Auth applies its own authorization to organization administration. That is a deliberate widening and the first place a reader-level role would be needed. Row security does not govern `TRUNCATE` or a table owner's privileges, so protecting the history from the runtime role itself is a matter of grants — see [deployment](deployment.md).

Three other tables name their commands rather than covering them all at once, and in each case the `DELETE` policy — or its absence — is where the rule lives. `evidence` admits only unattested rows, so what was signed cannot be removed ([ADR 0012](adr/0012-evidence-and-attestation.md)); `file` has no `DELETE` policy at all, and a trigger refuses an attachment to attested evidence ([ADR 0013](adr/0013-durable-storage.md)). `control` admits only a draft, and a draft is held to be one that never took effect: a trigger owns `activated_at` and a CHECK ties a draft to its being null, so nothing that was in effect can become a draft again ([ADR 0017](adr/0017-discarding-a-draft-control.md)). In each case a route answers with something a caller can act on, and the policy is what makes the rule true.

## File access

File bytes are the one thing this product holds that PostgreSQL does not. They live in an S3-compatible bucket, and a client's transfers go between the client and that bucket directly — never through the application ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)). The application makes one read of its own, to measure the object it is about to record; no request or response it serves carries a file. So the boundary is drawn with capabilities rather than with a session.

**Every capability is issued after an authorization decision, and is narrow, short-lived, and one-directional.** Preparing an upload resolves the evidence in the caller's tenant context first, and the URL it answers with is a `PUT` to one temporary key — `uploads/{uploadId}` — for fifteen minutes. Downloading resolves the `file` row in the caller's tenant context first, and answers `303` to a `GET` of one permanent key for a minute. A file belonging to another organization is a 404 exactly as one that does not exist, so an identifier cannot be probed.

**A client following the redirect must not carry its credentials to the store.** The URL needs none — it carries its own authorization, which is the point.

A browser is protected by the cookie's `Path`, not by the store being a different origin — cookies are not scoped by port, so a store on another port of this host would otherwise be sent the session cookie. Every route here is under `/api` and the cookie carries `Path=/api`, which keeps it off a bucket's `/files/…`.

That is depth, not a boundary: RFC 6265 is explicit that a path gives no integrity between services sharing a host, since a response under one path may set a cookie for another. The boundary is a hostname of the store's own, which production should use — and it holds because the session cookie sets no `Domain` and so reaches that one host only. Startup refuses the configuration where depth would not help either: a bucket whose URL is this host at `/api` or below. That is judged on `{endpoint}/{bucket}` together, since a bucket named `api` puts a download there as surely as an endpoint path does.

What a separate hostname buys is confidentiality of the credential, and not integrity: RFC 6265 gives no integrity between siblings either, so `storage.example.com` could set `Domain=example.com` and have that cookie reach the application afterwards. A store is trusted infrastructure here, not a mutually distrusting origin. Where it must be one, it belongs on a different registrable domain — which is the shape a provider's own domain already has.

**Both browser-facing origins use TLS in production.** A presigned URL is a bearer credential and what it carries is evidence, so the application and the object store are both `https://` wherever a browser reaches them. Plain HTTP is for local development, and nothing enforces this: a self-hoster on an isolated network may decide otherwise, and no runtime check can tell that network from a careless one.

A script is on its own: `curl -L` re-sends a header given with `-H` to whatever host a redirect names, which would put a session cookie in the object store's access log. `docs/development.md` shows the two-request form that does not. The redirect itself carries `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and the object is stored with `Cache-Control: private, no-store` so the download it points at is not retained either.

**An authorized member is trusted not to abuse the upload capability.** Preparing an upload is cheap and repeatable, and a signed PUT is signed for a key and a method rather than for a size — so a member can start as many uploads as they like and send more than a file may be to each. Completion refuses those bytes, and a lifecycle rule on `uploads/` expires them, but nothing bounds the rate or the volume. That is a quota, and a quota belongs where membership is decided: a hosted offering needs one before it opens, and a deployment whose members are its own staff does not ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)).

**No permanent key is ever signed for writing.** A presigned URL stays usable until it expires, so one issued for `files/{fileId}` would be a standing licence to replace the bytes of a record that may since have been attested. The runtime copies the validated object to its permanent key itself, with its own credentials, and the client never holds a write capability for it.

**The bucket is private, and its contents are not this origin's to render.** Nothing is readable without a signed URL. Permanent objects are stored as `application/octet-stream` with `Content-Disposition: attachment`, fixed into the object when it is promoted. The name is written twice: `filename` reduced to printable ASCII, and `filename*` percent-encoded UTF-8, so the real name survives without a character that could end the header. A tenant's filename is part of a response header by design; what it cannot do is add one, end one, or decide any other. Nor can a declared media type: a file cannot be served back as a page. The declared content type survives on the row and in the API, where it is data.

**The checksum is what makes tampering detectable.** A bucket has no row-level security to lean on: whatever can write to it can change what an attested record's file says, and the row would go on describing the file it used to be. So the SHA-256 on every `file` row is computed by this server from the object it stored, and `bun run verify:files` recomputes it ([ADR 0016](adr/0016-verifying-stored-bytes.md)).

It covers bytes and nothing else. Neither a SHA-256 nor an entity tag reflects metadata, so a writer could keep the bytes and change how the object is served: this is byte-integrity verification, not whole-object verification.

Write authority on the bucket is therefore outside the boundary, including while a file is being created. A privileged writer could give a just-promoted object a `Content-Encoding` without touching its bytes — the entity tag the completion pins to would still match, and what the runtime measured would be a decoded representation rather than the stored octets. That is the same authority that can replace an attested file's bytes outright. Give the runtime a key pair scoped to the bucket, and do not hand that pair out.

Surviving a change rather than only detecting it is the bucket's own configuration — versioning, object lock — and belongs to whoever owns it. Object lock protects a version and not a key, so a writer can still make a newer version current; what it buys is that the original is there to restore once `verify:files` reports the mismatch. See [deployment](deployment.md).

**Post-upload validation is deliberate, and it has a cost.** Size is measured from the stored object after the bytes arrive, not taken from anything the client declared. A declared size buys an early refusal, and a caller that declares nothing or lies can spend the bucket's bandwidth before being refused. That caller is already an authorized member of the organization, the window is short, and a lifecycle rule on `uploads/` bounds what is left behind.
