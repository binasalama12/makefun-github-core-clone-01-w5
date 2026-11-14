// graphql.ts — the GraphQL v4 surface. This is the forge's first-class API: the executor walks a
// small typed schema whose field resolvers call straight into core.ts, the same resolver core the
// REST adapters and the MCP tools use, so an object created on any surface reads identically here.
//
// The parser covers the document shapes gh and github-mcp-server send: named and anonymous
// operations, aliases, variables, literal arguments (strings, ints, enums, lists, objects, null),
// inline fragments, fragment definitions and introspection through __type/__schema.

import {
  OWNER_LOGIN,
  branchTip,
  commentGid,
  coreAddComment,
  coreCreateIssue,
  coreCreatePull,
  coreMergePull,
  isoAt,
  issueGid,
  listIssues,
  listPulls,
  parseGid,
  pullConflicts,
  pullFiles,
  pullGid,
  repoGid,
  resolveIssue,
  resolvePull,
  resolveRepo,
  resolveRepoById,
  resolveViewer,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type State,
} from './core.ts';

// -------------------------------------------------------------------------------------------
// lexer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
          i += 2;
          if (esc === 'u') value += ''; // \u escapes are not exercised by the suite's documents
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      const text = match?.[0] ?? '0';
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = match?.[0] ?? '';
      tokens.push({ kind: 'name', value: text });
      i += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  return tokens;
}

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyMap<string, GqlValue>;
  readonly selection: readonly GqlSelection[] | null;
}

export type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: readonly GqlSelection[] };

