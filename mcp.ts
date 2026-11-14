// mcp.ts — the Model Context Protocol endpoint (JSON-RPC 2.0 over Streamable HTTP). The tools are
// one more adapter over core.ts: a repository or issue created here is the same record REST and
// GraphQL read, with the same ids. Both protocol eras the suite accepts are served: the modern
// server/discover revision (2026-07-28) and the legacy initialize handshake (2025-11-25).

import {
  coreCreateIssue,
  coreCreatePull,
  coreCreateRepo,
  coreMergePull,
  isError,
  listIssues,
  resolveRepo,
  type State,
} from './core.ts';
import { issueJson, pullJson, repoJson } from './restjson.ts';

export const MCP_SERVER_INFO = { name: 'crisp-owl-forge', version: '1.0.0' };
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
  readonly run: (state: State, args: Record<string, unknown>) => { state: State; value: unknown } | { error: string };
}

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === 'string' ? (args[key] as string) : '';

/** Split an "owner/repo" full_name argument when the caller sent one instead of the parts. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = str(args, 'owner');
  let repo = str(args, 'repo');
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const slash = (args.full_name as string).indexOf('/');
    if (slash !== -1) {
      owner = owner === '' ? (args.full_name as string).slice(0, slash) : owner;
      repo = repo === '' ? (args.full_name as string).slice(slash + 1) : repo;
    }
  }
  return { owner, repo };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (state, args) => {
      const result = coreCreateRepo(state, {
        name: str(args, 'name'),
        description: str(args, 'description'),
        isPrivate: args.private === true,
      });
      if (isError(result)) return { error: result.error.message };
      return { state: result.state, value: repoJson(result.value) };
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/repo pair, as an alternative to owner and repo.' },
    },
    required: ['owner', 'repo'],
    run: (state, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = resolveRepo(state, owner, repo);
      if (found === null) return { error: `repository ${owner}/${repo} not found` };
      return { state, value: repoJson(found) };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      full_name: { type: 'string', description: 'The owner/repo pair, as an alternative to owner and repo.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (state, args) => {
      const { owner, repo } = ownerRepo(args);
      const result = coreCreateIssue(state, owner, repo, { title: str(args, 'title'), body: str(args, 'body') });
      if (isError(result)) return { error: result.error.message };
      const fresh = resolveRepo(result.state, owner, repo);
      return { state: result.state, value: issueJson(fresh as never, result.value) };
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      full_name: { type: 'string', description: 'The owner/repo pair, as an alternative to owner and repo.' },
    },
    required: ['owner', 'repo'],
    run: (state, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = resolveRepo(state, owner, repo);
      if (found === null) return { error: `repository ${owner}/${repo} not found` };
      const wanted = str(args, 'state');
      const filter = wanted === 'closed' ? 'closed' : wanted === 'all' ? 'all' : 'open';
      const issues = listIssues(found, { state: filter, direction: 'asc' }).map((issue) => issueJson(found, issue));
      return { state, value: issues };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
      full_name: { type: 'string', description: 'The owner/repo pair, as an alternative to owner and repo.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (state, args) => {
      const { owner, repo } = ownerRepo(args);
      const result = coreCreatePull(state, owner, repo, {
        title: str(args, 'title'),
        body: str(args, 'body'),
        head: str(args, 'head'),
        base: str(args, 'base'),
      });
      if (isError(result)) return { error: result.error.message };
      const fresh = resolveRepo(result.state, owner, repo);
      return { state: result.state, value: pullJson(fresh as never, result.value) };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
      full_name: { type: 'string', description: 'The owner/repo pair, as an alternative to owner and repo.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (state, args) => {
      const { owner, repo } = ownerRepo(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const result = coreMergePull(state, owner, repo, number);
      if (isError(result)) return { error: result.error.message };
      const fresh = resolveRepo(result.state, owner, repo);
      return { state: result.state, value: { ...pullJson(fresh as never, result.value.pull), sha: result.value.sha, merged: true } };
    },
  },
];

/** The tools/list payload: a constant, so two calls answer byte for byte. */
export const TOOLS_LIST = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.properties).map(([key, value]) => [key, { type: value.type, description: value.description }]),
      ),
      required: [...tool.required],
      additionalProperties: true,
    },
  })),
};

export interface McpOutcome {
  readonly status: number;
  readonly body: unknown; // null means "no body" (a 202 notification answer)
}

/** Handle one JSON-RPC message; pure with respect to the store snapshot it is handed. */
export function handleMcpMessage(
  state: State,
  setState: (next: State) => void,
  message: Record<string, unknown>,
): McpOutcome {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const isNotification = id === undefined || id === null;
  const ok = (result: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } });
  const rpcError = (code: number, text: string): McpOutcome => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message: text } },
  });

  if (method === 'server/discover') {
    return ok({
      resultType: 'complete',
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP, REST and GraphQL on one store.',
    });
  }
  if (method === 'initialize') {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const version = MCP_SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
    return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO });
  }
  if (method.startsWith('notifications/')) return { status: 202, body: null };
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok(TOOLS_LIST);
  if (method === 'tools/call') {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return rpcError(-32602, `unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    for (const required of tool.required) {
      if (args[required] === undefined || args[required] === '') {
        return ok({
          content: [{ type: 'text', text: `missing required argument: ${required}` }],
          isError: true,
        });
      }
    }
    const result = tool.run(state, args);
    if ('error' in result) {
      return ok({ content: [{ type: 'text', text: result.error }], isError: true });
    }
    setState(result.state);
    const value = result.value;
    return ok({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    });
  }
  if (isNotification) return { status: 202, body: null };
  return rpcError(-32601, `method not found: ${method}`);
}
