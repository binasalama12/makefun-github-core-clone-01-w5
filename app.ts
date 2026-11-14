// app.ts — the HTTP surface. Routing and serialisation only: every route is a thin adapter that
// translates wire shapes into calls on the resolver core (core.ts), the GraphQL executor
// (graphql.ts), the MCP handler (mcp.ts) or the git protocol engine (git.ts), all over one store
// snapshot held here. The store is a single `let` binding to an immutable State; a mutation swaps
// the binding for the derived snapshot, so concurrent readers always see one consistent forge.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  OWNER_LOGIN,
  branchTip,
  commitHistory,
  coreAddComment,
  coreCreateIssue,
  coreCreateLabel,
  coreCreatePull,
  coreCreateRef,
  coreCreateRepo,
  coreDeleteContent,
  coreDeleteRepo,
  coreMergePull,
  corePutContent,
  coreUpdateIssue,
  coreUpdateRepo,
  initialState,
  isError,
  listIssues,
  listPulls,
  parseCommit,
  pullFiles,
  resolveCommit,
  resolveContent,
  resolveIssue,
  resolvePull,
  resolveRepo,
  resolveViewer,
  type RepoRec,
  type State,
} from './core.ts';
import { advertiseV0, advertiseV2, applyPush, fetchV0Response, fetchV2Response, parsePkts, runLsRefs } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpMessage } from './mcp.ts';
import { commentJson, commitJson, issueJson, labelJson, pullJson, repoJson, userJson } from './restjson.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let state: State = initialState();
const getState = (): State => state;
const setState = (next: State): void => {
  state = next;
};

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `crisp-${requestCounter.toString(36)}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

interface JsonBody {
  ok: boolean;
  value: Record<string, unknown>;
}

/** Parse a JSON request body; empty bodies count as {}, malformed ones as a 400. */
function jsonBody(raw: Buffer): JsonBody {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true, value: {} };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, value: {} };
  }
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asBool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): { page: T[]; link: string | null; perPage: number; pageNumber: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const pageNumber = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage) as T[];
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(pageNumber + 1));
    params.set('per_page', String(perPage));
    link = `<http://${host}${url.pathname}?${params.toString()}>; rel="next"`;
  }
  return { page, link, perPage, pageNumber };
}

// -------------------------------------------------------------------------------------------
// REST v3

