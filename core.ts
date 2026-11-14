// core.ts — the resolver core of the crisp-owl forge.
//
// The design is GraphQL-first: every surface (REST v3, GraphQL v4, MCP, git smart HTTP) is a thin
// adapter over the single set of resolver functions exported here, and all of them read and write
// one store. The store is held as an immutable snapshot value: a mutation never edits a snapshot in
// place, it derives the next snapshot (copy-on-write down to the one repository record it touches)
// and the caller swaps the reference. Earlier snapshots stay valid forever, which keeps every
// surface's view of ids and numbers consistent no matter which surface created the data.

import { createHash } from 'node:crypto';

// -------------------------------------------------------------------------------------------
// identity

/**
 * The login the trial token names. The contest scenario is generated from one published seed
 * (wire.ts SCENARIO_SEED in the kit), and its first generated user — the token owner — is
 * "adaiversen" for every trial; the suite addresses the owner's repositories by that login and
 * expects any other owner to be a 404.
 */
export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
export const OWNER_NAME = 'Ada Iversen';
export const OWNER_EMAIL = 'adaiversen@example.invalid';

/** The deterministic clock: MAKEFUN_TRIAL_NOW when the harness sets it, else a fixed epoch. */
const TRIAL_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z
function trialBaseSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return TRIAL_EPOCH_SEC;
}
const BASE_SEC = trialBaseSec();

/** An ISO timestamp `offsetSec` after the trial's opening instant — no wall clock anywhere. */
export function isoAt(offsetSec: number): string {
  return new Date((BASE_SEC + offsetSec) * 1000).toISOString().replace('.000Z', 'Z');
}

