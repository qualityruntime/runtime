# 15. A rendered API reference

Date: 2026-09-18

## Status

Accepted

## Context

[ADR 0007](0007-openapi-from-the-schemas.md) published an OpenAPI document at `/api/v1/openapi.json` and ended with the open question: _serve the document, and decide whether anything renders it._

A JSON document is what a client reads. It is not what a person reads when they are working out whether this API can do what they need, and "AI-native" is not an argument against a human being able to look.

## Decision

`@scalar/hono-api-reference` renders the document at `/api/v1/reference`.

It takes the document **by URL**, so nothing about how the document is built depends on it — this decision is entirely downstream of ADR 0007 and leaves it untouched. Removing it costs deleting one route.

It is public, like the document. It describes the API, not anyone's data, and a reference a client cannot read before signing in is harder to use for no benefit.

**The page loads its bundle from a CDN, and that is worth knowing.** Scalar's rendered HTML fetches `@scalar/api-reference` from jsDelivr. For a product whose point is that self-hosting should be boring, a page that quietly reaches the public internet is a poor default to leave undocumented — an air-gapped deployment gets a blank page and no explanation. `API_REFERENCE_BUNDLE_URL` overrides it, and `docs/deployment.md` says so.

## Consequences

One dependency, with one of its own, for a page. That is a real cost for something no code path depends on, and it is why the integration is a single route rather than anything structural.

The reference is only as good as the document, which is only as good as the operations list `openapi.ts` maintains — and that list is checked against the routes the app actually registers. So a route that is missing from the reference fails the suite rather than quietly going undocumented.

Nothing self-hosts the bundle. `API_REFERENCE_BUNDLE_URL` lets a deployment point at its own copy, but this repository does not produce one, and doing so would mean serving a JavaScript bundle it does not build.