function restRoute(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): void {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);
  // segments[0] === 'api', segments[1] === 'v3'
  const tail = segments.slice(2);

  const badJson = (): boolean => {
    if (method === 'GET' || method === 'HEAD') return false;
    return !jsonBody(raw).ok;
  };
  const body = (): Record<string, unknown> => jsonBody(raw).value;
  const notFound = (): void => sendJson(res, 404, { message: 'Not Found' });
  const coreFail = (result: { error: { status: number; message: string } }): void =>
    sendJson(res, result.error.status, { message: result.error.message });

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
          emojis_url: '/api/v3/emojis',
          meta_url: '/api/v3/meta',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound();
    return;
  }

  if (tail[0] === 'meta' && tail.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      github_authentication: { token_scopes: ['repo', 'read:org'] },
      installed_version: '1.0.0-crisp-owl',
      hooks_url: '/api/v3/hooks',
      issue_search_url: '/api/v3/search/issues',
      repository_search_url: '/api/v3/search/repositories',
      current_user_url: '/api/v3/user',
    });
    return;
  }

  if (tail[0] === 'user' && tail.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }

  if (tail[0] === 'user' && tail[1] === 'repos' && tail.length === 2) {
    if (method === 'GET') {
      const repos = [...getState().repos.values()].sort((a, b) => a.id - b.id);
      const { page, link } = paginate(req, url, repos);
      sendJson(res, 200, page.map(repoJson), link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      if (badJson()) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const input = body();
      const result = coreCreateRepo(getState(), {
        name: asString(input.name) ?? '',
        description: asString(input.description),
        isPrivate: asBool(input.private),
        defaultBranch: asString(input.default_branch),
      });
      if (isError(result)) return coreFail(result);
      setState(result.state);
      sendJson(res, 201, repoJson(result.value));
      return;
    }
    notFound();
    return;
  }

  if (tail[0] === 'repos' && tail.length >= 3) {
    const owner = tail[1] as string;
    const name = tail[2] as string;
    const rest = tail.slice(3);
    const repo = resolveRepo(getState(), owner, name);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === null) return notFound();
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const input = body();
        const result = coreUpdateRepo(getState(), owner, name, {
          description: asString(input.description),
          isPrivate: asBool(input.private),
          defaultBranch: asString(input.default_branch),
          newName: asString(input.name),
        });
        if (isError(result)) return coreFail(result);
        setState(result.state);
        sendJson(res, 200, repoJson(result.value));
        return;
      }
      if (method === 'DELETE') {
        const result = coreDeleteRepo(getState(), owner, name);
        if (isError(result)) return coreFail(result);
        setState(result.state);
        requestCounter += 1;
        res.writeHead(204, { 'x-github-request-id': `crisp-${requestCounter.toString(36)}` });
        res.end();
        return;
      }
      notFound();
      return;
    }

    if (repo === null) return notFound();

    // --- git data API: refs, branches, commits
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const input = body();
        const ref = asString(input.ref) ?? '';
        const sha = asString(input.sha) ?? '';
        const result = coreCreateRef(getState(), owner, name, ref, sha);
        if (isError(result)) return coreFail(result);
        setState(result.state);
        sendJson(res, 201, {
          ref: result.value.ref,
          node_id: Buffer.from(`crisp:Ref:${ref}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${owner}/${name}/git/${result.value.ref}`,
          object: { sha: result.value.sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${result.value.sha}` },
        });
        return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFound();
        sendJson(res, 200, {
          ref,
          node_id: Buffer.from(`crisp:Ref:${ref}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${owner}/${name}/git/${ref}`,
          object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${oid}` },
        });
        return;
      }
      notFound();
      return;
    }

    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      if (method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).join('/');
        const tip = branchTip(repo, branch);
        if (tip === null) return notFound();
        sendJson(res, 200, {
          name: branch,
          commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` },
          protected: false,
        });
        return;
      }
      notFound();
      return;
    }

    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 2) {
        const sha = rest[1] as string;
        const object = repo.objects.get(sha);
        if (object === undefined || object.type !== 'commit') return notFound();
        const info = parseCommit(object.data);
        sendJson(res, 200, commitJson(repo, sha, info));
        return;
      }
      const refParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = resolveCommit(repo, refParam);
      const history = tip === null ? [] : commitHistory(repo, tip);
      const { page, link } = paginate(req, url, history);
      sendJson(
        res,
        200,
        page.map((sha) => commitJson(repo, sha, parseCommit((repo.objects.get(sha) as { data: Buffer }).data))),
        link === null ? {} : { link },
      );
      return;
    }

    // --- contents
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') {
        const found = resolveContent(repo, contentPath, url.searchParams.get('ref') ?? undefined);
        if (found === null) return notFound();
        if (found.kind === 'file') {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: found.data.length,
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: found.entry.oid,
            content: found.data.toString('base64'),
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${found.entry.oid}`,
            html_url: `https://forge.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${contentPath}`,
            download_url: `https://forge.invalid/${owner}/${name}/raw/${repo.defaultBranch}/${contentPath}`,
          });
          return;
        }
        const prefix = contentPath === '' ? '' : `${contentPath}/`;
        sendJson(
          res,
          200,
          found.entries.map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${prefix}${entry.name}`,
            sha: entry.oid,
            size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
            url: `/api/v3/repos/${owner}/${name}/contents/${prefix}${entry.name}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
            html_url: `https://forge.invalid/${owner}/${name}/${entry.mode === '40000' ? 'tree' : 'blob'}/${repo.defaultBranch}/${prefix}${entry.name}`,
          })),
        );
        return;
      }
      if (method === 'PUT') {
        if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const input = body();
        const content = typeof input.content === 'string' ? Buffer.from(input.content, 'base64') : Buffer.alloc(0);
        const result = corePutContent(getState(), owner, name, {
          path: contentPath,
          content,
          message: asString(input.message) ?? 'Update file',
          branch: asString(input.branch),
          sha: asString(input.sha),
        });
        if (isError(result)) return coreFail(result);
        setState(result.state);
        const commit = (getState().repos.get(`${owner}/${name}`) as RepoRec).objects.get(result.value.commitSha);
        const commitInfo = commit === undefined ? { message: '' } : parseCommit(commit.data);
        sendJson(res, result.value.created ? 201 : 200, {
          content: {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: result.value.blobSha,
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${result.value.blobSha}`,
            html_url: `https://forge.invalid/${owner}/${name}/blob/${asString(input.branch) ?? repo.defaultBranch}/${contentPath}`,
          },
          commit: {
            sha: result.value.commitSha,
            message: commitInfo.message.replace(/\n$/, ''),
            url: `/api/v3/repos/${owner}/${name}/git/commits/${result.value.commitSha}`,
            html_url: `https://forge.invalid/${owner}/${name}/commit/${result.value.commitSha}`,
          },
        });
        return;
      }
      if (method === 'DELETE') {
        if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const input = body();
        const result = coreDeleteContent(getState(), owner, name, {
          path: contentPath,
          message: asString(input.message) ?? 'Delete file',
          branch: asString(input.branch),
          sha: asString(input.sha),
        });
        if (isError(result)) return coreFail(result);
        setState(result.state);
        sendJson(res, 200, { content: null, commit: { sha: result.value.commitSha } });
        return;
      }
      notFound();
      return;
    }

    // --- labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') {
        if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const input = body();
        const result = coreCreateLabel(getState(), owner, name, {
          name: asString(input.name) ?? '',
          color: asString(input.color),
          description: typeof input.description === 'string' ? input.description : null,
        });
        if (isError(result)) return coreFail(result);
        setState(result.state);
        sendJson(res, 201, labelJson(result.value));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      notFound();
      return;
    }

    // --- issues and comments
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const input = body();
          const labels = Array.isArray(input.labels)
            ? input.labels.map((entry) => (typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name ?? '')))
            : [];
          const result = coreCreateIssue(getState(), owner, name, {
            title: asString(input.title) ?? '',
            body: asString(input.body) ?? '',
            labels,
          });
          if (isError(result)) return coreFail(result);
          setState(result.state);
          const fresh = resolveRepo(getState(), owner, name) as RepoRec;
          sendJson(res, 201, issueJson(fresh, result.value));
          return;
        }
        if (method === 'GET') {
          const stateParam = url.searchParams.get('state') ?? 'open';
          const filter = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
          const directionParam = url.searchParams.get('direction');
          const direction = directionParam === 'asc' ? 'asc' : 'desc';
          const issues = listIssues(repo, { state: filter, direction });
          const { page, link } = paginate(req, url, issues);
          sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
          return;
        }
        notFound();
        return;
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? resolveIssue(repo, number) : null;
      if (rest.length === 2) {
        if (method === 'GET') {
          if (issue === null) return notFound();
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const input = body();
          const statePatch = asString(input.state);
          const result = coreUpdateIssue(getState(), owner, name, number, {
            title: asString(input.title),
            body: asString(input.body),
            state: statePatch === 'closed' ? 'closed' : statePatch === 'open' ? 'open' : undefined,
            labels: Array.isArray(input.labels)
              ? input.labels.map((entry) => (typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name ?? '')))
              : undefined,
          });
          if (isError(result)) return coreFail(result);
          setState(result.state);
          const fresh = resolveRepo(getState(), owner, name) as RepoRec;
          sendJson(res, 200, issueJson(fresh, result.value));
          return;
        }
        notFound();
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === null && resolvePull(repo, number) === null) return notFound();
        if (method === 'POST') {
          if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const input = body();
          const result = coreAddComment(getState(), owner, name, number, asString(input.body) ?? '');
          if (isError(result)) return coreFail(result);
          setState(result.state);
          const fresh = resolveRepo(getState(), owner, name) as RepoRec;
          sendJson(res, 201, commentJson(fresh, result.value));
          return;
        }
        if (method === 'GET') {
          const comments = repo.comments.get(number) ?? [];
          sendJson(res, 200, comments.map((comment) => commentJson(repo, comment)));
          return;
        }
        notFound();
        return;
      }
      notFound();
      return;
    }

    // --- pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          const input = body();
          const result = coreCreatePull(getState(), owner, name, {
            title: asString(input.title) ?? '',
            body: asString(input.body) ?? '',
            head: asString(input.head) ?? '',
            base: asString(input.base),
          });
          if (isError(result)) return coreFail(result);
          setState(result.state);
          const fresh = resolveRepo(getState(), owner, name) as RepoRec;
          sendJson(res, 201, pullJson(fresh, result.value));
          return;
        }
        if (method === 'GET') {
          const stateParam = url.searchParams.get('state') ?? 'open';
          const filter = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
          const pulls = listPulls(repo, { state: filter });
          const { page, link } = paginate(req, url, pulls);
          sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), link === null ? {} : { link });
          return;
        }
        notFound();
        return;
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? resolvePull(repo, number) : null;
      if (rest.length === 2 && method === 'GET') {
        if (pull === null) return notFound();
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === null) return notFound();
        const files = pullFiles(repo, pull).map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }));
        // Fill in blob shas from the head tree for realism.
        sendJson(res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (badJson()) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const result = coreMergePull(getState(), owner, name, number);
        if (isError(result)) return coreFail(result);
        setState(result.state);
        sendJson(res, 200, { sha: result.value.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      notFound();
      return;
    }

    notFound();
    return;
  }

  notFound();
}