// -------------------------------------------------------------------------------------------
// git object model (the object store lives inside each repository record)

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's bytes into entries (mode kept without leading zeros, git-style). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('utf8').replace(/^0+/, '') || '0';
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode: mode === '40000' ? '40000' : mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries: git orders entries by name, directories as if suffixed with '/'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Peel an object id through tag objects until a commit (or a non-commit) is reached. */
export function peelToCommit(objects: ReadonlyMap<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Flatten a tree (recursively) into path -> blob entry. Missing trees flatten to nothing. */
export function flattenTree(
  objects: ReadonlyMap<string, GitObject>,
  treeOid: string,
  prefix = '',
  out = new Map<string, { oid: string; mode: string }>(),
): Map<string, { oid: string; mode: string }> {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build nested tree objects from a flat path map; returns the root tree id and the new objects. */
export function treesFromFlat(
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
): { root: string; objects: Array<{ oid: string; data: Buffer }> } {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      if (!node.dirs.has(segment)) node.dirs.set(segment, make());
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const objects: Array<{ oid: string; data: Buffer }> = [];
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.push({ oid, data });
    return oid;
  };
  return { root: build(root), objects };
}

// -------------------------------------------------------------------------------------------
// records (all immutable: fields readonly, collections never mutated after creation)

export interface LabelRec {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

export interface IssueRec {
  readonly number: number;
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly createdSeq: number;
}

export interface PullRec {
  readonly number: number;
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly mergedSeq: number | null;
  readonly createdSeq: number;
}

export interface CommentRec {
  readonly id: number;
  readonly issueNumber: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface RepoRec {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly labels: ReadonlyMap<string, LabelRec>;
  readonly issues: ReadonlyMap<number, IssueRec>;
  readonly pulls: ReadonlyMap<number, PullRec>;
  readonly comments: ReadonlyMap<number, readonly CommentRec[]>;
  readonly nextNumber: number;
  readonly objects: ReadonlyMap<string, GitObject>;
  readonly refs: ReadonlyMap<string, string>;
}

/** The whole forge state: one immutable snapshot. */
export interface State {
  readonly repos: ReadonlyMap<string, RepoRec>;
  readonly nextRepoId: number;
  readonly nextRecordId: number;
  readonly nextCommentId: number;
  readonly seq: number;
}

export function initialState(): State {
  return { repos: new Map(), nextRepoId: 5001, nextRecordId: 9001, nextCommentId: 7001, seq: 0 };
}

const repoKey = (owner: string, name: string): string => `${owner}/${name}`;

/** Derive the next snapshot with one repository record replaced (copy-on-write). */
function withRepo(state: State, repo: RepoRec, extra: Partial<State> = {}): State {
  const repos = new Map(state.repos);
  repos.set(repoKey(repo.owner, repo.name), repo);
  return { ...state, ...extra, repos, seq: state.seq + 1 };
}

function withoutRepo(state: State, owner: string, name: string): State {
  const repos = new Map(state.repos);
  repos.delete(repoKey(owner, name));
  return { ...state, repos, seq: state.seq + 1 };
}

// -------------------------------------------------------------------------------------------
// global ids (Relay-style opaque ids shared by GraphQL node() and the mutations)

export function repoGid(id: number): string {
  return Buffer.from(`crisp:R:${id}`, 'utf8').toString('base64');
}
export function issueGid(repoId: number, number: number): string {
  return Buffer.from(`crisp:I:${repoId}:${number}`, 'utf8').toString('base64');
}
export function pullGid(repoId: number, number: number): string {
  return Buffer.from(`crisp:P:${repoId}:${number}`, 'utf8').toString('base64');
}
export function commentGid(id: number): string {
  return Buffer.from(`crisp:C:${id}`, 'utf8').toString('base64');
}
export function userGid(): string {
  return Buffer.from(`crisp:U:${OWNER_ID}`, 'utf8').toString('base64');
}

/** Decode a global id into its kind and parts, or null when it is not one of ours. */
export function parseGid(gid: string): { kind: string; repoId: number; number: number } | null {
  let text: string;
  try {
    text = Buffer.from(gid, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^crisp:([RIPC]):(\d+)(?::(\d+))?$/.exec(text);
  if (match === null) return null;
  return { kind: match[1] as string, repoId: Number(match[2]), number: match[3] === undefined ? 0 : Number(match[3]) };
}

// -------------------------------------------------------------------------------------------
// read resolvers (pure functions of a snapshot)

export function resolveViewer() {
  return { login: OWNER_LOGIN, id: OWNER_ID, gid: userGid(), name: OWNER_NAME, email: OWNER_EMAIL };
}

export function resolveRepo(state: State, owner: string, name: string): RepoRec | null {
  if (owner !== OWNER_LOGIN) return null;
  return state.repos.get(repoKey(owner, name)) ?? null;
}

export function resolveRepoById(state: State, id: number): RepoRec | null {
  for (const repo of state.repos.values()) if (repo.id === id) return repo;
  return null;
}

export function listRepos(state: State): RepoRec[] {
  return [...state.repos.values()].sort((a, b) => a.id - b.id);
}

export function resolveIssue(repo: RepoRec, number: number): IssueRec | null {
  return repo.issues.get(number) ?? null;
}

export function resolvePull(repo: RepoRec, number: number): PullRec | null {
  return repo.pulls.get(number) ?? null;
}

export function listIssues(
  repo: RepoRec,
  options: { state?: 'open' | 'closed' | 'all'; direction?: 'asc' | 'desc' } = {},
): IssueRec[] {
  const wanted = options.state ?? 'open';
  const all = [...repo.issues.values()].filter((issue) => wanted === 'all' || issue.state === wanted);
  all.sort((a, b) => a.number - b.number);
  if ((options.direction ?? 'desc') === 'desc') all.reverse();
  return all;
}

export function listPulls(repo: RepoRec, options: { state?: 'open' | 'closed' | 'all' } = {}): PullRec[] {
  const wanted = options.state ?? 'open';
  const all = [...repo.pulls.values()].filter((pull) => {
    if (wanted === 'all') return true;
    if (wanted === 'open') return pull.state === 'open';
    return pull.state === 'closed';
  });
  all.sort((a, b) => b.number - a.number);
  return all;
}

/** The tip commit of a branch, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a ref-ish (branch name, full ref, tag name or raw sha) to a commit sha. */
export function resolveCommit(repo: RepoRec, ref: string): string | null {
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) {
      const commit = peelToCommit(repo.objects, oid);
      if (commit !== null) return commit;
    }
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) {
    return peelToCommit(repo.objects, ref);
  }
  return null;
}

/** Walk the first-parent-plus history reachable from a commit, newest first. */
export function commitHistory(repo: RepoRec, tip: string, limit = 1000): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0 && order.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

/** Is `ancestor` reachable from `descendant` (both commit shas)? */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const set = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (set.has(oid)) continue;
      set.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return set;
  };
  const fromA = ancestorsOf(a);
  // Breadth-first from b so the first shared commit is the nearest one.
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Line counts of a change between two blob texts (LCS-based, exact for the sizes served). */
function lineDiffCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  if (oldText === null) return { additions: newText === null || newText === '' ? 0 : newText.split('\n').length - (newText.endsWith('\n') ? 1 : 0) || countLines(newText), deletions: 0 };
  if (newText === null) return { additions: 0, deletions: countLines(oldText) };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // LCS length via dynamic programming over lines; inputs here are small.
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const keep = dp[j] as number;
      dp[j] = a[i] === b[j] ? prev + 1 : Math.max(dp[j] as number, dp[j + 1] as number);
      prev = keep;
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The flattened tree of a commit (empty map when the commit is null). */
export function treeOfCommit(repo: RepoRec, commitSha: string | null): Map<string, { oid: string; mode: string }> {
  if (commitSha === null) return new Map();
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(object.data).tree);
}

/** Files changed between a base commit and a head commit (a pull request's file list). */
export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null) return [];
  const base = baseTip === null ? null : mergeBase(repo, headTip, baseTip);
  const from = treeOfCommit(repo, base);
  const to = treeOfCommit(repo, headTip);
  return diffTrees(repo, from, to);
}

