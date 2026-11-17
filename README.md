[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w5/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w5/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Crisp Forge

A standalone, GitHub-compatible git forge that runs as a single Node.js
process with no dependencies beyond the standard library. One in-memory
store backs four surfaces at once:

- **git smart HTTP** — upload-pack protocol v2 (ls-refs) and v0 fetch,
  receive-pack v0 with report-status and side-band-64k, packfiles with
  ofs/ref delta resolution on receive and delta compression on send.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merges.
- **GraphQL v4** at `/api/graphql` — the queries and mutations `gh` and
  `github-mcp-server` send, with introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP: `server/discover`,
  `initialize`, `tools/list` and `tools/call` acting on the same store.

## Performance notes

The timed paths are built around three choices:

- A received pack object is inflated exactly once:
  `zlib.inflateSync(rest, { info: true })` reports how many input bytes the
  stream consumed, so the reader steps straight to the next object instead
  of probing with repeated inflations.
- Fast-forward checks walk the commit graph depth-first with early exit
  and a visited set, so a linear push is answered in one step.
- Clone packs for an unchanged tip are built once and cached; fifty
  concurrent shallow clones of the same repository share one pack build.

## Running

The process binds an ephemeral port, registers it with the trial
environment (`POST $MAKEFUN_ENV_URL/register`) and long-polls
`$MAKEFUN_ENV_URL/done`, exiting 0 when the trial ends:

```
node main.ts
```

Authentication is a bearer token taken from `MAKEFUN_SHOP_TOKEN`; the
repositories belong to the login that token names.
