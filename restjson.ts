// restjson.ts — the GitHub v3 JSON shapes for core records. REST returns these directly, and the
// MCP tools return the same objects as structured content, which is what makes ids and numbers
// read identically on every surface.

import {
  OWNER_ID,
  OWNER_LOGIN,
  branchTip,
  commentGid,
  isoAt,
  issueGid,
  pullGid,
  repoGid,
  userGid,
  type CommentRec,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './core.ts';

export function userJson(): Record<string, unknown> {
  return {
    login: OWNER_LOGIN,
    id: OWNER_ID,
    node_id: userGid(),
    type: 'User',
    site_admin: false,
    name: 'Ada Iversen',
    email: 'adaiversen@example.invalid',
    url: `/api/v3/users/${OWNER_LOGIN}`,
    html_url: `https://forge.invalid/${OWNER_LOGIN}`,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGid(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: OWNER_ID, node_id: userGid(), type: 'User' },
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    git_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.createdSeq),
    pushed_at: isoAt(repo.createdSeq),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: 3000 + label.name.length * 7 + label.name.charCodeAt(0),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGid(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: 'ededed', description: null } : labelJson(label);
    }),
    user: { login: OWNER_LOGIN, id: OWNER_ID },
    assignees: [],
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.createdSeq),
    closed_at: null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function commentJson(repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGid(comment.id),
    body: comment.body,
    user: { login: OWNER_LOGIN, id: OWNER_ID },
    created_at: isoAt(comment.createdSeq),
    updated_at: isoAt(comment.createdSeq),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}`,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.head);
  const baseSha = branchTip(repo, pull.base);
  const side = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha: sha ?? '0000000000000000000000000000000000000000',
    user: { login: repo.owner, id: OWNER_ID },
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: pullGid(repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : isoAt(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: OWNER_LOGIN, id: OWNER_ID },
    head: side(pull.head, headSha),
    base: side(pull.base, baseSha),
    created_at: isoAt(pull.createdSeq),
    updated_at: isoAt(pull.createdSeq),
    closed_at: pull.state === 'closed' ? isoAt(pull.mergedSeq ?? pull.createdSeq) : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    draft: false,
  };
}

export function commitJson(repo: RepoRec, sha: string, info: { author: string; committer: string; message: string; tree: string; parents: readonly string[] }): Record<string, unknown> {
  const identity = (line: string): Record<string, unknown> => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  return {
    sha,
    node_id: Buffer.from(`crisp:Cm:${sha}`, 'utf8').toString('base64'),
    commit: {
      author: identity(info.author),
      committer: identity(info.committer),
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      comment_count: 0,
    },
    author: { login: OWNER_LOGIN, id: OWNER_ID },
    committer: { login: OWNER_LOGIN, id: OWNER_ID },
    parents: info.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}