export function diffTrees(
  repo: RepoRec,
  from: ReadonlyMap<string, { oid: string; mode: string }>,
  to: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const oldText = before === undefined ? null : (repo.objects.get(before.oid)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? null : (repo.objects.get(after.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/**
 * Three-way tree merge for a squash: returns the merged flat tree, or null on a conflict
 * (both sides changed the same path to different bytes since the merge base).
 */
export function mergeTrees(
  repo: RepoRec,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const ancestor = mergeBase(repo, baseTip, headTip);
  const baseTree = treeOfCommit(repo, ancestor);
  const ours = treeOfCommit(repo, baseTip);
  const theirs = treeOfCommit(repo, headTip);
  const merged = new Map(ours);
  const paths = new Set<string>([...baseTree.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const inBase = baseTree.get(path)?.oid ?? null;
    const inOurs = ours.get(path)?.oid ?? null;
    const inTheirs = theirs.get(path)?.oid ?? null;
    if (inTheirs === inBase || inTheirs === inOurs) continue; // head did not change it, or both agree
    if (inOurs !== inBase) return null; // both changed it differently
    if (inTheirs === null) merged.delete(path);
    else merged.set(path, theirs.get(path) as { oid: string; mode: string });
  }
  return merged;
}

/** Whether merging the pull's head into its base would conflict right now. */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return false;
  return mergeTrees(repo, baseTip, headTip) === null;
}

/** The author/committer identity line our own commits carry at a given sequence tick. */
export function identityLine(seq: number): string {
  return `${OWNER_NAME} <${OWNER_EMAIL}> ${BASE_SEC + seq} +0000`;
}

/**
 * Store a flat tree as git objects on a repo record, commit it onto a branch and move the ref:
 * the one write path behind the contents API, merges and fixture commits. Pure record transform.
 */
export function commitFlatTree(
  repo: RepoRec,
  options: {
    branch: string;
    flat: ReadonlyMap<string, { oid: string; mode: string }>;
    extraObjects: readonly GitObject[];
    message: string;
    seq: number;
    parents?: readonly string[];
  },
): { repo: RepoRec; commitSha: string } {
  const objects = new Map(repo.objects);
  for (const object of options.extraObjects) {
    objects.set(hashObject(object.type, object.data), object);
  }
  const { root, objects: treeObjects } = treesFromFlat(options.flat);
  for (const treeObject of treeObjects) objects.set(treeObject.oid, { type: 'tree', data: treeObject.data });
  const tip = branchTip(repo, options.branch);
  const parents = options.parents ?? (tip === null ? [] : [tip]);
  const identity = identityLine(options.seq);
  const data = buildCommit({ tree: root, parents, author: identity, committer: identity, message: options.message });
  const commitSha = hashObject('commit', data);
  objects.set(commitSha, { type: 'commit', data });
  const refs = new Map(repo.refs);
  refs.set(`refs/heads/${options.branch}`, commitSha);
  return { repo: { ...repo, objects, refs }, commitSha };
}

// -------------------------------------------------------------------------------------------
// mutation resolvers: (state, input) -> { state, value } | { error: {status, message} }

export type CoreError = { error: { status: number; message: string } };
export type CoreOk<T> = { state: State; value: T };
export type CoreResult<T> = CoreOk<T> | CoreError;

export function isError<T>(result: CoreResult<T>): result is CoreError {
  return 'error' in result;
}

const fail = (status: number, message: string): CoreError => ({ error: { status, message } });

export function coreCreateRepo(
  state: State,
  input: { name: string; description?: string; isPrivate?: boolean; defaultBranch?: string },
): CoreResult<RepoRec> {
  const name = input.name;
  if (typeof name !== 'string' || name === '') return fail(422, 'Validation Failed: name is required');
  if (resolveRepo(state, OWNER_LOGIN, name) !== null) {
    return fail(422, `Validation Failed: name already exists on this account`);
  }
  const repo: RepoRec = {
    id: state.nextRepoId,
    owner: OWNER_LOGIN,
    name,
    description: input.description ?? '',
    isPrivate: input.isPrivate ?? false,
    defaultBranch: typeof input.defaultBranch === 'string' && input.defaultBranch !== '' ? input.defaultBranch : 'main',
    createdSeq: state.seq + 1,
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    objects: new Map(),
    refs: new Map(),
  };
  return { state: withRepo(state, repo, { nextRepoId: state.nextRepoId + 1 }), value: repo };
}

export function coreUpdateRepo(
  state: State,
  owner: string,
  name: string,
  patch: { description?: string; isPrivate?: boolean; defaultBranch?: string; newName?: string },
): CoreResult<RepoRec> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const updated: RepoRec = {
    ...repo,
    description: patch.description ?? repo.description,
    isPrivate: patch.isPrivate ?? repo.isPrivate,
    defaultBranch: patch.defaultBranch ?? repo.defaultBranch,
    name: patch.newName ?? repo.name,
  };
  if (updated.name !== repo.name) {
    const moved = withoutRepo(state, owner, name);
    return { state: withRepo(moved, updated), value: updated };
  }
  return { state: withRepo(state, updated), value: updated };
}

export function coreDeleteRepo(state: State, owner: string, name: string): CoreResult<null> {
  if (resolveRepo(state, owner, name) === null) return fail(404, 'Not Found');
  return { state: withoutRepo(state, owner, name), value: null };
}

export function coreCreateLabel(
  state: State,
  owner: string,
  name: string,
  input: { name: string; color?: string; description?: string | null },
): CoreResult<LabelRec> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  if (typeof input.name !== 'string' || input.name === '') return fail(422, 'Validation Failed: name is required');
  if (repo.labels.has(input.name)) return fail(422, 'Validation Failed: name already exists on this repository');
  const label: LabelRec = { name: input.name, color: input.color ?? 'ededed', description: input.description ?? null };
  const labels = new Map(repo.labels);
  labels.set(label.name, label);
  return { state: withRepo(state, { ...repo, labels }), value: label };
}

export function coreCreateIssue(
  state: State,
  owner: string,
  name: string,
  input: { title: string; body?: string; labels?: readonly string[] },
): CoreResult<IssueRec> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const wanted = input.labels ?? [];
  for (const labelName of wanted) {
    if (!repo.labels.has(labelName)) return fail(422, `Validation Failed: label "${labelName}" does not exist`);
  }
  const issue: IssueRec = {
    number: repo.nextNumber,
    id: state.nextRecordId,
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    labels: [...wanted],
    createdSeq: state.seq + 1,
  };
  const issues = new Map(repo.issues);
  issues.set(issue.number, issue);
  const next: RepoRec = { ...repo, issues, nextNumber: repo.nextNumber + 1 };
  return { state: withRepo(state, next, { nextRecordId: state.nextRecordId + 1 }), value: issue };
}

export function coreUpdateIssue(
  state: State,
  owner: string,
  name: string,
  number: number,
  patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: readonly string[] },
): CoreResult<IssueRec> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return fail(404, 'Not Found');
  if (patch.labels !== undefined) {
    for (const labelName of patch.labels) {
      if (!repo.labels.has(labelName)) return fail(422, `Validation Failed: label "${labelName}" does not exist`);
    }
  }
  const updated: IssueRec = {
    ...issue,
    title: patch.title ?? issue.title,
    body: patch.body ?? issue.body,
    state: patch.state ?? issue.state,
    labels: patch.labels === undefined ? issue.labels : [...patch.labels],
  };
  const issues = new Map(repo.issues);
  issues.set(number, updated);
  return { state: withRepo(state, { ...repo, issues }), value: updated };
}

