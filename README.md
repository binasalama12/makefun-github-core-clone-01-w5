# github-core-clone-01 — the crisp-owl forge

A standalone, GitHub-compatible git forge, built as one Node 22 process with the standard
library only: no dependencies, no git binary, no network beyond the trial env it registers with.
This is wallet **crisp-owl-96**'s entry (variant w5).

## Run it

```sh
node main.ts
```

Node 22.18+ strips the TypeScript types itself. The process needs two environment variables,
both set by the harness in a trial:

- `MAKEFUN_ENV_URL` — the env's origin. The entry binds an ephemeral port, POSTs
  `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until it
  answers `{"done": true}` and exits 0.
- `MAKEFUN_SHOP_TOKEN` — the bearer token every API surface requires.

`MAKEFUN_TRIAL_NOW`, when present, is the only clock the forge reads: every timestamp it
serves derives from that instant plus a per-write sequence tick, so a run and its replay serve
byte-identical data.

## Design

The forge is **GraphQL-first**. One resolver core (`core.ts`) owns the whole domain —
repositories, labels, issues, comments, pull requests, merges and the git object store — as
pure functions over an immutable state snapshot: a mutation derives the next snapshot
(copy-on-write down to the one touched repository record) and never edits a snapshot in place.

Every surface is a thin adapter over that core, so ids and numbers are the same everywhere:

- `graphql.ts` — the GraphQL v4 executor at `POST /api/graphql`: a small typed schema
  (viewer, repository, node, issues/pullRequests connections with cursor pagination,
  createIssue/closeIssue/createPullRequest/mergePullRequest/addComment mutations, and the
  `__type` introspection gh feature-detects with). This is the primary API.
- `app.ts` — the REST v3 adapter under `/api/v3` (repositories, contents, labels, issues,
  comments, pull requests, branches, commits, git refs) plus the HTTP routing, the `/mcp`
  endpoint's transport, and the lifecycle probe at `GET /healthz`.
- `mcp.ts` — the Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable HTTP,
  `server/discover` (2026-07-28) and the `initialize` handshake (2025-11-25), with
  `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request` tools acting on the same store.
- `git.ts` — git smart HTTP at `/{owner}/{repo}.git`: a real object store (SHA-1 via
  `node:crypto`, zlib via `node:zlib`) with packfile reading (ofs/ref deltas) and writing,
  protocol v2 upload-pack (`ls-refs`, `fetch` with shallow/deepen), a v0 upload-pack fallback
  with side-band-64k, and v0 receive-pack with `report-status`, per-ref fast-forward
  enforcement and delete support.

Authentication: every surface requires `Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>`; a
repository belongs to the login the token names, and the same name under another owner is a
404, never a 403.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll done, exit).
- `app.ts` — HTTP server, REST v3 adapters, git/GraphQL/MCP routing.
- `core.ts` — the resolver core: immutable store, git object model, domain resolvers.
- `git.ts` — pkt-lines, packfiles, smart-HTTP protocol handlers.
- `graphql.ts` — GraphQL lexer/parser and executor.
- `mcp.ts` — MCP discovery, handshake and tools.
- `restjson.ts` — the GitHub v3 JSON shapes shared by REST and MCP.