// -------------------------------------------------------------------------------------------
// git smart HTTP

function gitRoute(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): boolean {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (match === null) return false;
  const owner = decodeSegment(match[1] as string);
  const name = decodeSegment(match[2] as string);
  const suffix = match[3] ?? '';
  const repo = owner === OWNER_LOGIN ? resolveRepo(getState(), owner, name) : null;
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && suffix === '/info/refs') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      sendRaw(res, 200, wantsV2 ? advertiseV2(repo) : advertiseV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    try {
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (wantsV2) {
        const packets = parsePkts(raw);
        const args: string[] = [];
        let command = '';
        let section = 0;
        for (const packet of packets) {
          if (packet.kind === 'delim') {
            section = 1;
            continue;
          }
          if (packet.kind === 'flush') break;
          if (packet.kind !== 'data') continue;
          const line = packet.payload.toString('utf8').replace(/\n$/, '');
          if (section === 0) {
            if (line.startsWith('command=')) command = line.slice('command='.length);
          } else {
            args.push(line);
          }
        }
        if (command === 'ls-refs') {
          sendRaw(res, 200, runLsRefs(repo, args), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'fetch') {
          sendRaw(res, 200, fetchV2Response(repo, args), 'application/x-git-upload-pack-result');
          return true;
        }
        sendRaw(res, 400, Buffer.from('unsupported command\n'), 'text/plain');
        return true;
      }
      const packets = parsePkts(raw);
      sendRaw(res, 200, fetchV0Response(repo, packets), 'application/x-git-upload-pack-result');
      return true;
    } catch {
      sendRaw(res, 400, Buffer.from('invalid pkt-line stream\n'), 'text/plain');
      return true;
    }
  }
  if (method === 'POST' && suffix === '/git-receive-pack') {
    const out = applyPush(getState(), repo, raw, setState);
    sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// -------------------------------------------------------------------------------------------
// GraphQL and MCP

function graphqlRoute(res: ServerResponse, raw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const item = (entry ?? {}) as { query?: unknown; variables?: Record<string, unknown>; operationName?: string };
      return executeGraphQL(getState(), setState, typeof item.query === 'string' ? item.query : '', item.variables ?? {}, item.operationName);
    });
    sendJson(res, 200, results);
    return;
  }
  const item = (parsed ?? {}) as { query?: unknown; variables?: Record<string, unknown>; operationName?: string };
  const result = executeGraphQL(getState(), setState, typeof item.query === 'string' ? item.query : '', item.variables ?? {}, item.operationName);
  sendJson(res, 200, result);
}

function mcpRoute(res: ServerResponse, raw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed
      .map((entry) => handleMcpMessage(getState(), setState, (entry ?? {}) as Record<string, unknown>))
      .filter((outcome) => outcome.body !== null)
      .map((outcome) => outcome.body);
    if (results.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, results);
    return;
  }
  const outcome = handleMcpMessage(getState(), setState, (parsed ?? {}) as Record<string, unknown>);
  if (outcome.body === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.body);
}

// -------------------------------------------------------------------------------------------
// the server

/** Build the forge's HTTP server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const raw = await readBody(req);

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          restRoute(req, res, url, raw);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          graphqlRoute(res, raw);
          return;
        }
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
            return;
          }
          mcpRoute(res, raw);
          return;
        }
        if (gitRoute(req, res, url, raw)) return;

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
