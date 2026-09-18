# Security

The security model: trust boundaries, authentication, authorization, tenant isolation, file access, secrets, and AI and dependency security.

For vulnerability reporting, see [`.github/SECURITY.md`](../.github/SECURITY.md).

## Tenant authorization

`session.activeOrganizationId` records which tenant a request is acting in. It is **context, not authorization**. Tenant authorization must use the caller’s current `member` row — membership and role — resolved per request (TENANT-01).

Never treat possession of a session carrying an organization id as proof of access to that organization, and never filter by it alone.