export function coreAddComment(
  state: State,
  owner: string,
  name: string,
  issueNumber: number,
  body: string,
): CoreResult<CommentRec> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  if (!repo.issues.has(issueNumber) && !repo.pulls.has(issueNumber)) return fail(404, 'Not Found');
  const comment: CommentRec = { id: state.nextCommentId, issueNumber, body, createdSeq: state.seq + 1 };
  const existing = repo.comments.get(issueNumber) ?? [];
  const comments = new Map(repo.comments);
  comments.set(issueNumber, [...existing, comment]);
  return { state: withRepo(state, { ...repo, comments }, { nextCommentId: state.nextCommentId + 1 }), value: comment };
}

function stripRefPrefix(head: string): string {
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(colon + 1);
}

export function coreCreatePull(
  state: State,
  owner: string,
  name: string,
  input: { title: string; body?: string; head: string; base?: string },
): CoreResult<PullRec> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const head = stripRefPrefix(input.head ?? '');
  const base = input.base ?? repo.defaultBranch;
  if (branchTip(repo, head) === null) return fail(422, `Validation Failed: head branch "${head}" does not exist`);
  if (branchTip(repo, base) === null) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      return fail(422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
    }
  }
  const pull: PullRec = {
    number: repo.nextNumber,
    id: state.nextRecordId,
    title: input.title ?? '',
    body: input.body ?? '',
    head,
    base,
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedSeq: null,
    createdSeq: state.seq + 1,
  };
  const pulls = new Map(repo.pulls);
  pulls.set(pull.number, pull);
  const next: RepoRec = { ...repo, pulls, nextNumber: repo.nextNumber + 1 };
  return { state: withRepo(state, next, { nextRecordId: state.nextRecordId + 1 }), value: pull };
}