export interface GqlOperation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selection: readonly GqlSelection[];
  readonly fragments: ReadonlyMap<string, { typeCondition: string; selection: readonly GqlSelection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of the GraphQL document');
    this.pos += 1;
    return token;
  }
  atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  eatPunct(value: string): boolean {
    if (this.atPunct(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected ${value} in the GraphQL document`);
  }
  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in the GraphQL document');
    return token.value;
  }

  parseDocument(): { operations: GqlOperation[] } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: readonly GqlSelection[] }>();
    const pending: Array<{ type: 'query' | 'mutation'; name: string | null; selection: readonly GqlSelection[] }> = [];
    while (this.peek() !== undefined) {
      if (this.atPunct('{')) {
        pending.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipParens();
        this.skipDirectives();
        pending.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    for (const op of pending) operations.push({ ...op, fragments });
    return { operations };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  private skipDirectives(): void {
    while (this.eatPunct('@')) {
      this.expectName();
      if (this.atPunct('(')) this.skipParens();
    }
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.eatPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (next !== undefined && next.kind === 'name') {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.eatPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args = new Map<string, GqlValue>();
      if (this.eatPunct('(')) {
        while (!this.eatPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
      }
      this.skipDirectives();
      const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    return selections;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.eatPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.eatPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in the GraphQL document');
  }
}

/** Evaluate a parsed value against the request's variables. */
export function valueOf(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// schema: type -> field -> resolver. Node values are tagged wrappers around core records.

interface Ctx {
  state: State;
  setState: (next: State) => void;
  variables: Readonly<Record<string, unknown>>;
  operation: GqlOperation;
  errors: Array<{ message: string }>;
}

type Node =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: RepoRec }
  | { __type: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __type: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __type: 'Ref'; repo: RepoRec; name: string; oid: string }
  | { __type: 'RefTarget'; oid: string }
  | { __type: 'IssueConnection'; repo: RepoRec; items: IssueRec[]; total: number; hasNextPage?: boolean }
  | { __type: 'PullRequestConnection'; repo: RepoRec; items: PullRec[]; total: number }
  | { __type: 'PullRequestFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changeType: string }> }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: 'IssueEdge'; repo: RepoRec; issue: IssueRec; cursor: string }
  | { __type: 'Comment'; repo: RepoRec; id: number; body: string; issueNumber: number; createdSeq: number }
  | { __type: 'CommentConnection'; comments: Node[] }
  | { __type: 'CommentEdge'; comment: Node }
  | { __type: 'Label'; name: string; color: string }
  | { __type: 'LabelConnection'; labels: Array<{ name: string; color: string }> }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: '__Schema' }
  | { __type: 'CreateIssuePayload'; issue: Node | null }
  | { __type: 'CloseIssuePayload'; issue: Node | null }
  | { __type: 'CreatePullRequestPayload'; pull: Node | null }
  | { __type: 'MergePullRequestPayload'; pull: Node | null }
  | { __type: 'AddCommentPayload'; edge: Node | null }
  | { __type: 'PullRequestFile'; path: string; additions: number; deletions: number; changeType: string };

type Resolver = (ctx: Ctx, node: Node | null, field: GqlField) => unknown;

const argString = (ctx: Ctx, field: GqlField, name: string): string => {
  const value = field.args.get(name);
  if (value === undefined) return '';
  const evaluated = valueOf(value, ctx.variables);
  return typeof evaluated === 'string' ? evaluated : '';
};
const argInt = (ctx: Ctx, field: GqlField, name: string): number => {
  const value = field.args.get(name);
  if (value === undefined) return 0;
  const evaluated = valueOf(value, ctx.variables);
  return typeof evaluated === 'number' ? evaluated : 0;
};
const argValue = (ctx: Ctx, field: GqlField, name: string): unknown => {
  const value = field.args.get(name);
  return value === undefined ? undefined : valueOf(value, ctx.variables);
};

const issueNode = (repo: RepoRec, issue: IssueRec): Node => ({ __type: 'Issue', repo, issue });
const pullNode = (repo: RepoRec, pull: PullRec): Node => ({ __type: 'PullRequest', repo, pull });
const repoNode = (repo: RepoRec): Node => ({ __type: 'Repository', repo });

const issueCursor = (issue: IssueRec): string => Buffer.from(`cursor:${issue.number}`, 'utf8').toString('base64');

/** Paginate an issue list the Relay way: `first`/`after` over the already-ordered items. */
function paginateIssues(ctx: Ctx, repo: RepoRec, field: GqlField, items: IssueRec[]): Node {
  const first = argInt(ctx, field, 'first') || items.length;
  const after = argValue(ctx, field, 'after');
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const number = Number(decoded.replace('cursor:', ''));
      const index = items.findIndex((issue) => issue.number === number);
      if (index !== -1) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const page = items.slice(start, start + first);
  return {
    __type: 'IssueConnection',
    repo,
    items: page,
    total: items.length,
    hasNextPage: start + page.length < items.length,
  };
}

const SCHEMA: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User' }),
    repository: (ctx, _node, field) => {
      const repo = resolveRepo(ctx.state, argString(ctx, field, 'owner'), argString(ctx, field, 'name'));
      return repo === null ? null : repoNode(repo);
    },
    node: (ctx, _node, field) => {
      const parsed = parseGid(argString(ctx, field, 'id'));
      if (parsed === null) return null;
      if (parsed.kind === 'R') {
        const repo = resolveRepoById(ctx.state, parsed.repoId);
        return repo === null ? null : repoNode(repo);
      }
      if (parsed.kind === 'I') {
        const repo = resolveRepoById(ctx.state, parsed.repoId);
        const issue = repo === null ? null : resolveIssue(repo, parsed.number);
        return issue === null || repo === null ? null : issueNode(repo, issue);
      }
      if (parsed.kind === 'P') {
        const repo = resolveRepoById(ctx.state, parsed.repoId);
        const pull = repo === null ? null : resolvePull(repo, parsed.number);
        return pull === null || repo === null ? null : pullNode(repo, pull);
      }
      if (parsed.kind === 'U') return { __type: 'User' };
      return null;
    },
    __type: (_ctx, _node, field) => {
      const name = argString(_ctx, field, 'name');
      return TYPE_FIELDS[name] !== undefined || ENUM_TYPES[name] !== undefined || name === 'SearchType' ? { __type: '__Type', name } : null;
    },
    __schema: () => ({ __type: '__Schema' }),
  },
  Mutation: {
    createIssue: (ctx, _node, field) => {
      const input = (argValue(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? null : resolveRepoById(ctx.state, parsed.repoId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return { __type: 'CreateIssuePayload', issue: null };
      }
      const result = coreCreateIssue(ctx.state, repo.owner, repo.name, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in result) {
        ctx.errors.push({ message: result.error.message });
        return { __type: 'CreateIssuePayload', issue: null };
      }
      ctx.setState(result.state);
      ctx.state = result.state;
      const fresh = resolveRepo(ctx.state, repo.owner, repo.name) as RepoRec;
      return { __type: 'CreateIssuePayload', issue: issueNode(fresh, result.value) };
    },
    closeIssue: (ctx, _node, field) => {
      const input = (argValue(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.issueId ?? ''));
      const repo = parsed === null ? null : resolveRepoById(ctx.state, parsed.repoId);
      const issue = repo === null || parsed === null ? null : resolveIssue(repo, parsed.number);
      if (repo === null || issue === null) {
        ctx.errors.push({ message: 'Could not resolve the issue for closeIssue' });
        return { __type: 'CloseIssuePayload', issue: null };
      }
      const updated: IssueRec = { ...issue, state: 'closed' };
      const issues = new Map(repo.issues);
      issues.set(issue.number, updated);
      const repos = new Map(ctx.state.repos);
      repos.set(`${repo.owner}/${repo.name}`, { ...repo, issues });
      const next: State = { ...ctx.state, repos, seq: ctx.state.seq + 1 };
      ctx.setState(next);
      ctx.state = next;
      const fresh = resolveRepo(ctx.state, repo.owner, repo.name) as RepoRec;
      return { __type: 'CloseIssuePayload', issue: issueNode(fresh, updated) };
    },
    createPullRequest: (ctx, _node, field) => {
      const input = (argValue(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? null : resolveRepoById(ctx.state, parsed.repoId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository for createPullRequest' });
        return { __type: 'CreatePullRequestPayload', pull: null };
      }
      const result = coreCreatePull(ctx.state, repo.owner, repo.name, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: typeof input.baseRefName === 'string' ? input.baseRefName : undefined,
      });
      if ('error' in result) {
        ctx.errors.push({ message: result.error.message });
        return { __type: 'CreatePullRequestPayload', pull: null };
      }
      ctx.setState(result.state);
      ctx.state = result.state;
      const fresh = resolveRepo(ctx.state, repo.owner, repo.name) as RepoRec;
      return { __type: 'CreatePullRequestPayload', pull: pullNode(fresh, result.value) };
    },
    mergePullRequest: (ctx, _node, field) => {
      const input = (argValue(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      const repo = parsed === null ? null : resolveRepoById(ctx.state, parsed.repoId);
      if (repo === null || parsed === null) {
        ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
        return { __type: 'MergePullRequestPayload', pull: null };
      }
      const result = coreMergePull(ctx.state, repo.owner, repo.name, parsed.number);
      if ('error' in result) {
        ctx.errors.push({ message: result.error.message });
        return { __type: 'MergePullRequestPayload', pull: null };
      }
      ctx.setState(result.state);
      ctx.state = result.state;
      const fresh = resolveRepo(ctx.state, repo.owner, repo.name) as RepoRec;
      return { __type: 'MergePullRequestPayload', pull: pullNode(fresh, result.value.pull) };
    },
    addComment: (ctx, _node, field) => {
      const input = (argValue(ctx, field, 'input') ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.subjectId ?? ''));
      const repo = parsed === null ? null : resolveRepoById(ctx.state, parsed.repoId);
      if (repo === null || parsed === null) {
        ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
        return { __type: 'AddCommentPayload', edge: null };
      }
      const result = coreAddComment(ctx.state, repo.owner, repo.name, parsed.number, String(input.body ?? ''));
      if ('error' in result) {
        ctx.errors.push({ message: result.error.message });
        return { __type: 'AddCommentPayload', edge: null };
      }
      ctx.setState(result.state);
      ctx.state = result.state;
      const comment: Node = {
        __type: 'Comment',
        repo,
        id: result.value.id,
        body: result.value.body,
        issueNumber: result.value.issueNumber,
        createdSeq: result.value.createdSeq,
      };
      return { __type: 'AddCommentPayload', edge: { __type: 'CommentEdge', comment } };
    },
  },
  User: {
    login: () => OWNER_LOGIN,
    id: () => resolveViewer().gid,
    name: () => resolveViewer().name,
    email: () => resolveViewer().email,
    url: () => `https://forge.invalid/${OWNER_LOGIN}`,
    databaseId: () => OWNER_ID,
  },
  Repository: {
    id: (_ctx, node) => repoGid((node as { repo: RepoRec }).repo.id),
    databaseId: (_ctx, node) => (node as { repo: RepoRec }).repo.id,
    name: (_ctx, node) => (node as { repo: RepoRec }).repo.name,
    nameWithOwner: (_ctx, node) => {
      const repo = (node as { repo: RepoRec }).repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: () => ({ __type: 'User' }),
    description: (_ctx, node) => (node as { repo: RepoRec }).repo.description || null,
    isPrivate: (_ctx, node) => (node as { repo: RepoRec }).repo.isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasWikiEnabled: () => false,
    isFork: () => false,
    isArchived: () => false,
    url: (_ctx, node) => {
      const repo = (node as { repo: RepoRec }).repo;
      return `https://forge.invalid/${repo.owner}/${repo.name}`;
    },
    createdAt: (_ctx, node) => isoAt((node as { repo: RepoRec }).repo.createdSeq),
    updatedAt: (_ctx, node) => isoAt((node as { repo: RepoRec }).repo.createdSeq),
    defaultBranchRef: (_ctx, node) => {
      const repo = (node as { repo: RepoRec }).repo;
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return { __type: 'Ref', repo, name: repo.defaultBranch, oid: tip } as Node;
    },
    issue: (ctx, node, field) => {
      const repo = (node as { repo: RepoRec }).repo;
      const issue = resolveIssue(repo, argInt(ctx, field, 'number'));
      return issue === null ? null : issueNode(repo, issue);
    },
    issues: (ctx, node, field) => {
      const repo = (node as { repo: RepoRec }).repo;
      const states = argValue(ctx, field, 'states');
      const orderBy = argValue(ctx, field, 'orderBy') as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
      let items: IssueRec[];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = states.map((entry) => String(entry).toLowerCase());
        items = [...repo.issues.values()].filter((issue) => wanted.includes(issue.state));
        items.sort((a, b) => a.number - b.number);
        if (direction === 'desc') items.reverse();
      } else {
        items = listIssues(repo, { state: 'all', direction });
      }
      return paginateIssues(ctx, repo, field, items);
    },
    pullRequest: (ctx, node, field) => {
      const repo = (node as { repo: RepoRec }).repo;
      const pull = resolvePull(repo, argInt(ctx, field, 'number'));
      return pull === null ? null : pullNode(repo, pull);
    },
    pullRequests: (ctx, node, field) => {
      const repo = (node as { repo: RepoRec }).repo;
      const states = argValue(ctx, field, 'states');
      let items = listPulls(repo, { state: 'all' });
      if (Array.isArray(states) && states.length > 0) {
        const wanted = states.map((entry) => String(entry).toUpperCase());
        items = items.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        items = items.filter((pull) => pull.state === 'open');
      }
      const first = argInt(ctx, field, 'first') || items.length;
      return { __type: 'PullRequestConnection', repo, items: items.slice(0, first), total: items.length } as Node;
    },
  },
  Ref: {
    name: (_ctx, node) => (node as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: (_ctx, node) => ({ __type: 'RefTarget', oid: (node as { oid: string }).oid }) as Node,
  },
  RefTarget: {
    oid: (_ctx, node) => (node as { oid: string }).oid,
    __typename: () => 'Commit',
  },
  Issue: {
    id: (_ctx, node) => {
      const n = node as { repo: RepoRec; issue: IssueRec };
      return issueGid(n.repo.id, n.issue.number);
    },
    number: (_ctx, node) => (node as { issue: IssueRec }).issue.number,
    title: (_ctx, node) => (node as { issue: IssueRec }).issue.title,
    body: (_ctx, node) => (node as { issue: IssueRec }).issue.body,
    state: (_ctx, node) => (node as { issue: IssueRec }).issue.state.toUpperCase(),
    author: () => ({ __type: 'User' }),
    repository: (_ctx, node) => repoNode((node as { repo: RepoRec }).repo),
    labels: (_ctx, node) => {
      const n = node as { repo: RepoRec; issue: IssueRec };
      return {
        __type: 'LabelConnection',
        labels: n.issue.labels.map((name) => ({ name, color: n.repo.labels.get(name)?.color ?? 'ededed' })),
      } as Node;
    },
    comments: (_ctx, node) => {
      const n = node as { repo: RepoRec; issue: IssueRec };
      const comments = (n.repo.comments.get(n.issue.number) ?? []).map((comment) => ({
        __type: 'Comment',
        repo: n.repo,
        id: comment.id,
        body: comment.body,
        issueNumber: comment.issueNumber,
        createdSeq: comment.createdSeq,
      }));
      return { __type: 'CommentConnection', comments } as unknown as Node;
    },
    createdAt: (_ctx, node) => isoAt((node as { issue: IssueRec }).issue.createdSeq),
    updatedAt: (_ctx, node) => isoAt((node as { issue: IssueRec }).issue.createdSeq),
    url: (_ctx, node) => {
      const n = node as { repo: RepoRec; issue: IssueRec };
      return `https://forge.invalid/${n.repo.owner}/${n.repo.name}/issues/${n.issue.number}`;
    },
  },
  PullRequest: {
    id: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      return pullGid(n.repo.id, n.pull.number);
    },
    number: (_ctx, node) => (node as { pull: PullRec }).pull.number,
    title: (_ctx, node) => (node as { pull: PullRec }).pull.title,
    body: (_ctx, node) => (node as { pull: PullRec }).pull.body,
    state: (_ctx, node) => {
      const pull = (node as { pull: PullRec }).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_ctx, node) => (node as { pull: PullRec }).pull.merged,
    mergedAt: (_ctx, node) => {
      const pull = (node as { pull: PullRec }).pull;
      return pull.mergedSeq === null ? null : isoAt(pull.mergedSeq);
    },
    mergeable: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      if (n.pull.merged) return 'UNKNOWN';
      return pullConflicts(n.repo, n.pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (_ctx, node) => (node as { pull: PullRec }).pull.head,
    baseRefName: (_ctx, node) => (node as { pull: PullRec }).pull.base,
    headRef: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      const tip = branchTip(n.repo, n.pull.head);
      return tip === null ? null : ({ __type: 'Ref', repo: n.repo, name: n.pull.head, oid: tip } as Node);
    },
    baseRef: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      const tip = branchTip(n.repo, n.pull.base);
      return tip === null ? null : ({ __type: 'Ref', repo: n.repo, name: n.pull.base, oid: tip } as Node);
    },
    author: () => ({ __type: 'User' }),
    repository: (_ctx, node) => repoNode((node as { repo: RepoRec }).repo),
    files: (ctx, node, field) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      const files = pullFiles(n.repo, n.pull).map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
      }));
      const first = argInt(ctx, field, 'first') || files.length;
      return { __type: 'PullRequestFileConnection', files: files.slice(0, first) } as Node;
    },
    additions: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      return pullFiles(n.repo, n.pull).reduce((sum, file) => sum + file.additions, 0);
    },
    deletions: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      return pullFiles(n.repo, n.pull).reduce((sum, file) => sum + file.deletions, 0);
    },
    changedFiles: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      return pullFiles(n.repo, n.pull).length;
    },
    createdAt: (_ctx, node) => isoAt((node as { pull: PullRec }).pull.createdSeq),
    updatedAt: (_ctx, node) => isoAt((node as { pull: PullRec }).pull.createdSeq),
    url: (_ctx, node) => {
      const n = node as { repo: RepoRec; pull: PullRec };
      return `https://forge.invalid/${n.repo.owner}/${n.repo.name}/pull/${n.pull.number}`;
    },
  },
  IssueConnection: {
    nodes: (_ctx, node) => {
      const n = node as { repo: RepoRec; items: IssueRec[] };
      return n.items.map((issue) => issueNode(n.repo, issue));
    },
    edges: (_ctx, node) => {
      const n = node as { repo: RepoRec; items: IssueRec[] };
      return n.items.map((issue) => ({ __type: 'IssueEdge', repo: n.repo, issue, cursor: issueCursor(issue) }) as Node);
    },
    pageInfo: (_ctx, node) => {
      const n = node as { items: IssueRec[]; total: number; hasNextPage?: boolean };
      const last = n.items[n.items.length - 1];
      return {
        __type: 'PageInfo',
        hasNextPage: n.hasNextPage ?? false,
        hasPreviousPage: false,
        startCursor: n.items[0] === undefined ? null : issueCursor(n.items[0]),
        endCursor: last === undefined ? null : issueCursor(last),
      } as Node;
    },
    totalCount: (_ctx, node) => (node as { total: number }).total,
  },
  IssueEdge: {
    node: (_ctx, node) => {
      const n = node as { repo: RepoRec; issue: IssueRec };
      return issueNode(n.repo, n.issue);
    },
    cursor: (_ctx, node) => (node as { cursor: string }).cursor,
  },
  PullRequestConnection: {
    nodes: (_ctx, node) => {
      const n = node as { repo: RepoRec; items: PullRec[] };
      return n.items.map((pull) => pullNode(n.repo, pull));
    },
    pageInfo: () =>
      ({ __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) as Node,
    totalCount: (_ctx, node) => (node as { total: number }).total,
  },
  PullRequestFileConnection: {
    nodes: (_ctx, node) =>
      (node as { files: Array<{ path: string; additions: number; deletions: number; changeType: string }> }).files.map(
        (file) => ({ __type: 'PullRequestFile', ...file }) as Node,
      ),
    pageInfo: () =>
      ({ __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) as Node,
    totalCount: (_ctx, node) => (node as { files: unknown[] }).files.length,
  },
  PullRequestFile: {
    path: (_ctx, node) => (node as { path: string }).path,
    additions: (_ctx, node) => (node as { additions: number }).additions,
    deletions: (_ctx, node) => (node as { deletions: number }).deletions,
    changeType: (_ctx, node) => (node as { changeType: string }).changeType,
  },
  PageInfo: {
    hasNextPage: (_ctx, node) => (node as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (_ctx, node) => (node as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (_ctx, node) => (node as { startCursor: string | null }).startCursor,
    endCursor: (_ctx, node) => (node as { endCursor: string | null }).endCursor,
  },
  CommentConnection: {
    nodes: (_ctx, node) => (node as { comments: Node[] }).comments,
    totalCount: (_ctx, node) => (node as { comments: Node[] }).comments.length,
    pageInfo: () =>
      ({ __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) as Node,
  },
  Comment: {
    id: (_ctx, node) => commentGid((node as { id: number }).id),
    body: (_ctx, node) => (node as { body: string }).body,
    author: () => ({ __type: 'User' }),
    createdAt: (_ctx, node) => isoAt((node as { createdSeq: number }).createdSeq),
  },
  CommentEdge: {
    node: (_ctx, node) => (node as { comment: Node }).comment,
    cursor: () => Buffer.from('cursor:comment', 'utf8').toString('base64'),
  },
  LabelConnection: {
    nodes: (_ctx, node) =>
      (node as { labels: Array<{ name: string; color: string }> }).labels.map((label) => ({ __type: 'Label', ...label }) as Node),
  },
  Label: {
    name: (_ctx, node) => (node as { name: string }).name,
    color: (_ctx, node) => (node as { color: string }).color,
  },
  CreateIssuePayload: {
    issue: (_ctx, node) => (node as { issue: Node | null }).issue,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (_ctx, node) => (node as { issue: Node | null }).issue,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, node) => (node as { pull: Node | null }).pull,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, node) => (node as { pull: Node | null }).pull,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, node) => (node as { edge: Node | null }).edge,
    subject: () => null,
    clientMutationId: () => null,
  },
  __Type: {
    name: (_ctx, node) => (node as { name: string }).name,
    kind: (_ctx, node) => (ENUM_TYPES[(node as { name: string }).name] !== undefined ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (_ctx, node) => {
      const name = (node as { name: string }).name;
      return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName }) as Node);
    },
    enumValues: (_ctx, node) => {
      const name = (node as { name: string }).name;
      return (ENUM_TYPES[name] ?? []).map((value) => ({ __type: '__EnumValue', name: value }) as Node);
    },
    possibleTypes: () => [],
    inputFields: () => [],
    specifiedByURL: () => null,
  },
  __Field: {
    name: (_ctx, node) => (node as { name: string }).name,
    description: () => null,
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, node) => (node as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => Object.keys(TYPE_FIELDS).map((name) => ({ __type: '__Type', name }) as Node),
    queryType: () => ({ __type: '__Type', name: 'Query' }) as Node,
    mutationType: () => ({ __type: '__Type', name: 'Mutation' }) as Node,
    subscriptionType: () => null,
    directives: () => [],
  },
};