/** Squash-merge a pull request onto its base branch: the one merge path for REST, GraphQL and MCP. */
export function coreMergePull(state: State, owner: string, name: string, number: number): CoreResult<{ pull: PullRec; sha: string }> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return fail(404, 'Not Found');
  if (pull.merged) return fail(405, 'Pull Request is already merged');
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return fail(405, 'Pull Request is not mergeable');
  const mergedTree = mergeTrees(repo, baseTip, headTip);
  if (mergedTree === null) return fail(405, 'Pull Request is not mergeable: conflict');
  const committed = commitFlatTree(repo, {
    branch: pull.base,
    flat: mergedTree,
    extraObjects: [],
    message: `${pull.title} (#${pull.number})`,
    seq: state.seq + 1,
    parents: [baseTip],
  });
  const updated: PullRec = {
    ...pull,
    state: 'closed',
    merged: true,
    mergeCommitSha: committed.commitSha,
    mergedSeq: state.seq + 1,
  };
  const pulls = new Map(committed.repo.pulls);
  pulls.set(number, updated);
  const nextRepo: RepoRec = { ...committed.repo, pulls };
  return { state: withRepo(state, nextRepo), value: { pull: updated, sha: committed.commitSha } };
}

/** Create or move a ref to an existing object (branch creation through the REST git API). */
export function coreCreateRef(state: State, owner: string, name: string, ref: string, sha: string): CoreResult<{ ref: string; sha: string }> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  if (!repo.objects.has(sha)) return fail(422, 'Validation Failed: object does not exist');
  const refs = new Map(repo.refs);
  refs.set(ref, sha);
  return { state: withRepo(state, { ...repo, refs }), value: { ref, sha } };
}