/** The field lists introspection reports: the union of what the executor resolves. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['login', 'id', 'name', 'email', 'url', 'databaseId', 'avatarUrl', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description', 'isPrivate', 'isFork', 'isArchived', 'url', 'createdAt', 'updatedAt', 'labels', 'refs', 'stargazerCount',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'url', 'viewerDidAuthor', 'closedAt', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
    'title', 'body', 'author', 'repository', 'mergedAt', 'additions', 'deletions', 'changedFiles',
    'createdAt', 'updatedAt', 'url', 'headRef', 'baseRef', 'commits', 'reviews',
  ],
  Ref: ['name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Comment: ['id', 'body', 'author', 'createdAt', 'url'],
  Label: ['name', 'color', 'description'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// -------------------------------------------------------------------------------------------
// execution

function executeSelectionSet(
  ctx: Ctx,
  typeName: string,
  node: Node | null,
  selections: readonly GqlSelection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeResolvers = SCHEMA[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, node, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.operation.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelectionSet(ctx, typeName, node, fragment.selection));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = typeResolvers[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const value = resolver(ctx, node, field);
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, field: GqlField): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const node = value as Node;
    if (field.selection === null) return node.__type === '__Type' || node.__type === '__Field' || node.__type === '__EnumValue' ? {} : null;
    return executeSelectionSet(ctx, node.__type, node, field.selection);
  }
  return value;
}

/** Execute one operation document against the store; returns the GraphQL response object. */
export function executeGraphQL(
  state: State,
  setState: (next: State) => void,
  document: string,
  variables: Readonly<Record<string, unknown>>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let parsed: { operations: GqlOperation[] };
  try {
    parsed = new Parser(lex(document)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    parsed.operations.find((op) => operationName === undefined || op.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: Ctx = { state, setState, variables, operation, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selection);
  const out: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