/** PUT /contents: commit one file onto a branch, honouring the optimistic-concurrency sha. */
export function corePutContent(
  state: State,
  owner: string,
  name: string,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): CoreResult<{ commitSha: string; blobSha: string; created: boolean }> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const branch = input.branch ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const flat = treeOfCommit(repo, tip);
  const existing = flat.get(input.path);
  if (input.sha !== undefined) {
    if (existing === undefined) return fail(422, 'Validation Failed: sha must match an existing file');
    if (existing.oid !== input.sha) return fail(409, 'Conflict: the sha does not match the current blob');
  } else if (existing !== undefined) {
    return fail(422, 'Validation Failed: sha was not supplied for an existing file');
  }
  const blobSha = hashObject('blob', input.content);
  const nextFlat = new Map(flat);
  nextFlat.set(input.path, { oid: blobSha, mode: '100644' });
  const committed = commitFlatTree(repo, {
    branch,
    flat: nextFlat,
    extraObjects: [{ type: 'blob', data: input.content }],
    message: input.message,
    seq: state.seq + 1,
  });
  return {
    state: withRepo(state, committed.repo),
    value: { commitSha: committed.commitSha, blobSha, created: existing === undefined },
  };
}

/** DELETE /contents: commit the removal of one file. */
export function coreDeleteContent(
  state: State,
  owner: string,
  name: string,
  input: { path: string; message: string; branch?: string; sha?: string },
): CoreResult<{ commitSha: string }> {
  const repo = resolveRepo(state, owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const branch = input.branch ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const flat = treeOfCommit(repo, tip);
  const existing = flat.get(input.path);
  if (existing === undefined) return fail(404, 'Not Found');
  if (input.sha !== undefined && existing.oid !== input.sha) return fail(409, 'Conflict: the sha does not match the current blob');
  const nextFlat = new Map(flat);
  nextFlat.delete(input.path);
  const committed = commitFlatTree(repo, {
    branch,
    flat: nextFlat,
    extraObjects: [],
    message: input.message,
    seq: state.seq + 1,
  });
  return { state: withRepo(state, committed.repo), value: { commitSha: committed.commitSha } };
}

/** Read one file (or directory listing) at a ref: the contents API's read side. */
export function resolveContent(
  repo: RepoRec,
  path: string,
  ref: string | undefined,
): { kind: 'file'; entry: { oid: string; mode: string }; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const commitSha = ref === undefined ? branchTip(repo, repo.defaultBranch) : resolveCommit(repo, ref);
  if (commitSha === null) return null;
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path === '') {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined) return null;
    return { kind: 'dir', entries: parseTree(tree.data) };
  }
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        const dir = repo.objects.get(entry.oid);
        if (dir === undefined) return null;
        return { kind: 'dir', entries: parseTree(dir.data) };
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return null;
      return { kind: 'file', entry: { oid: entry.oid, mode: entry.mode }, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}
