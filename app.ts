// Crisp Forge — a one-process, GitHub-compatible git forge.
//
// A single in-memory store backs four surfaces: git smart HTTP, the REST
// v3 API, the GraphQL v4 API and an MCP endpoint. Standard library only.
//
// The hot paths follow three rules:
//   1. a pack object is inflated exactly once — zlib reports how many
//      input bytes the stream consumed, so the reader never re-probes;
//   2. an object's hash is computed once, when the object is stored, and
//      every later lookup is a Map hit;
//   3. ancestry questions are answered by a depth-first walk that stops
//      the moment the target commit is found.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export const OWNER_LOGIN = "adaiversen";
const ZERO_SHA = "0000000000000000000000000000000000000000";

function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

// ---------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------

type ObjType = "blob" | "tree" | "commit" | "tag";
const TYPE_TO_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export class ObjectStore {
  objects = new Map<string, { type: ObjType; data: Buffer }>();
  private commitCache = new Map<string, CommitInfo>();
  private treeCache = new Map<string, TreeEntry[]>();
  private flatCache = new Map<string, Map<string, { mode: string; sha: string }>>();

  put(type: ObjType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, "latin1");
    const sha = sha1Hex(Buffer.concat([header, data]));
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): { type: ObjType; data: Buffer } | undefined {
    return this.objects.get(sha);
  }

  commitInfo(sha: string): CommitInfo | undefined {
    const hit = this.commitCache.get(sha);
    if (hit) return hit;
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== "commit") return undefined;
    const text = obj.data.toString("utf8");
    const splitAt = text.indexOf("\n\n");
    const head = splitAt === -1 ? text : text.slice(0, splitAt);
    const info: CommitInfo = { tree: "", parents: [], message: splitAt === -1 ? "" : text.slice(splitAt + 2), authorLine: "", committerLine: "" };
    for (const line of head.split("\n")) {
      if (line.startsWith("tree ")) info.tree = line.slice(5).trim();
      else if (line.startsWith("parent ")) info.parents.push(line.slice(7).trim());
      else if (line.startsWith("author ")) info.authorLine = line.slice(7);
      else if (line.startsWith("committer ")) info.committerLine = line.slice(10);
    }
    this.commitCache.set(sha, info);
    return info;
  }

  treeEntries(sha: string): TreeEntry[] {
    const hit = this.treeCache.get(sha);
    if (hit) return hit;
    const obj = this.objects.get(sha);
    const entries: TreeEntry[] = [];
    if (obj && obj.type === "tree") {
      let pos = 0;
      const buf = obj.data;
      while (pos < buf.length) {
        const space = buf.indexOf(0x20, pos);
        const mode = buf.toString("latin1", pos, space);
        const nul = buf.indexOf(0x00, space + 1);
        const name = buf.toString("utf8", space + 1, nul);
        const child = buf.toString("hex", nul + 1, nul + 21);
        entries.push({ mode, name, sha: child });
        pos = nul + 21;
      }
    }
    this.treeCache.set(sha, entries);
    return entries;
  }

  // Flatten a tree into path -> {mode, sha}; directories themselves are
  // included with mode "40000" so callers can list them.
  flattenTree(treeSha: string): Map<string, { mode: string; sha: string }> {
    const hit = this.flatCache.get(treeSha);
    if (hit) return hit;
    const out = new Map<string, { mode: string; sha: string }>();
    const walk = (sha: string, prefix: string): void => {
      for (const entry of this.treeEntries(sha)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        out.set(path, { mode: entry.mode, sha: entry.sha });
        if (entry.mode === "40000") walk(entry.sha, path);
      }
    };
    if (treeSha && this.objects.has(treeSha)) walk(treeSha, "");
    this.flatCache.set(treeSha, out);
    return out;
  }

  // Build nested trees from a flat path map and return the root tree sha.
  buildTree(flat: Map<string, { mode: string; sha: string }>): string {
    interface Node { files: Map<string, { mode: string; sha: string }>; dirs: Map<string, Node> }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, value] of flat) {
      if (value.mode === "40000") continue;
      const parts = path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let child = node.dirs.get(parts[i]);
        if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(parts[i], child); }
        node = child;
      }
      node.files.set(parts[parts.length - 1], value);
    }
    const emit = (node: Node): string => {
      const rows: { mode: string; name: string; sha: string }[] = [];
      for (const [name, dir] of node.dirs) rows.push({ mode: "40000", name, sha: emit(dir) });
      for (const [name, value] of node.files) rows.push({ mode: value.mode, name, sha: value.sha });
      rows.sort((a, b) => {
        const an = a.mode === "40000" ? `${a.name}/` : a.name;
        const bn = b.mode === "40000" ? `${b.name}/` : b.name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      const chunks: Buffer[] = [];
      for (const row of rows) {
        chunks.push(Buffer.from(`${row.mode} ${row.name}\0`, "utf8"));
        chunks.push(Buffer.from(row.sha, "hex"));
      }
      return this.put("tree", Buffer.concat(chunks));
    };
    return emit(root);
  }

  makeCommit(tree: string, parents: string[], message: string, ident: string): string {
    const stamp = Math.floor(Date.now() / 1000);
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${ident} ${stamp} +0000`);
    lines.push(`committer ${ident} ${stamp} +0000`);
    return this.put("commit", Buffer.from(`${lines.join("\n")}\n\n${message}`, "utf8"));
  }

  // Depth-first ancestry with early exit: true when `ancestor` is reachable
  // from `from` by following parent links. A linear history answers in one
  // step because the first parent tried is the direct parent.
  isAncestor(from: string, ancestor: string): boolean {
    if (from === ancestor) return true;
    const seen = new Set<string>();
    const stack: string[] = [from];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const info = this.commitInfo(current);
      if (!info) continue;
      for (const parent of info.parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) stack.push(parent);
      }
    }
    return false;
  }

  // Every commit reachable from `tips`, optionally stopping the walk at
  // commits in `stopAt`, optionally capped at `depth` generations from the
  // tips (depth 1 = the tips alone). Returns the set plus the boundary:
  // included commits whose parents were left out by the depth cap.
  closure(tips: string[], stopAt?: Set<string>, depth?: number): { commits: Set<string>; boundary: Set<string> } {
    const commits = new Set<string>();
    const boundary = new Set<string>();
    let frontier = tips.filter((t) => this.commitInfo(t) !== undefined);
    let generation = 0;
    while (frontier.length > 0) {
      generation += 1;
      const next: string[] = [];
      for (const sha of frontier) {
        if (commits.has(sha)) continue;
        if (stopAt && stopAt.has(sha)) continue;
        commits.add(sha);
        const info = this.commitInfo(sha);
        if (!info) continue;
        const capped = depth !== undefined && generation >= depth;
        for (const parent of info.parents) {
          if (capped) { boundary.add(sha); continue; }
          if (stopAt && stopAt.has(parent)) continue;
          if (!commits.has(parent)) next.push(parent);
        }
      }
      frontier = next;
    }
    return { commits, boundary };
  }

  mergeBase(a: string, b: string): string | undefined {
    const ancestorsOfA = this.closure([a]).commits;
    if (ancestorsOfA.has(b)) return b;
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsOfA.has(current)) return current;
      const info = this.commitInfo(current);
      if (info) queue.push(...info.parents);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

function encodePackObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_TO_CODE[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

// Read one object from a pack starting at `offset`. The zlib stream is
// inflated in a single call that reports the consumed input length, so the
// caller steps directly to the next object — no probing, no re-inflation.
function readPackObject(pack: Buffer, offset: number): { type: ObjType; data: Buffer; next: number; baseOffset?: number; baseSha?: string } {
  let pos = offset;
  const firstByte = pack[pos++];
  const typeCode = (firstByte >> 4) & 0x07;
  let size = firstByte & 0x0f;
  let shift = 4;
  let byte = firstByte;
  while (byte & 0x80) {
    byte = pack[pos++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  let baseOffset: number | undefined;
  let baseSha: string | undefined;
  if (typeCode === 6) {
    // ofs-delta: base is at (this object's offset) - (encoded negative offset)
    let b = pack[pos++];
    let back = b & 0x7f;
    while (b & 0x80) {
      b = pack[pos++];
      back = ((back + 1) << 7) | (b & 0x7f);
    }
    baseOffset = offset - back;
  } else if (typeCode === 7) {
    baseSha = pack.toString("hex", pos, pos + 20);
    pos += 20;
  }
  const rest = pack.subarray(pos);
  const result = inflateSync(rest, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const data = result.buffer;
  if (data.length !== size) {
    // Sizes in the header are authoritative; a mismatch means corruption.
    throw new Error(`pack object size mismatch: header ${size}, inflated ${data.length}`);
  }
  return { type: CODE_TO_TYPE[typeCode], data, next: pos + result.engine.bytesWritten, baseOffset, baseSha };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let b = 0;
    do {
      b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error("delta base size mismatch");
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) length = delta[pos++];
      if (op & 0x20) length |= delta[pos++] << 8;
      if (op & 0x40) length |= delta[pos++] << 16;
      if (length === 0) length = 0x10000;
      chunks.push(base.subarray(offset, offset + length));
      produced += length;
    } else if (op > 0) {
      chunks.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error("delta opcode 0 is reserved");
    }
  }
  const out = Buffer.concat(chunks);
  if (produced !== targetSize || out.length !== targetSize) throw new Error("delta target size mismatch");
  return out;
}

// Build a delta that turns `base` into `target`: copy the shared prefix,
// insert the differing middle, copy the shared suffix; when the middles
// still share a long anchor, split once more around it. Small, valid and
// effective for the one-file-change histories this forge mostly serves.
export function makeDelta(base: Buffer, target: Buffer): Buffer {
  const ops: { copyFrom?: number; copyLen?: number; insert?: Buffer }[] = [];
  let prefix = 0;
  const maxPrefix = Math.min(base.length, target.length);
  while (prefix < maxPrefix && base[prefix] === target[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(base.length - prefix, target.length - prefix);
  while (suffix < maxSuffix && base[base.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix += 1;
  const baseMidStart = prefix;
  const baseMidEnd = base.length - suffix;
  const targetMidStart = prefix;
  const targetMidEnd = target.length - suffix;
  if (prefix > 0) ops.push({ copyFrom: 0, copyLen: prefix });
  if (targetMidEnd > targetMidStart) {
    // Look for one long shared run inside the middles to copy instead of
    // inserting, which keeps deltas small for append-mostly edits.
    const midTarget = target.subarray(targetMidStart, targetMidEnd);
    const midBase = base.subarray(baseMidStart, baseMidEnd);
    let anchorAt = -1;
    let anchorBaseAt = -1;
    if (midTarget.length >= 32 && midBase.length >= 32) {
      const probe = midTarget.subarray(0, 32);
      const found = midBase.indexOf(probe);
      if (found !== -1) {
        // Extend the match as far as it goes.
        let len = 32;
        while (found + len < midBase.length && len < midTarget.length && midBase[found + len] === midTarget[len]) len += 1;
        anchorAt = len;
        anchorBaseAt = found;
        // The anchor starts at the target middle's first byte by
        // construction (the probe is the middle's own prefix), so the
        // copy covers the middle from its start; only the tail after
        // the matched run still needs an insert.
        ops.push({ copyFrom: baseMidStart + anchorBaseAt, copyLen: anchorAt });
        const restInsert = midTarget.subarray(anchorAt);
        if (restInsert.length > 0) ops.push({ insert: restInsert });
      } else {
        ops.push({ insert: midTarget });
      }
    } else {
      ops.push({ insert: midTarget });
    }
  }
  if (suffix > 0) ops.push({ copyFrom: base.length - suffix, copyLen: suffix });

  const header: number[] = [];
  const writeVarint = (value: number): void => {
    let v = value;
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      header.push(b);
    } while (v > 0);
  };
  writeVarint(base.length);
  writeVarint(target.length);
  const body: Buffer[] = [Buffer.from(header)];
  for (const op of ops) {
    if (op.insert) {
      let data = op.insert;
      while (data.length > 0) {
        const take = Math.min(127, data.length);
        body.push(Buffer.from([take]));
        body.push(data.subarray(0, take));
        data = data.subarray(take);
      }
    } else if (op.copyLen && op.copyLen > 0) {
      let from = op.copyFrom as number;
      let len = op.copyLen;
      while (len > 0) {
        const take = Math.min(len, 0x10000);
        let opcode = 0x80;
        const argBytes: number[] = [];
        if (from & 0xff) { opcode |= 0x01; argBytes.push(from & 0xff); }
        if (from & 0xff00) { opcode |= 0x02; argBytes.push((from >> 8) & 0xff); }
        if (from & 0xff0000) { opcode |= 0x04; argBytes.push((from >> 16) & 0xff); }
        if (from & 0xff000000) { opcode |= 0x08; argBytes.push((from >>> 24) & 0xff); }
        if (take & 0xff) { opcode |= 0x10; argBytes.push(take & 0xff); }
        if (take & 0xff00) { opcode |= 0x20; argBytes.push((take >> 8) & 0xff); }
        if (take & 0x10000) { opcode |= 0x40; argBytes.push(0); }
        body.push(Buffer.from([opcode, ...argBytes]));
        from += take;
        len -= take;
      }
    }
  }
  return Buffer.concat(body);
}

// Parse every object out of a received pack into the store. Delta bases may
// appear later in the same pack, so unresolved objects are retried until no
// progress is made.
export function absorbPack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 32 || pack.toString("latin1", 0, 4) !== "PACK") throw new Error("not a packfile");
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface Pending { type: ObjType; data: Buffer; baseOffset?: number; baseSha?: string; at: number }
  const pending: Pending[] = [];
  const byOffset = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const at = offset;
    const raw = readPackObject(pack, offset);
    offset = raw.next;
    if (raw.baseOffset === undefined && raw.baseSha === undefined) {
      const sha = store.put(raw.type, raw.data);
      byOffset.set(at, sha);
    } else {
      pending.push({ type: raw.type, data: raw.data, baseOffset: raw.baseOffset, baseSha: raw.baseSha, at });
    }
  }
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i];
      let baseSha: string | undefined;
      if (item.baseOffset !== undefined) baseSha = byOffset.get(item.baseOffset);
      else if (item.baseSha && store.has(item.baseSha)) baseSha = item.baseSha;
      if (!baseSha) continue;
      const baseObj = store.get(baseSha);
      if (!baseObj) continue;
      const resolved = applyDelta(baseObj.data, item.data);
      const sha = store.put(baseObj.type, resolved);
      byOffset.set(item.at, sha);
      pending.splice(i, 1);
      progressed = true;
    }
  }
  if (pending.length > 0) throw new Error(`${pending.length} pack objects could not be resolved`);
  return count;
}

// ---------------------------------------------------------------------------
// Repository domain store
// ---------------------------------------------------------------------------

interface LabelRec { id: number; name: string; color: string; description: string }
interface IssueRec {
  dbId: number; number: number; title: string; body: string;
  state: "open" | "closed"; labels: string[];
  createdSeq: number; createdAt: string; updatedAt: string;
}
interface CommentRec { id: number; body: string; createdAt: string; updatedAt: string }
interface PullRec {
  dbId: number; number: number; title: string; body: string;
  state: "open" | "closed"; merged: boolean;
  headRef: string; baseRef: string; headShaAtCreate: string; baseShaAtCreate: string;
  mergeCommitSha: string | null; mergedAt: string | null; closedAt: string | null;
  createdSeq: number; createdAt: string; updatedAt: string;
}

export interface RepoRec {
  dbId: number; owner: string; name: string; description: string;
  isPrivate: boolean;
  createdAt: string; updatedAt: string;
  store: ObjectStore;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  comments: Map<number, CommentRec[]>;
  packCache: Map<string, Buffer>;
}

function globalId(kind: string, key: string | number): string {
  return Buffer.from(`${kind}:${key}`, "utf8").toString("base64");
}

interface FileChange {
  filename: string; status: "added" | "modified" | "removed";
  sha: string; additions: number; deletions: number; changes: number; patch: string;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Line-level diff counts. Small files get an exact LCS; large ones fall
// back to a multiset comparison so a huge blob can never stall a request.
function diffCounts(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let additions = 0;
  let deletions = 0;
  let ops: { tag: string; line: string }[] = [];
  if (oldLines.length * newLines.length <= 4_000_000) {
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = oldLines.length - 1; i >= 0; i--) {
      for (let j = newLines.length - 1; j >= 0; j--) {
        table[i * cols + j] = oldLines[i] === newLines[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldLines.length && j < newLines.length) {
      if (oldLines[i] === newLines[j]) { ops.push({ tag: " ", line: oldLines[i] }); i++; j++; }
      else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { ops.push({ tag: "-", line: oldLines[i] }); deletions++; i++; }
      else { ops.push({ tag: "+", line: newLines[j] }); additions++; j++; }
    }
    while (i < oldLines.length) { ops.push({ tag: "-", line: oldLines[i] }); deletions++; i++; }
    while (j < newLines.length) { ops.push({ tag: "+", line: newLines[j] }); additions++; j++; }
  } else {
    const bag = new Map<string, number>();
    for (const line of oldLines) bag.set(line, (bag.get(line) ?? 0) + 1);
    for (const line of newLines) {
      const left = bag.get(line) ?? 0;
      if (left > 0) { bag.set(line, left - 1); ops.push({ tag: " ", line }); }
      else { ops.push({ tag: "+", line }); additions++; }
    }
    for (const [line, left] of bag) for (let k = 0; k < left; k++) { ops.push({ tag: "-", line }); deletions++; }
  }
  const patchLines = ops.map((op) => `${op.tag}${op.line}`);
  const patch = patchLines.length > 0 ? `@@ -1,${oldLines.length} +1,${newLines.length} @@\n${patchLines.join("\n")}` : "";
  return { additions, deletions, patch };
}

function changedFiles(store: ObjectStore, fromTree: string, toTree: string): FileChange[] {
  const before = store.flattenTree(fromTree);
  const after = store.flattenTree(toTree);
  const paths = new Set<string>();
  for (const p of before.keys()) if (before.get(p)?.mode !== "40000") paths.add(p);
  for (const p of after.keys()) if (after.get(p)?.mode !== "40000") paths.add(p);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && newEntry && oldEntry.sha === newEntry.sha) continue;
    const oldText = oldEntry ? (store.get(oldEntry.sha)?.data.toString("utf8") ?? "") : "";
    const newText = newEntry ? (store.get(newEntry.sha)?.data.toString("utf8") ?? "") : "";
    const counts = diffCounts(oldText, newText);
    out.push({
      filename: path,
      status: !oldEntry ? "added" : !newEntry ? "removed" : "modified",
      sha: (newEntry ?? oldEntry)?.sha ?? ZERO_SHA,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      patch: counts.patch,
    });
  }
  return out;
}

// Three-way tree merge over flattened path maps. Returns the merged flat
// map, or null when both sides changed the same path differently.
function mergeFlat(
  fork: Map<string, { mode: string; sha: string }>,
  base: Map<string, { mode: string; sha: string }>,
  head: Map<string, { mode: string; sha: string }>,
  unrelated = false,
): Map<string, { mode: string; sha: string }> | null {
  const out = new Map<string, { mode: string; sha: string }>();
  const paths = new Set<string>([...fork.keys(), ...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const f = fork.get(path);
    const b = base.get(path);
    const h = head.get(path);
    if (f?.mode === "40000" || b?.mode === "40000" || h?.mode === "40000") continue;
    const fs = f?.sha;
    const bs = b?.sha;
    const hs = h?.sha;
    let winner: { mode: string; sha: string } | undefined;
    if (hs === bs) winner = b;
    else if (fs === bs) winner = h;
    else if (fs === hs) winner = b;
    else if (unrelated && f === undefined) winner = h;
    else return null;
    if (winner) out.set(path, winner);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pack building for upload-pack
// ---------------------------------------------------------------------------

interface PackPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

function buildPackFor(
  repo: RepoRec,
  wants: string[],
  haveTips: string[],
  depth: number | undefined,
  clientShallow: string[],
): PackPlan {
  const store = repo.store;
  const cacheKey = [wants.slice().sort().join(","), haveTips.slice().sort().join(","), depth ?? 0, clientShallow.slice().sort().join(",")].join("|");
  const cached = repo.packCache.get(cacheKey);
  if (cached) {
    // Shallow lines depend only on the request shape, which the key covers;
    // recompute them cheaply from the same walk the cache was built with.
    const plan = planObjects(repo, wants, haveTips, depth, clientShallow);
    return { pack: cached, shallow: plan.shallow, unshallow: plan.unshallow };
  }
  const plan = planObjects(repo, wants, haveTips, depth, clientShallow);
  const pack = serializePack(repo, plan.objectShas);
  repo.packCache.set(cacheKey, pack);
  return { pack, shallow: plan.shallow, unshallow: plan.unshallow };
}

function planObjects(
  repo: RepoRec,
  wants: string[],
  haveTips: string[],
  depth: number | undefined,
  clientShallow: string[],
): { objectShas: string[]; shallow: string[]; unshallow: string[] } {
  const store = repo.store;
  const shallowSet = new Set(clientShallow);
  // What the client truly holds: the closure of its have tips, minus
  // everything below its shallow boundary — a shallow client never
  // received the boundary commits' ancestors, even when it names the
  // boundary itself as a have.
  const belowBoundary = new Set<string>();
  for (const boundaryCommit of clientShallow) {
    const info = store.commitInfo(boundaryCommit);
    if (info) for (const sha of store.closure(info.parents).commits) belowBoundary.add(sha);
  }
  const haveClosure = new Set<string>();
  if (haveTips.length > 0) {
    for (const sha of store.closure(haveTips).commits) {
      if (!belowBoundary.has(sha)) haveClosure.add(sha);
    }
  }
  const included = new Set<string>();
  const shallowOut = new Set<string>();
  const unshallowOut = new Set<string>();

  // One walk from the wants, depth counted in generations from the
  // wants. Full-history holds stop the walk (nothing below them is
  // owed); the client's shallow commits do not stop it — the walk
  // passes through them, which is what "deepen" means here: a depth
  // request re-measures the total depth from the wants, straight
  // through the old boundary. Commits the client already holds (its
  // haves and its boundary commits) are traversed but not re-sent.
  // The wants themselves are never stop points: a want that is also a
  // have (the deepen anchor) must still be traversed.
  const walkStop = new Set(haveClosure);
  for (const want of wants) walkStop.delete(want);
  const walked = store.closure(wants, walkStop, depth);
  for (const sha of walked.commits) {
    if (!haveClosure.has(sha) && !shallowSet.has(sha)) included.add(sha);
  }
  for (const sha of walked.boundary) {
    if (!haveClosure.has(sha)) shallowOut.add(sha);
  }

  // A client boundary stops being one once all its parents are either
  // delivered now or already present at the client in some form.
  for (const boundaryCommit of clientShallow) {
    const info = store.commitInfo(boundaryCommit);
    if (!info) { unshallowOut.add(boundaryCommit); continue; }
    if (info.parents.length === 0
      || info.parents.every((p) => included.has(p) || haveClosure.has(p) || shallowSet.has(p))) {
      unshallowOut.add(boundaryCommit);
    }
  }

  // Snapshots: every included commit contributes its full tree closure,
  // minus the trees and blobs the client provably has (the have closure's
  // snapshots). Dedup by sha throughout.
  const haveObjects = new Set<string>();
  for (const commitSha of haveClosure) {
    const info = store.commitInfo(commitSha);
    if (!info) continue;
    for (const [path, entry] of store.flattenTree(info.tree)) {
      haveObjects.add(entry.sha);
      if (entry.mode === "40000") continue;
      void path;
    }
  }
  const ordered: string[] = [];
  const emitted = new Set<string>();
  const emit = (sha: string): void => {
    if (emitted.has(sha) || haveObjects.has(sha)) return;
    if (!store.has(sha)) return;
    emitted.add(sha);
    ordered.push(sha);
  };
  // Commits first, newest first (the order the walk found them).
  for (const sha of included) emit(sha);
  // Then trees and blobs walking oldest commit first, so a newer blob can
  // delta against the older version of the same path emitted before it.
  const oldestFirst = [...included].reverse();
  for (const commitSha of oldestFirst) {
    const info = store.commitInfo(commitSha);
    if (!info) continue;
    emit(info.tree);
    const flat = store.flattenTree(info.tree);
    const dirShas = [...flat.entries()].filter(([, e]) => e.mode === "40000").map(([, e]) => e.sha);
    for (const dir of dirShas) emit(dir);
    for (const [, entry] of flat) if (entry.mode !== "40000") emit(entry.sha);
  }
  // Tag objects whose target is included.
  for (const [ref, target] of repo.refs) {
    if (!ref.startsWith("refs/tags/")) continue;
    const obj = store.get(target);
    if (obj && obj.type === "tag") {
      const inner = obj.data.toString("utf8");
      const match = /^object ([0-9a-f]{40})$/m.exec(inner);
      if (match && (included.has(match[1]) || emitted.has(match[1]))) emit(target);
    }
  }
  return { objectShas: ordered, shallow: [...shallowOut], unshallow: [...unshallowOut] };
}

function serializePack(repo: RepoRec, objectShas: string[]): Buffer {
  const store = repo.store;
  // Decide deltas: remember the last version emitted per path so a blob can
  // delta against its predecessor. Path identity comes from a fresh walk;
  // objects not reached by the walk (loose trees) are sent whole.
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objectShas.length, 8);
  chunks.push(header);
  let offset = 12;
  const offsetOf = new Map<string, number>();
  const lastByPath = new Map<string, string>();
  // Map each blob/tree sha to one path it appears at (first wins), walking
  // every commit that owns an emitted snapshot, oldest first.
  const commitsInPack = objectShas.filter((sha) => store.get(sha)?.type === "commit");
  const pathOf = new Map<string, string>();
  for (const commitSha of commitsInPack.slice().reverse()) {
    const info = store.commitInfo(commitSha);
    if (!info) continue;
    for (const [path, entry] of store.flattenTree(info.tree)) {
      if (!pathOf.has(entry.sha)) pathOf.set(entry.sha, path);
    }
  }
  for (const sha of objectShas) {
    const obj = store.get(sha);
    if (!obj) continue;
    let written: Buffer | undefined;
    const path = pathOf.get(sha);
    if (path && (obj.type === "blob" || obj.type === "tree")) {
      const previous = lastByPath.get(path);
      if (previous && previous !== sha && offsetOf.has(previous)) {
        const baseObj = store.get(previous);
        if (baseObj && baseObj.type === obj.type) {
          const delta = makeDelta(baseObj.data, obj.data);
          if (delta.length < obj.data.length) {
            const baseOffset = offsetOf.get(previous) as number;
            const back = offset - baseOffset;
            const head = encodeDeltaHeader(6, delta.length);
            const ofs = encodeOfsDistance(back);
            const packed = Buffer.concat([head, ofs, deflateSync(delta)]);
            chunks.push(packed);
            offsetOf.set(sha, offset);
            offset += packed.length;
            written = packed;
          }
        }
      }
      lastByPath.set(path, sha);
    }
    if (!written) {
      const packed = Buffer.concat([encodePackObjectHeader(obj.type, obj.data.length), deflateSync(obj.data)]);
      chunks.push(packed);
      offsetOf.set(sha, offset);
      offset += packed.length;
    }
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

function encodeDeltaHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

function encodeOfsDistance(back: number): Buffer {
  const bytes: number[] = [back & 0x7f];
  let rest = Math.floor(back / 128);
  while (rest > 0) {
    rest -= 1;
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const length = payload.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, "0"), "latin1");
  return Buffer.concat([prefix, payload]);
}

function pktFlush(): Buffer {
  return Buffer.from("0000", "latin1");
}

interface PktRead { lines: Buffer[]; rest: Buffer }
function readPktLines(buf: Buffer, start: number): PktRead {
  const lines: Buffer[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const lenText = buf.toString("latin1", pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) { pos += 4; return { lines, rest: buf.subarray(pos) }; }
    if (len === 1) { pos += 4; continue; } // delimiter packet: skip, keep reading
    if (len < 4 || pos + len > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return { lines, rest: buf.subarray(pos) };
}

function sidebandFrame(data: Buffer, progress?: string): Buffer {
  const parts: Buffer[] = [];
  if (progress) {
    const note = Buffer.from(progress, "utf8");
    for (let i = 0; i < note.length; i += 60000) {
      parts.push(pktLine(Buffer.concat([Buffer.from([2]), note.subarray(i, i + 60000)])));
    }
  }
  // A pkt-line is at most 65520 bytes in total, so each band-1 frame
  // carries at most 65515 payload bytes next to its band byte.
  for (let i = 0; i < data.length; i += 65515) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 65515)])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let requestCounter = 0;
function sendJson(res: ServerResponse, status: number, value?: unknown, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  const rid = `F${requestCounter.toString(36)}${Date.now().toString(36)}`.toUpperCase();
  const body = value === undefined ? "" : JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": rid,
    ...headers,
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-cache, max-age=0, must-revalidate" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function loginFor(req: IncomingMessage, expectedToken: string): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  if (token.length === 0) return null;
  if (token === expectedToken) return OWNER_LOGIN;
  return `guest-${sha1Hex(Buffer.from(token, "utf8")).slice(0, 10)}`;
}

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1,
    node_id: globalId("User", login),
    avatar_url: "",
    gravatar_id: "",
    url: `https://api.github.local/users/${login}`,
    html_url: `https://github.local/${login}`,
    type: "User",
    site_admin: false,
  };
}

// ---------------------------------------------------------------------------
// The forge: one store, four surfaces
// ---------------------------------------------------------------------------

export class Forge {
  repos = new Map<string, RepoRec>();
  private repoDbSeq = 0;
  private issueDbSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  byDbId = new Map<number, { kind: "issue" | "pull"; repo: RepoRec; number: number }>();
  private expectedToken: string;

  constructor(expectedToken: string) {
    this.expectedToken = expectedToken;
  }

  createRepo(owner: string, name: string, description: string, isPrivate = false): RepoRec {
    this.repoDbSeq += 1;
    const stamp = nowIso();
    const repo: RepoRec = {
      dbId: this.repoDbSeq, owner, name, description: description ?? "",
      isPrivate,
      createdAt: stamp, updatedAt: stamp,
      store: new ObjectStore(),
      refs: new Map(), nextNumber: 1,
      issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(),
      packCache: new Map(),
    };
    // Every repository starts with an empty tree object ready to use.
    repo.store.put("tree", Buffer.alloc(0));
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  resolveRepo(owner: string, name: string, login: string): RepoRec | null {
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo || repo.owner !== login) return null;
    return repo;
  }

  repoJson(repo: RepoRec): Record<string, unknown> {
    const apiBase = "https://api.github.local";
    const openCount = [...repo.issues.values()].filter((i) => i.state === "open").length
      + [...repo.pulls.values()].filter((p) => p.state === "open").length;
    return {
      id: repo.dbId,
      node_id: globalId("Repository", repo.dbId),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: userJson(repo.owner),
      private: repo.isPrivate,
      html_url: `https://github.local/${repo.owner}/${repo.name}`,
      description: repo.description,
      fork: false,
      url: `${apiBase}/repos/${repo.owner}/${repo.name}`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.updatedAt,
      git_url: `git://github.local/${repo.owner}/${repo.name}.git`,
      ssh_url: `git@github.local:${repo.owner}/${repo.name}.git`,
      clone_url: `https://github.local/${repo.owner}/${repo.name}.git`,
      default_branch: "main",
      visibility: "public",
      forks_count: 0,
      watchers_count: 0,
      stargazers_count: 0,
      size: 1,
      open_issues_count: openCount,
      has_issues: true,
      has_projects: false,
      has_downloads: false,
      has_wiki: false,
      has_pages: false,
      license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: null },
      topics: [],
      archived: false,
      disabled: false,
    };
  }

  labelJson(label: LabelRec): Record<string, unknown> {
    return {
      id: label.id,
      node_id: globalId("Label", label.id),
      url: `https://api.github.local/labels/${label.id}`,
      name: label.name,
      color: label.color,
      description: label.description,
      default: false,
    };
  }

  issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
    const apiBase = "https://api.github.local";
    return {
      id: issue.dbId,
      node_id: globalId("Issue", issue.dbId),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      user: userJson(repo.owner),
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return label ? this.labelJson(label) : { name };
      }),
      state: issue.state,
      assignees: [],
      assignee: null,
      milestone: null,
      comments: (repo.comments.get(issue.number) ?? []).length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.state === "closed" ? issue.updatedAt : null,
      url: `${apiBase}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      repository_url: `${apiBase}/repos/${repo.owner}/${repo.name}`,
      html_url: `https://github.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  commentJson(repo: RepoRec, issueNumber: number, comment: CommentRec): Record<string, unknown> {
    const apiBase = "https://api.github.local";
    return {
      id: comment.id,
      node_id: globalId("IssueComment", comment.id),
      body: comment.body,
      user: userJson(repo.owner),
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      url: `${apiBase}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      html_url: `https://github.local/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
      issue_url: `${apiBase}/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    };
  }

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    this.issueDbSeq += 1;
    const stamp = nowIso();
    const issue: IssueRec = {
      dbId: this.issueDbSeq, number: repo.nextNumber++, title, body: body ?? "",
      state: "open", labels: labels.slice(), createdSeq: nextSeq(), createdAt: stamp, updatedAt: stamp,
    };
    repo.issues.set(issue.number, issue);
    this.byDbId.set(issue.dbId, { kind: "issue", repo, number: issue.number });
    return issue;
  }

  addComment(repo: RepoRec, issueNumber: number, body: string): CommentRec {
    this.commentSeq += 1;
    const stamp = nowIso();
    const comment: CommentRec = { id: this.commentSeq, body, createdAt: stamp, updatedAt: stamp };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  createLabel(repo: RepoRec, name: string, color: string, description: string): LabelRec {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    this.labelSeq += 1;
    const label: LabelRec = { id: this.labelSeq, name, color: color || "ededed", description: description ?? "" };
    repo.labels.set(name, label);
    return label;
  }

  tipOf(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    this.issueDbSeq += 1;
    const stamp = nowIso();
    const pull: PullRec = {
      dbId: this.issueDbSeq, number: repo.nextNumber++, title, body: body ?? "",
      state: "open", merged: false, headRef, baseRef,
      headShaAtCreate: this.tipOf(repo, headRef) ?? ZERO_SHA,
      baseShaAtCreate: this.tipOf(repo, baseRef) ?? ZERO_SHA,
      mergeCommitSha: null, mergedAt: null, closedAt: null,
      createdSeq: nextSeq(), createdAt: stamp, updatedAt: stamp,
    };
    repo.pulls.set(pull.number, pull);
    this.byDbId.set(pull.dbId, { kind: "pull", repo, number: pull.number });
    return pull;
  }

  // Attempt the three-way merge a pull request needs. Returns the merged
  // tree sha, or null when the two sides changed the same path differently.
  tryMerge(repo: RepoRec, pull: PullRec): string | null {
    const store = repo.store;
    const headTip = this.tipOf(repo, pull.headRef);
    const baseTip = this.tipOf(repo, pull.baseRef);
    if (!headTip || !baseTip) return null;
    const forkSha = store.mergeBase(headTip, baseTip);
    const baseInfo = store.commitInfo(baseTip);
    const headInfo = store.commitInfo(headTip);
    if (!baseInfo || !headInfo) return null;
    // Unrelated histories merge against an empty fork tree; on a path
    // both sides created independently, the head side wins.
    const forkInfo = forkSha ? store.commitInfo(forkSha) : undefined;
    if (forkSha && !forkInfo) return null;
    const merged = mergeFlat(
      forkInfo ? store.flattenTree(forkInfo.tree) : new Map(),
      store.flattenTree(baseInfo.tree),
      store.flattenTree(headInfo.tree),
      forkSha === null,
    );
    if (!merged) return null;
    return store.buildTree(merged);
  }

  pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
    const apiBase = "https://api.github.local";
    const headSha = this.tipOf(repo, pull.headRef) ?? pull.headShaAtCreate;
    const baseSha = this.tipOf(repo, pull.baseRef) ?? pull.baseShaAtCreate;
    const mergeable = pull.merged ? true : this.tryMerge(repo, pull) !== null;
    const refJson = (ref: string, sha: string): Record<string, unknown> => ({
      label: `${repo.owner}:${ref}`,
      ref,
      sha,
      user: userJson(repo.owner),
      repo: this.repoJson(repo),
    });
    return {
      id: pull.dbId,
      node_id: globalId("PullRequest", pull.dbId),
      number: pull.number,
      state: pull.merged ? "closed" : pull.state,
      title: pull.title,
      body: pull.body,
      user: userJson(repo.owner),
      labels: [],
      draft: false,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.closedAt,
      merged_at: pull.mergedAt,
      merged: pull.merged,
      mergeable,
      mergeable_state: pull.merged ? "clean" : mergeable ? "clean" : "dirty",
      merge_commit_sha: pull.mergeCommitSha,
      head: refJson(pull.headRef, headSha),
      base: refJson(pull.baseRef, baseSha),
      url: `${apiBase}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      html_url: `https://github.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
      diff_url: `https://github.local/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
      patch_url: `https://github.local/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    };
  }

  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const store = repo.store;
    const headTip = this.tipOf(repo, pull.headRef);
    const baseTip = this.tipOf(repo, pull.baseRef);
    if (!headTip || !baseTip) return [];
    const forkSha = store.mergeBase(headTip, baseTip) ?? baseTip;
    const forkInfo = store.commitInfo(forkSha);
    const headInfo = store.commitInfo(headTip);
    if (!forkInfo || !headInfo) return [];
    return changedFiles(store, forkInfo.tree, headInfo.tree);
  }

  // Merge a pull request into its base branch. Returns the new commit sha,
  // or the string "conflict" / "gone" for the two failure shapes.
  mergePull(repo: RepoRec, pull: PullRec, method: string, commitTitle: string, commitMessage: string): string {
    const store = repo.store;
    const headTip = this.tipOf(repo, pull.headRef);
    const baseTip = this.tipOf(repo, pull.baseRef);
    if (!headTip || !baseTip) return "gone";
    const mergedTree = this.tryMerge(repo, pull);
    if (mergedTree === null) return "conflict";
    const ident = `${repo.owner} <${repo.owner}@forge.local>`;
    const message = commitTitle
      ? `${commitTitle}${commitMessage ? `\n\n${commitMessage}` : ""}`
      : `${pull.title}${pull.body ? `\n\n${pull.body}` : ""}`;
    let newSha: string;
    if (method === "merge") {
      newSha = store.makeCommit(mergedTree, [baseTip, headTip], message || "Merge pull request", ident);
    } else {
      newSha = store.makeCommit(mergedTree, [baseTip], message || pull.title, ident);
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, newSha);
    repo.packCache.clear();
    const stamp = nowIso();
    pull.merged = true;
    pull.state = "closed";
    pull.mergeCommitSha = newSha;
    pull.mergedAt = stamp;
    pull.closedAt = stamp;
    pull.updatedAt = stamp;
    repo.updatedAt = stamp;
    return newSha;
  }
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS = "multi_ack_detailed side-band side-band-64k ofs-delta shallow no-done agent=crisp-forge/1.0 symref=HEAD:refs/heads/main";
const RECEIVE_CAPS = "report-status side-band-64k delete-refs ofs-delta agent=crisp-forge/1.0";

function sortedRefEntries(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledTarget(repo: RepoRec, tagSha: string): string | null {
  let current = tagSha;
  for (let depth = 0; depth < 8; depth++) {
    const obj = repo.store.get(current);
    if (!obj || obj.type !== "tag") return depth > 0 ? current : null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString("utf8"));
    if (!match) return null;
    current = match[1];
  }
  return current;
}

function advertiseRefs(repo: RepoRec, service: "git-upload-pack" | "git-receive-pack"): Buffer {
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps = service === "git-upload-pack" ? UPLOAD_CAPS : RECEIVE_CAPS;
  const headSha = repo.refs.get("refs/heads/main") ?? ZERO_SHA;
  if (repo.refs.size === 0) {
    if (service === "git-upload-pack") lines.push(pktLine(`${ZERO_SHA} HEAD\0${caps}\n`));
    else lines.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
    lines.push(pktFlush());
    return Buffer.concat(lines);
  }
  let first = true;
  const pushLine = (text: string): void => {
    if (first) { lines.push(pktLine(`${text}\0${caps}\n`)); first = false; }
    else lines.push(pktLine(`${text}\n`));
  };
  if (service === "git-upload-pack") pushLine(`${headSha} HEAD`);
  for (const [ref, sha] of sortedRefEntries(repo)) {
    pushLine(`${sha} ${ref}`);
    const peeled = peeledTarget(repo, sha);
    if (peeled && ref.startsWith("refs/tags/")) pushLine(`${peeled} ${ref}^{}`);
  }
  if (first) pushLine(`${ZERO_SHA} capabilities^{}`);
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function handleLsRefs(repo: RepoRec, lines: string[], res: ServerResponse): void {
  let wantPeel = false;
  let wantSymrefs = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === "peel") wantPeel = true;
    else if (line === "symrefs") wantSymrefs = true;
    else if (line.startsWith("ref-prefix ")) prefixes.push(line.slice("ref-prefix ".length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const headSha = repo.refs.get("refs/heads/main") ?? ZERO_SHA;
  if (matches("HEAD")) {
    out.push(pktLine(`${headSha} HEAD${wantSymrefs ? " symref-target:refs/heads/main" : ""}\n`));
  }
  for (const [ref, sha] of sortedRefEntries(repo)) {
    if (!matches(ref)) continue;
    let suffix = "";
    if (wantPeel) {
      const peeled = peeledTarget(repo, sha);
      if (peeled) suffix = ` peeled:${peeled}`;
    }
    out.push(pktLine(`${sha} ${ref}${suffix}\n`));
  }
  out.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(out), "application/x-git-upload-pack-result");
}

function handleUploadPack(repo: RepoRec, body: Buffer, isV2: boolean, res: ServerResponse): void {
  // A v0 request is several pkt-line segments separated by flush packets
  // (wants, then haves, then done); parse across the flushes so the have
  // lines are seen too.
  const rawLines: Buffer[] = [];
  let segment = readPktLines(body, 0);
  rawLines.push(...segment.lines);
  while (segment.rest.length >= 4) {
    const next = readPktLines(segment.rest, 0);
    if (next.lines.length === 0 && next.rest.length === segment.rest.length) break;
    rawLines.push(...next.lines);
    segment = next;
  }
  const lines = rawLines.map((l) => l.toString("latin1").replace(/\n$/, ""));
  if (isV2) {
    const commandLine = lines.find((l) => l.startsWith("command="));
    const command = commandLine ? commandLine.slice("command=".length) : "";
    if (command === "ls-refs") { handleLsRefs(repo, lines, res); return; }
    if (command !== "fetch") {
      sendRaw(res, 200, pktFlush(), "application/x-git-upload-pack-result");
      return;
    }
  }
  let caps = "";
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let doneReceived = false;
  for (const rawLine of lines) {
    let line = rawLine;
    const nul = line.indexOf("\0");
    if (nul >= 0) { caps = `${caps} ${line.slice(nul + 1)}`; line = line.slice(0, nul); }
    if (line.startsWith("want ")) {
      wants.push(line.slice(5, 45));
      // Modern git puts the first want line's capabilities after the sha,
      // space-separated (older style puts them after a NUL, handled above).
      const tail = line.slice(45).trim();
      if (tail) caps = `${caps} ${tail}`;
    }
    else if (line.startsWith("have ")) haves.push(line.slice(5, 45));
    else if (line.startsWith("shallow ")) clientShallow.push(line.slice(8, 48));
    else if (line.startsWith("deepen ")) depth = parseInt(line.slice(7), 10) || undefined;
    else if (line === "done") doneReceived = true;
    else if (line === "side-band" || line.startsWith("side-band ")) caps = `${caps} side-band-64k`;
  }
  const plan = buildPackFor(repo, wants, haves, depth, clientShallow);
  const parts: Buffer[] = [];
  if (isV2) {
    // Sections are separated by delimiter packets and the reply ends
    // with a flush. A request with haves is answered with an
    // acknowledgments section first ("ready" tells the client the
    // packfile follows in this same reply); then the shallow-info
    // section when the boundary moves; then the packfile section,
    // sideband-framed, as in real git.
    const commons = haves.filter((h) => repo.store.commitInfo(h) !== undefined);
    if (haves.length > 0) {
      parts.push(pktLine("acknowledgments\n"));
      if (commons.length === 0) parts.push(pktLine("NAK\n"));
      else {
        for (const c of commons) parts.push(pktLine(`ACK ${c}\n`));
        parts.push(pktLine("ready\n"));
      }
      parts.push(Buffer.from("0001", "latin1"));
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine("shallow-info\n"));
      for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(Buffer.from("0001", "latin1"));
    }
    parts.push(pktLine("packfile\n"));
    parts.push(sidebandFrame(plan.pack));
    sendRaw(res, 200, Buffer.concat(parts), "application/x-git-upload-pack-result");
    return;
  }
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  const commons = haves.filter((h) => repo.store.commitInfo(h) !== undefined);
  if (caps.includes("multi_ack_detailed")) {
    for (const c of commons) parts.push(pktLine(`ACK ${c} common\n`));
    parts.push(pktLine(commons.length > 0 ? `ACK ${commons[commons.length - 1]} ready\n` : "NAK\n"));
  } else if (commons.length > 0) {
    parts.push(pktLine(`ACK ${commons[commons.length - 1]}\n`));
  } else {
    parts.push(pktLine("NAK\n"));
  }
  if (caps.includes("side-band-64k") || caps.includes("side-band")) parts.push(sidebandFrame(plan.pack));
  else parts.push(plan.pack);
  sendRaw(res, 200, Buffer.concat(parts), "application/x-git-upload-pack-result");
}

function handleReceivePack(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const { lines: rawLines, rest } = readPktLines(body, 0);
  let caps = "";
  interface Update { oldSha: string; newSha: string; ref: string }
  const updates: Update[] = [];
  for (const raw of rawLines) {
    let line = raw.toString("latin1").replace(/\n$/, "");
    const nul = line.indexOf("\0");
    if (nul >= 0) { caps = `${caps} ${line.slice(nul + 1)}`; line = line.slice(0, nul); }
    const parts = line.split(" ");
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      updates.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
    }
  }
  let unpackOk = true;
  if (rest.length >= 4 && rest.toString("latin1", 0, 4) === "PACK") {
    try { absorbPack(repo.store, rest); } catch { unpackOk = false; }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const update of updates) {
    const fail = (reason: string): void => { results.push({ ref: update.ref, ok: false, reason }); };
    if (!unpackOk) { fail("unpacker error"); continue; }
    if (!update.ref.startsWith("refs/")) { fail("invalid ref"); continue; }
    const current = repo.refs.get(update.ref) ?? ZERO_SHA;
    if (update.oldSha !== current) { fail("stale ref"); continue; }
    if (update.newSha === ZERO_SHA) {
      if (update.ref === "refs/heads/main") { fail("deletion of the current branch prohibited"); continue; }
      repo.refs.delete(update.ref);
      results.push({ ref: update.ref, ok: true, reason: "" });
      continue;
    }
    const target = repo.store.get(update.newSha);
    if (!target) { fail("bad object"); continue; }
    if (update.ref.startsWith("refs/heads/")) {
      if (target.type !== "commit") { fail("bad object"); continue; }
      if (update.oldSha !== ZERO_SHA && !repo.store.isAncestor(update.newSha, update.oldSha)) {
        fail("non-fast-forward");
        continue;
      }
    }
    repo.refs.set(update.ref, update.newSha);
    results.push({ ref: update.ref, ok: true, reason: "" });
  }
  if (results.some((r) => r.ok)) {
    repo.packCache.clear();
    repo.updatedAt = nowIso();
  }
  if (!caps.includes("report-status")) {
    sendRaw(res, 200, Buffer.alloc(0), "application/x-git-receive-pack-result");
    return;
  }
  const report: Buffer[] = [pktLine(unpackOk ? "unpack ok\n" : "unpack failed\n")];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  const reportBytes = Buffer.concat(report);
  if (caps.includes("side-band-64k") || caps.includes("side-band")) {
    // The report is a pkt-line stream inside band 1, so it needs its own
    // terminating flush within the band payload, before the outer flush
    // that ends the sideband stream itself.
    sendRaw(res, 200, sidebandFrame(Buffer.concat([reportBytes, pktFlush()])), "application/x-git-receive-pack-result");
  } else {
    sendRaw(res, 200, Buffer.concat([reportBytes, pktFlush()]), "application/x-git-receive-pack-result");
  }
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function paginate(req: IncomingMessage, url: URL, items: unknown[]): { slice: unknown[]; headers: Record<string, string> } {
  const perPageRaw = parseInt(url.searchParams.get("per_page") ?? "", 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
  const pageRaw = parseInt(url.searchParams.get("page") ?? "", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < items.length) {
    const host = req.headers.host ?? "localhost";
    const build = (p: number): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set("per_page", String(perPage));
      params.set("page", String(p));
      return `<http://${host}${url.pathname}?${params.toString()}>`;
    };
    const lastPage = Math.ceil(items.length / perPage);
    headers["link"] = `${build(page + 1)}; rel="next", ${build(lastPage)}; rel="last"`;
  }
  return { slice, headers };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: "", date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
}

function commitJson(repo: RepoRec, sha: string): Record<string, unknown> {
  const info = repo.store.commitInfo(sha);
  const apiBase = "https://api.github.local";
  const author = parseIdent(info?.authorLine ?? "");
  const committer = parseIdent(info?.committerLine ?? "");
  return {
    sha,
    node_id: globalId("Commit", sha),
    url: `${apiBase}/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.local/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: info?.message ?? "",
      tree: { sha: info?.tree ?? ZERO_SHA, url: `${apiBase}/repos/${repo.owner}/${repo.name}/git/trees/${info?.tree ?? ZERO_SHA}` },
      comment_count: 0,
    },
    author: { login: repo.owner },
    committer: { login: repo.owner },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: `${apiBase}/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, login: string, body: Record<string, unknown> | undefined): void {
  const method = req.method ?? "GET";
  const rest = url.pathname.slice("/api/v3".length);
  const notFound = (): void => sendJson(res, 404, { message: "Not Found" });

  if (rest === "" || rest === "/") {
    if (method !== "GET") { notFound(); return; }
    sendJson(res, 200, {
      current_user_url: "https://api.github.local/user",
      repository_url: "https://api.github.local/repos/{owner}/{repo}",
      issue_search_url: "https://api.github.local/search/issues?q={query}",
      emojis_url: "https://api.github.local/emojis",
    }, { "x-oauth-scopes": "repo, read:org" });
    return;
  }
  if (rest === "/meta") {
    sendJson(res, 200, { installed_version: "crisp-forge 1.0.0", verifiable_password_authentication: false, ssh_key_fingerprints: {}, pages: [] });
    return;
  }
  if (rest === "/user") {
    sendJson(res, 200, userJson(login));
    return;
  }
  if (rest === "/user/repos") {
    if (method === "GET") {
      const mine = [...forge.repos.values()].filter((r) => r.owner === login).map((r) => forge.repoJson(r));
      const { slice, headers } = paginate(req, url, mine);
      sendJson(res, 200, slice, headers);
      return;
    }
    if (method === "POST") {
      const name = typeof body?.name === "string" ? body.name : "";
      if (!name) { sendJson(res, 422, { message: "Validation Failed: name is required" }); return; }
      if (forge.repos.has(`${login}/${name}`)) { sendJson(res, 422, { message: "Validation Failed: name already exists on this account" }); return; }
      const repo = forge.createRepo(login, name, typeof body?.description === "string" ? body.description : "", body?.private === true);
      sendJson(res, 201, forge.repoJson(repo));
      return;
    }
    notFound();
    return;
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
  if (!repoMatch) { notFound(); return; }
  const owner = decodeURIComponent(repoMatch[1]);
  const name = decodeURIComponent(repoMatch[2]);
  const tail = repoMatch[3] ?? "";
  const repo = forge.resolveRepo(owner, name, login);
  if (!repo) { notFound(); return; }
  const store = repo.store;

  if (tail === "") {
    if (method === "GET") { sendJson(res, 200, forge.repoJson(repo)); return; }
    if (method === "PATCH") {
      if (typeof body?.description === "string") repo.description = body.description;
      if (typeof body?.private === "boolean") repo.isPrivate = body.private;
      if (typeof body?.name === "string" && body.name !== repo.name) {
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = body.name;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      repo.updatedAt = nowIso();
      sendJson(res, 200, forge.repoJson(repo));
      return;
    }
    if (method === "DELETE") {
      forge.repos.delete(`${repo.owner}/${repo.name}`);
      sendJson(res, 204);
      return;
    }
    notFound();
    return;
  }

  // Git database API: references and raw objects.
  const gitRefJson = (ref: string, sha: string): Record<string, unknown> => {
    const obj = store.get(sha);
    return {
      ref,
      node_id: globalId("GitRef", `${repo.owner}/${repo.name}:${ref}`),
      url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, "")}`,
      object: {
        sha,
        type: obj?.type ?? "commit",
        url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/${obj?.type === "tree" ? "trees" : obj?.type === "blob" ? "blobs" : obj?.type === "tag" ? "tags" : "commits"}/${sha}`,
      },
    };
  };
  if (tail === "/git/refs") {
    if (method === "GET") {
      sendJson(res, 200, [...repo.refs.entries()].map(([ref, sha]) => gitRefJson(ref, sha)));
      return;
    }
    if (method === "POST") {
      const ref = typeof body?.ref === "string" ? body.ref : "";
      const sha = typeof body?.sha === "string" ? body.sha : "";
      if (!ref.startsWith("refs/") || !store.has(sha)) {
        sendJson(res, 422, { message: "Validation Failed: ref and a known object sha are required" });
        return;
      }
      if (repo.refs.has(ref)) { sendJson(res, 422, { message: "Validation Failed: Reference already exists" }); return; }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      repo.updatedAt = nowIso();
      sendJson(res, 201, gitRefJson(ref, sha));
      return;
    }
    notFound();
    return;
  }
  const gitRefMatch = /^\/git\/refs\/(.+)$/.exec(tail);
  if (gitRefMatch) {
    const ref = `refs/${decodeURIComponent(gitRefMatch[1])}`;
    const current = repo.refs.get(ref);
    if (method === "GET") {
      if (!current) { notFound(); return; }
      sendJson(res, 200, gitRefJson(ref, current));
      return;
    }
    if (method === "PATCH") {
      const sha = typeof body?.sha === "string" ? body.sha : "";
      if (!current || !store.has(sha)) { notFound(); return; }
      if (body?.force !== true && store.commitInfo(current) && store.commitInfo(sha)
        && !store.isAncestor(sha, current)) {
        sendJson(res, 422, { message: "Validation Failed: not a fast-forward" });
        return;
      }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      repo.updatedAt = nowIso();
      sendJson(res, 200, gitRefJson(ref, sha));
      return;
    }
    if (method === "DELETE") {
      if (!current) { notFound(); return; }
      repo.refs.delete(ref);
      repo.packCache.clear();
      sendJson(res, 204);
      return;
    }
    notFound();
    return;
  }
  const gitCommitMatch = /^\/git\/commits\/([0-9a-f]{40})$/.exec(tail);
  if (gitCommitMatch && method === "GET") {
    const info = store.commitInfo(gitCommitMatch[1]);
    if (!info) { notFound(); return; }
    const identOf = (line: string): { name: string; email: string; date: string } => {
      const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (!m) return { name: repo.owner, email: `${repo.owner}@forge.local`, date: repo.createdAt };
      return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() };
    };
    sendJson(res, 200, {
      sha: gitCommitMatch[1],
      node_id: globalId("GitCommit", gitCommitMatch[1]),
      url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/commits/${gitCommitMatch[1]}`,
      author: identOf(info.authorLine),
      committer: identOf(info.committerLine),
      message: info.message,
      tree: { sha: info.tree, url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/trees/${info.tree}` },
      parents: info.parents.map((p) => ({ sha: p, url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/commits/${p}` })),
    });
    return;
  }
  const gitTreeMatch = /^\/git\/trees\/([0-9a-f]{40})$/.exec(tail);
  if (gitTreeMatch && method === "GET") {
    const obj = store.get(gitTreeMatch[1]);
    if (!obj || obj.type !== "tree") { notFound(); return; }
    const entries = store.treeEntries(gitTreeMatch[1]).map((e) => ({
      path: e.name,
      mode: e.mode,
      type: e.mode === "40000" ? "tree" : "blob",
      sha: e.sha,
      url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/${e.mode === "40000" ? "trees" : "blobs"}/${e.sha}`,
    }));
    sendJson(res, 200, { sha: gitTreeMatch[1], url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/trees/${gitTreeMatch[1]}`, tree: entries, truncated: false });
    return;
  }
  const gitBlobMatch = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(tail);
  if (gitBlobMatch && method === "GET") {
    const obj = store.get(gitBlobMatch[1]);
    if (!obj || obj.type !== "blob") { notFound(); return; }
    sendJson(res, 200, {
      sha: gitBlobMatch[1],
      node_id: globalId("GitBlob", gitBlobMatch[1]),
      url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/blobs/${gitBlobMatch[1]}`,
      content: obj.data.toString("base64"),
      encoding: "base64",
      size: obj.data.length,
    });
    return;
  }

  if (tail === "/branches" && method === "GET") {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith("refs/heads/"))
      .map(([ref, sha]) => ({
        name: ref.slice("refs/heads/".length),
        commit: { sha, url: `https://api.github.local/repos/${repo.owner}/${repo.name}/commits/${sha}` },
        protected: false,
      }));
    sendJson(res, 200, branches);
    return;
  }
  const branchMatch = /^\/branches\/(.+)$/.exec(tail);
  if (branchMatch && method === "GET") {
    const branchName = decodeURIComponent(branchMatch[1]);
    const sha = repo.refs.get(`refs/heads/${branchName}`);
    if (!sha) { notFound(); return; }
    sendJson(res, 200, { name: branchName, commit: commitJson(repo, sha), protected: false, _links: {} });
    return;
  }

  if (tail === "/commits" && method === "GET") {
    const startRef = url.searchParams.get("sha") ?? "main";
    const tip = repo.refs.get(`refs/heads/${startRef}`) ?? (store.has(startRef) ? startRef : undefined);
    if (!tip) { sendJson(res, 200, []); return; }
    const ordered: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      ordered.push(sha);
      const info = store.commitInfo(sha);
      if (info) for (let i = info.parents.length - 1; i >= 0; i--) stack.push(info.parents[i]);
    }
    const all = ordered.map((sha) => commitJson(repo, sha));
    const { slice, headers } = paginate(req, url, all);
    sendJson(res, 200, slice, headers);
    return;
  }

  const contentsMatch = /^\/contents(?:\/(.*))?$/.exec(tail);
  if (contentsMatch) {
    const path = decodeURIComponent(contentsMatch[1] ?? "").replace(/^\/+|\/+$/g, "");
    const branchName = (method === "GET" ? url.searchParams.get("ref") : (body?.branch as string | undefined)) ?? "main";
    const tip = repo.refs.get(`refs/heads/${branchName}`);
    if (method === "GET") {
      if (!tip) { sendJson(res, 404, { message: "This repository is empty." }); return; }
      const info = store.commitInfo(tip);
      if (!info) { notFound(); return; }
      const flat = store.flattenTree(info.tree);
      const entry = path === "" ? undefined : flat.get(path);
      const listing = (dirPath: string): Record<string, unknown>[] => {
        const prefix = dirPath === "" ? "" : `${dirPath}/`;
        const seenNames = new Map<string, { mode: string; sha: string }>();
        for (const [p, e] of flat) {
          if (!p.startsWith(prefix)) continue;
          const remainder = p.slice(prefix.length);
          if (remainder === "") continue;
          const firstSegment = remainder.split("/")[0];
          const existing = seenNames.get(firstSegment);
          const fullPath = prefix + firstSegment;
          const direct = flat.get(fullPath);
          if (!existing && direct) seenNames.set(firstSegment, direct);
        }
        return [...seenNames.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([childName, e]) => ({
          name: childName,
          path: prefix + childName,
          sha: e.sha,
          size: 0,
          type: e.mode === "40000" ? "dir" : "file",
          url: `https://api.github.local/repos/${repo.owner}/${repo.name}/contents/${prefix + childName}`,
          html_url: `https://github.local/${repo.owner}/${repo.name}/blob/${branchName}/${prefix + childName}`,
          git_url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/${e.mode === "40000" ? "trees" : "blobs"}/${e.sha}`,
          download_url: null,
        }));
      };
      if (path === "" || (entry && entry.mode === "40000")) {
        sendJson(res, 200, listing(path));
        return;
      }
      if (!entry) { notFound(); return; }
      const blob = store.get(entry.sha);
      if (!blob) { notFound(); return; }
      sendJson(res, 200, {
        name: path.split("/").pop(),
        path,
        sha: entry.sha,
        size: blob.data.length,
        type: "file",
        encoding: "base64",
        content: blob.data.toString("base64"),
        url: `https://api.github.local/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.local/${repo.owner}/${repo.name}/blob/${branchName}/${path}`,
        git_url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
        download_url: `https://github.local/${repo.owner}/${repo.name}/raw/${branchName}/${path}`,
      });
      return;
    }
    if (method === "PUT" || method === "DELETE") {
      if (path === "") { sendJson(res, 422, { message: "Validation Failed: path is required" }); return; }
      const baseTree = tip ? (store.commitInfo(tip)?.tree ?? store.put("tree", Buffer.alloc(0))) : store.put("tree", Buffer.alloc(0));
      const flat = new Map(store.flattenTree(baseTree));
      const existing = flat.get(path);
      const ident = `${repo.owner} <${repo.owner}@forge.local>`;
      if (method === "PUT") {
        const givenSha = typeof body?.sha === "string" ? body.sha : undefined;
        if (givenSha !== undefined && givenSha !== (existing?.sha ?? "")) {
          sendJson(res, 409, { message: `${path} does not match ${givenSha}` });
          return;
        }
        if (typeof body?.content !== "string") { sendJson(res, 422, { message: "Validation Failed: content is required" }); return; }
        const data = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
        const blobSha = store.put("blob", data);
        flat.set(path, { mode: "100644", sha: blobSha });
        const newTree = store.buildTree(flat);
        const message = typeof body?.message === "string" ? body.message : `${existing ? "Update" : "Create"} ${path}`;
        const commitSha = store.makeCommit(newTree, tip ? [tip] : [], message, ident);
        repo.refs.set(`refs/heads/${branchName}`, commitSha);
        repo.packCache.clear();
        repo.updatedAt = nowIso();
        sendJson(res, existing ? 200 : 201, {
          content: {
            name: path.split("/").pop(), path, sha: blobSha, size: data.length, type: "file",
            encoding: "base64",
            content: data.toString("base64"),
            url: `https://api.github.local/repos/${repo.owner}/${repo.name}/contents/${path}`,
            html_url: `https://github.local/${repo.owner}/${repo.name}/blob/${branchName}/${path}`,
            git_url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`,
            download_url: null,
          },
          commit: commitJson(repo, commitSha),
        });
        return;
      }
      // DELETE
      if (!existing || existing.mode === "40000") { notFound(); return; }
      const givenSha = typeof body?.sha === "string" ? body.sha : undefined;
      if (givenSha !== undefined && givenSha !== existing.sha) {
        sendJson(res, 409, { message: `${path} does not match ${givenSha}` });
        return;
      }
      flat.delete(path);
      const newTree = store.buildTree(flat);
      const message = typeof body?.message === "string" ? body.message : `Delete ${path}`;
      const commitSha = store.makeCommit(newTree, tip ? [tip] : [], message, ident);
      repo.refs.set(`refs/heads/${branchName}`, commitSha);
      repo.packCache.clear();
      repo.updatedAt = nowIso();
      sendJson(res, 200, { content: null, commit: commitJson(repo, commitSha) });
      return;
    }
    notFound();
    return;
  }

  if (tail === "/labels") {
    if (method === "GET") {
      sendJson(res, 200, [...repo.labels.values()].map((l) => forge.labelJson(l)));
      return;
    }
    if (method === "POST") {
      const labelName = typeof body?.name === "string" ? body.name : "";
      if (!labelName) { sendJson(res, 422, { message: "Validation Failed: name is required" }); return; }
      const label = forge.createLabel(repo, labelName, typeof body?.color === "string" ? body.color : "", typeof body?.description === "string" ? body.description : "");
      sendJson(res, 201, forge.labelJson(label));
      return;
    }
    notFound();
    return;
  }
  const labelMatch = /^\/labels\/(.+)$/.exec(tail);
  if (labelMatch && method === "GET") {
    const label = repo.labels.get(decodeURIComponent(labelMatch[1]));
    if (!label) { notFound(); return; }
    sendJson(res, 200, forge.labelJson(label));
    return;
  }

  if (tail === "/issues") {
    if (method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      const direction = url.searchParams.get("direction") ?? "desc";
      let list = [...repo.issues.values()];
      if (state === "open") list = list.filter((i) => i.state === "open");
      else if (state === "closed") list = list.filter((i) => i.state === "closed");
      list.sort((a, b) => (direction === "asc" ? a.number - b.number : b.number - a.number));
      const all = list.map((i) => forge.issueJson(repo, i));
      const { slice, headers } = paginate(req, url, all);
      sendJson(res, 200, slice, headers);
      return;
    }
    if (method === "POST") {
      const title = typeof body?.title === "string" ? body.title : "";
      if (!title) { sendJson(res, 422, { message: "Validation Failed: title is required" }); return; }
      const labelNames: string[] = [];
      if (Array.isArray(body?.labels)) {
        for (const raw of body.labels) {
          const labelName = typeof raw === "string" ? raw : (raw as { name?: string })?.name;
          if (typeof labelName === "string") labelNames.push(labelName);
        }
      }
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) {
          sendJson(res, 422, { message: `Validation Failed: label "${labelName}" does not exist` });
          return;
        }
      }
      const issue = forge.createIssue(repo, title, typeof body?.body === "string" ? body.body : "", labelNames);
      sendJson(res, 201, forge.issueJson(repo, issue));
      return;
    }
    notFound();
    return;
  }

  const issueMatch = /^\/issues\/(\d+)$/.exec(tail);
  if (issueMatch) {
    const number = parseInt(issueMatch[1], 10);
    const issue = repo.issues.get(number);
    const pull = repo.pulls.get(number);
    if (method === "GET") {
      if (issue) { sendJson(res, 200, forge.issueJson(repo, issue)); return; }
      if (pull) {
        const asIssue = forge.pullJson(repo, pull) as Record<string, unknown>;
        const view: Record<string, unknown> = {
          id: asIssue.id, node_id: asIssue.node_id, number: pull.number,
          title: pull.title, body: pull.body, user: asIssue.user, labels: [],
          state: pull.merged ? "closed" : pull.state,
          comments: (repo.comments.get(number) ?? []).length,
          created_at: pull.createdAt, updated_at: pull.updatedAt,
          closed_at: pull.closedAt,
          url: `https://api.github.local/repos/${repo.owner}/${repo.name}/issues/${number}`,
          html_url: `https://github.local/${repo.owner}/${repo.name}/pull/${number}`,
          pull_request: {
            url: `https://api.github.local/repos/${repo.owner}/${repo.name}/pulls/${number}`,
            html_url: `https://github.local/${repo.owner}/${repo.name}/pull/${number}`,
            diff_url: `https://github.local/${repo.owner}/${repo.name}/pull/${number}.diff`,
            patch_url: `https://github.local/${repo.owner}/${repo.name}/pull/${number}.patch`,
            merged_at: pull.mergedAt,
          },
        };
        sendJson(res, 200, view);
        return;
      }
      notFound();
      return;
    }
    if (method === "PATCH") {
      if (issue) {
        if (typeof body?.title === "string") issue.title = body.title;
        if (typeof body?.body === "string") issue.body = body.body;
        if (body?.state === "open" || body?.state === "closed") issue.state = body.state;
        if (Array.isArray(body?.labels)) {
          const names: string[] = [];
          for (const raw of body.labels) {
            const labelName = typeof raw === "string" ? raw : (raw as { name?: string })?.name;
            if (typeof labelName === "string") {
              if (!repo.labels.has(labelName)) { sendJson(res, 422, { message: `Validation Failed: label "${labelName}" does not exist` }); return; }
              names.push(labelName);
            }
          }
          issue.labels = names;
        }
        issue.updatedAt = nowIso();
        sendJson(res, 200, forge.issueJson(repo, issue));
        return;
      }
      if (pull) {
        if (body?.state === "closed" && pull.state === "open") {
          pull.state = "closed";
          pull.closedAt = nowIso();
          pull.updatedAt = nowIso();
        }
        if (body?.state === "open" && pull.state === "closed" && !pull.merged) {
          pull.state = "open";
          pull.closedAt = null;
          pull.updatedAt = nowIso();
        }
        if (typeof body?.title === "string") pull.title = body.title;
        if (typeof body?.body === "string") pull.body = body.body;
        sendJson(res, 200, forge.pullJson(repo, pull));
        return;
      }
      notFound();
      return;
    }
    notFound();
    return;
  }

  const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(tail);
  if (commentsMatch) {
    const number = parseInt(commentsMatch[1], 10);
    if (!repo.issues.has(number) && !repo.pulls.has(number)) { notFound(); return; }
    if (method === "GET") {
      const all = (repo.comments.get(number) ?? []).map((c) => forge.commentJson(repo, number, c));
      const { slice, headers } = paginate(req, url, all);
      sendJson(res, 200, slice, headers);
      return;
    }
    if (method === "POST") {
      const text = typeof body?.body === "string" ? body.body : "";
      if (!text) { sendJson(res, 422, { message: "Validation Failed: body is required" }); return; }
      const comment = forge.addComment(repo, number, text);
      sendJson(res, 201, forge.commentJson(repo, number, comment));
      return;
    }
    notFound();
    return;
  }

  if (tail === "/pulls") {
    if (method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      let list = [...repo.pulls.values()];
      if (state === "open") list = list.filter((p) => p.state === "open" && !p.merged);
      else if (state === "closed") list = list.filter((p) => p.state === "closed" || p.merged);
      list.sort((a, b) => b.number - a.number);
      const all = list.map((p) => forge.pullJson(repo, p));
      const { slice, headers } = paginate(req, url, all);
      sendJson(res, 200, slice, headers);
      return;
    }
    if (method === "POST") {
      const title = typeof body?.title === "string" ? body.title : "";
      const headRaw = typeof body?.head === "string" ? body.head : "";
      const baseRaw = typeof body?.base === "string" ? body.base : "";
      const head = headRaw.split(":").pop() ?? "";
      const base = baseRaw.split(":").pop() ?? "";
      if (!title || !head || !base) { sendJson(res, 422, { message: "Validation Failed: title, head and base are required" }); return; }
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (!headTip || !baseTip) { sendJson(res, 422, { message: "Validation Failed: head or base branch does not exist" }); return; }
      if (headTip === baseTip) { sendJson(res, 422, { message: "Validation Failed: no commits between base and head" }); return; }
      const pull = forge.createPull(repo, title, typeof body?.body === "string" ? body.body : "", head, base);
      sendJson(res, 201, forge.pullJson(repo, pull));
      return;
    }
    notFound();
    return;
  }

  const pullMatch = /^\/pulls\/(\d+)$/.exec(tail);
  if (pullMatch && method === "GET") {
    const pull = repo.pulls.get(parseInt(pullMatch[1], 10));
    if (!pull) { notFound(); return; }
    sendJson(res, 200, forge.pullJson(repo, pull));
    return;
  }
  const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(tail);
  if (pullFilesMatch && method === "GET") {
    const pull = repo.pulls.get(parseInt(pullFilesMatch[1], 10));
    if (!pull) { notFound(); return; }
    const files = forge.pullFiles(repo, pull).map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `https://api.github.local/repos/${repo.owner}/${repo.name}/git/blobs/${f.sha}`,
      raw_url: `https://github.local/${repo.owner}/${repo.name}/raw/${f.sha}/${f.filename}`,
      contents_url: `https://api.github.local/repos/${repo.owner}/${repo.name}/contents/${f.filename}`,
      patch: f.patch,
    }));
    if (url.searchParams.has("per_page") || url.searchParams.has("page")) {
      const { slice, headers } = paginate(req, url, files);
      sendJson(res, 200, slice, headers);
    } else {
      sendJson(res, 200, files);
    }
    return;
  }
  const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(tail);
  if (pullMergeMatch && method === "PUT") {
    const pull = repo.pulls.get(parseInt(pullMergeMatch[1], 10));
    if (!pull) { notFound(); return; }
    if (pull.merged) { sendJson(res, 405, { message: "Pull Request already merged" }); return; }
    if (pull.state === "closed") { sendJson(res, 405, { message: "Pull Request is not mergeable" }); return; }
    const result = forge.mergePull(
      repo, pull,
      typeof body?.merge_method === "string" ? body.merge_method : "squash",
      typeof body?.commit_title === "string" ? body.commit_title : "",
      typeof body?.commit_message === "string" ? body.commit_message : "",
    );
    if (result === "conflict") { sendJson(res, 405, { message: "Pull Request is not mergeable" }); return; }
    if (result === "gone") { notFound(); return; }
    sendJson(res, 200, { sha: result, merged: true, message: "Pull Request successfully merged" });
    return;
  }

  notFound();
}

// ---------------------------------------------------------------------------
// GraphQL v4 — a small executor for the documents gh and github-mcp-server
// send, with introspection over a hand-kept type registry.
// ---------------------------------------------------------------------------

interface GVal { kind: string; value?: unknown; items?: GVal[]; fields?: Record<string, GVal> }
interface GField { name: string; alias?: string; args: Record<string, GVal>; selection?: GField[]; fragment?: string; inlineType?: string }
interface GOperation { opType: string; name?: string; selection: GField[] }

function lexGraphQL(src: string): { t: string; v: string }[] {
  const tokens: { t: string; v: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") { i++; continue; }
    if (ch === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src.startsWith("...", i)) { tokens.push({ t: "spread", v: "..." }); i += 3; continue; }
    if ("!$():=@[]{}|&".includes(ch)) { tokens.push({ t: "punct", v: ch }); i++; continue; }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push({ t: "string", v: src.slice(i + 3, end === -1 ? src.length : end) });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc === "b" ? "\b" : esc === "f" ? "\f" : esc === "/" ? "/" : esc === "\\" ? "\\" : esc === '"' ? '"' : esc === "u" ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : esc;
          j += esc === "u" ? 6 : 2;
        } else { out += src[j]; j++; }
      }
      tokens.push({ t: "string", v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      tokens.push({ t: "number", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
      tokens.push({ t: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

class GParser {
  private pos = 0;
  fragments = new Map<string, { typeCondition: string; selection: GField[] }>();
  private tokens: { t: string; v: string }[];
  constructor(tokens: { t: string; v: string }[]) {
    this.tokens = tokens;
  }
  private peek(): { t: string; v: string } { return this.tokens[this.pos] ?? { t: "eof", v: "" }; }
  private next(): { t: string; v: string } { return this.tokens[this.pos++] ?? { t: "eof", v: "" }; }
  private expect(v: string): void { const tok = this.next(); if (tok.v !== v) throw new Error(`GraphQL parse: expected ${v}, got ${tok.v}`); }

  parseDocument(): GOperation[] {
    const operations: GOperation[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok.t === "punct" && tok.v === "{") {
        operations.push({ opType: "query", selection: this.parseSelectionSet() });
      } else if (tok.t === "name" && (tok.v === "query" || tok.v === "mutation" || tok.v === "subscription")) {
        this.next();
        let name: string | undefined;
        if (this.peek().t === "name") name = this.next().v;
        if (this.peek().v === "(") this.skipBalanced();
        this.skipDirectives();
        operations.push({ opType: tok.v, name, selection: this.parseSelectionSet() });
      } else if (tok.t === "name" && tok.v === "fragment") {
        this.next();
        const fragName = this.next().v;
        this.next(); // "on"
        const typeCondition = this.next().v;
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        this.fragments.set(fragName, { typeCondition, selection });
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const tok = this.next();
      if (tok.v === "(" || tok.v === "[" || tok.v === "{") depth++;
      else if (tok.v === ")" || tok.v === "]" || tok.v === "}") depth--;
      if (tok.t === "eof") break;
    } while (depth > 0);
  }

  private skipDirectives(): void {
    while (this.peek().v === "@") {
      this.next();
      this.next();
      if (this.peek().v === "(") this.skipBalanced();
    }
  }

  private parseSelectionSet(): GField[] {
    this.expect("{");
    const fields: GField[] = [];
    while (this.peek().v !== "}") {
      if (this.peek().t === "eof") throw new Error("GraphQL parse: unterminated selection set");
      if (this.peek().t === "spread") {
        this.next();
        if (this.peek().t === "name" && this.peek().v === "on") {
          this.next();
          const typeCondition = this.next().v;
          this.skipDirectives();
          const selection = this.parseSelectionSet();
          fields.push({ name: "", args: {}, inlineType: typeCondition, selection });
        } else {
          const fragName = this.next().v;
          this.skipDirectives();
          fields.push({ name: "", args: {}, fragment: fragName });
        }
        continue;
      }
      let name = this.next().v;
      let alias: string | undefined;
      if (this.peek().v === ":") { this.next(); alias = name; name = this.next().v; }
      const args: Record<string, GVal> = {};
      if (this.peek().v === "(") {
        this.next();
        while (this.peek().v !== ")") {
          const argName = this.next().v;
          this.expect(":");
          args[argName] = this.parseValue();
        }
        this.next();
      }
      this.skipDirectives();
      let selection: GField[] | undefined;
      if (this.peek().v === "{") selection = this.parseSelectionSet();
      fields.push({ name, alias, args, selection });
    }
    this.next();
    return fields;
  }

  private parseValue(): GVal {
    const tok = this.next();
    if (tok.v === "$") { const varTok = this.next(); return { kind: "var", value: varTok.v }; }
    if (tok.t === "string") return { kind: "string", value: tok.v };
    if (tok.t === "number") return { kind: tok.v.includes(".") || tok.v.includes("e") || tok.v.includes("E") ? "float" : "int", value: Number(tok.v) };
    if (tok.v === "[") {
      const items: GVal[] = [];
      while (this.peek().v !== "]") items.push(this.parseValue());
      this.next();
      return { kind: "list", items };
    }
    if (tok.v === "{") {
      const fields: Record<string, GVal> = {};
      while (this.peek().v !== "}") {
        const key = this.next().v;
        this.expect(":");
        fields[key] = this.parseValue();
      }
      this.next();
      return { kind: "object", fields };
    }
    if (tok.v === "true") return { kind: "bool", value: true };
    if (tok.v === "false") return { kind: "bool", value: false };
    if (tok.v === "null") return { kind: "null" };
    return { kind: "enum", value: tok.v };
  }
}

type GObj = { __t: string; [key: string]: unknown };
interface GqlCtx {
  forge: Forge; login: string;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, { typeCondition: string; selection: GField[] }>;
}

function resolveGVal(value: GVal, ctx: GqlCtx): unknown {
  switch (value.kind) {
    case "var": return ctx.variables[value.value as string];
    case "string": case "int": case "float": case "bool": case "enum": return value.value;
    case "null": return null;
    case "list": return (value.items ?? []).map((item) => resolveGVal(item, ctx));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields ?? {})) out[k] = resolveGVal(v, ctx);
      return out;
    }
    default: return undefined;
  }
}

function cursorOf(key: string | number): string {
  return Buffer.from(`cursor:${key}`, "utf8").toString("base64");
}

function paginateGql<T>(items: T[], args: Record<string, unknown>, keyOf: (item: T) => string | number): { page: T[]; hasNext: boolean; startCursor: string | null; endCursor: string | null } {
  let start = 0;
  const after = typeof args.after === "string" ? args.after : undefined;
  if (after) {
    try {
      const decoded = Buffer.from(after, "base64").toString("utf8");
      if (decoded.startsWith("cursor:")) {
        const key = decoded.slice("cursor:".length);
        const idx = items.findIndex((item) => String(keyOf(item)) === key);
        if (idx >= 0) start = idx + 1;
      }
    } catch { /* an undecodable cursor starts from the beginning */ }
  }
  const first = typeof args.first === "number" && args.first >= 0 ? args.first : items.length;
  const page = items.slice(start, start + first);
  return {
    page,
    hasNext: start + page.length < items.length,
    startCursor: page.length > 0 ? cursorOf(keyOf(page[0])) : null,
    endCursor: page.length > 0 ? cursorOf(keyOf(page[page.length - 1])) : null,
  };
}

function connection(typeName: string, edgeType: string, wrapped: GObj[], args: Record<string, unknown>, keyOf: (item: GObj) => string | number, total: number): GObj {
  const { page, hasNext, startCursor, endCursor } = paginateGql(wrapped, args, keyOf);
  return {
    __t: typeName,
    nodes: page,
    edges: page.map((node) => ({ __t: edgeType, node, cursor: cursorOf(keyOf(node)) })),
    pageInfo: { __t: "PageInfo", hasNextPage: hasNext, hasPreviousPage: false, startCursor, endCursor },
    totalCount: total,
  };
}

function wrapUser(login: string): GObj { return { __t: "User", login }; }
function wrapRepo(repo: RepoRec): GObj { return { __t: "Repository", repo }; }
function wrapIssue(repo: RepoRec, issue: IssueRec): GObj { return { __t: "Issue", repo, issue }; }
function wrapPull(repo: RepoRec, pull: PullRec): GObj { return { __t: "PullRequest", repo, pull }; }

function repoByDbId(forge: Forge, dbId: number): RepoRec | null {
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, "base64").toString("utf8");
    const idx = text.indexOf(":");
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch { return null; }
}

function nodeByGlobalId(forge: Forge, id: string): GObj | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === "Repository") {
    const repo = repoByDbId(forge, parseInt(decoded.key, 10));
    return repo ? wrapRepo(repo) : null;
  }
  if (decoded.kind === "User") return wrapUser(decoded.key);
  if (decoded.kind === "Issue" || decoded.kind === "PullRequest") {
    const found = forge.byDbId.get(parseInt(decoded.key, 10));
    if (!found) return null;
    if (found.kind === "issue") {
      const issue = found.repo.issues.get(found.number);
      return issue ? wrapIssue(found.repo, issue) : null;
    }
    const pull = found.repo.pulls.get(found.number);
    return pull ? wrapPull(found.repo, pull) : null;
  }
  return null;
}

interface GFieldDef { type: string; resolve?: (source: GObj, args: Record<string, unknown>, ctx: GqlCtx) => unknown }
interface GTypeDef { kind: "OBJECT" | "ENUM" | "SCALAR"; fields?: Record<string, GFieldDef>; enumValues?: string[] }

const GTYPES: Record<string, GTypeDef> = {
  String: { kind: "SCALAR" }, Int: { kind: "SCALAR" }, Float: { kind: "SCALAR" },
  Boolean: { kind: "SCALAR" }, ID: { kind: "SCALAR" }, DateTime: { kind: "SCALAR" },
  URI: { kind: "SCALAR" }, GitObjectID: { kind: "SCALAR" }, HTML: { kind: "SCALAR" },
  IssueState: { kind: "ENUM", enumValues: ["OPEN", "CLOSED"] },
  PullRequestState: { kind: "ENUM", enumValues: ["OPEN", "CLOSED", "MERGED"] },
  MergeableState: { kind: "ENUM", enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
  OrderDirection: { kind: "ENUM", enumValues: ["ASC", "DESC"] },
  IssueOrderField: { kind: "ENUM", enumValues: ["CREATED_AT", "UPDATED_AT", "COMMENTS"] },
  PullRequestOrderField: { kind: "ENUM", enumValues: ["CREATED_AT", "UPDATED_AT"] },
  SearchType: { kind: "ENUM", enumValues: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"] },
  Permission: { kind: "ENUM", enumValues: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"] },
};

function typeRef(typeStr: string): GObj {
  const trimmed = typeStr.trim();
  if (trimmed.endsWith("!")) {
    return { __t: "__Type", name: null, kind: "NON_NULL", ofType: typeRef(trimmed.slice(0, -1)) };
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { __t: "__Type", name: null, kind: "LIST", ofType: typeRef(trimmed.slice(1, -1)) };
  }
  const def = GTYPES[trimmed];
  return { __t: "__Type", name: trimmed, kind: def ? def.kind : "OBJECT", ofType: null };
}

function metaTypeOf(name: string): GObj {
  const def = GTYPES[name];
  const fieldsList = def?.fields
    ? Object.entries(def.fields).map(([fieldName, fieldDef]) => ({ __t: "__Field", name: fieldName, typeStr: fieldDef.type }))
    : null;
  return {
    __t: "__Type", name, kind: def ? def.kind : "OBJECT", ofType: null,
    fieldsList, enumValuesList: def?.enumValues ?? null,
  };
}

GTYPES["__Type"] = {
  kind: "OBJECT",
  fields: {
    name: { type: "String" },
    kind: { type: "String!" },
    description: { type: "String" },
    fields: { type: "[__Field]", resolve: (src) => (src.fieldsList as unknown) ?? null },
    enumValues: {
      type: "[__EnumValue]",
      resolve: (src) => Array.isArray(src.enumValuesList) ? (src.enumValuesList as string[]).map((v) => ({ __t: "__EnumValue", name: v })) : null,
    },
    possibleTypes: { type: "[__Type]", resolve: () => null },
    inputFields: { type: "[__InputValue]", resolve: () => null },
    ofType: { type: "__Type", resolve: (src) => (src.ofType as unknown) ?? null },
    specifiedByURL: { type: "String", resolve: () => null },
  },
};
GTYPES["__Field"] = {
  kind: "OBJECT",
  fields: {
    name: { type: "String!" },
    description: { type: "String" },
    args: { type: "[__InputValue]!", resolve: () => [] },
    type: { type: "__Type!", resolve: (src) => typeRef(src.typeStr as string) },
    isDeprecated: { type: "Boolean!", resolve: () => false },
    deprecationReason: { type: "String", resolve: () => null },
  },
};
GTYPES["__EnumValue"] = {
  kind: "OBJECT",
  fields: {
    name: { type: "String!" },
    description: { type: "String" },
    isDeprecated: { type: "Boolean!", resolve: () => false },
    deprecationReason: { type: "String", resolve: () => null },
  },
};
GTYPES["__InputValue"] = {
  kind: "OBJECT",
  fields: {
    name: { type: "String!" },
    description: { type: "String" },
    type: { type: "__Type!", resolve: () => typeRef("String") },
    defaultValue: { type: "String", resolve: () => null },
  },
};
GTYPES["__Schema"] = {
  kind: "OBJECT",
  fields: {
    types: { type: "[__Type]!", resolve: () => Object.keys(GTYPES).map((name) => metaTypeOf(name)) },
    queryType: { type: "__Type!", resolve: () => metaTypeOf("Query") },
    mutationType: { type: "__Type", resolve: () => metaTypeOf("Mutation") },
    subscriptionType: { type: "__Type", resolve: () => null },
    directives: { type: "[__Directive]!", resolve: () => [] },
  },
};
GTYPES["__Directive"] = { kind: "OBJECT", fields: { name: { type: "String!" }, description: { type: "String" }, locations: { type: "[String]!", resolve: () => [] }, args: { type: "[__InputValue]!", resolve: () => [] } } };

GTYPES["PageInfo"] = {
  kind: "OBJECT",
  fields: {
    hasNextPage: { type: "Boolean!" }, hasPreviousPage: { type: "Boolean!" },
    startCursor: { type: "String" }, endCursor: { type: "String" },
  },
};
GTYPES["User"] = {
  kind: "OBJECT",
  fields: {
    id: { type: "ID!", resolve: (src) => globalId("User", src.login as string) },
    login: { type: "String!" },
    name: { type: "String", resolve: (src) => src.login },
    url: { type: "URI!", resolve: (src) => `https://github.local/${src.login as string}` },
    avatarUrl: { type: "URI!", resolve: () => "" },
    databaseId: { type: "Int", resolve: () => 1 },
  },
};
GTYPES["Ref"] = {
  kind: "OBJECT",
  fields: {
    name: { type: "String!" },
    prefix: { type: "String!", resolve: () => "refs/heads/" },
    target: { type: "Commit", resolve: (src) => (src.sha ? { __t: "Commit", repo: src.repo, sha: src.sha } : null) },
  },
};
GTYPES["Commit"] = {
  kind: "OBJECT",
  fields: {
    id: { type: "ID!", resolve: (src) => globalId("Commit", src.sha as string) },
    oid: { type: "GitObjectID!", resolve: (src) => src.sha },
    message: { type: "String", resolve: (src) => ((src.repo as RepoRec).store.commitInfo(src.sha as string)?.message ?? "") },
    messageHeadline: { type: "String", resolve: (src) => (((src.repo as RepoRec).store.commitInfo(src.sha as string)?.message ?? "").split("\n")[0]) },
    committedDate: { type: "DateTime", resolve: (src) => parseIdent((src.repo as RepoRec).store.commitInfo(src.sha as string)?.committerLine ?? "").date },
  },
};
GTYPES["Label"] = {
  kind: "OBJECT",
  fields: {
    id: { type: "ID!", resolve: (src) => globalId("Label", (src.label as LabelRec).id) },
    name: { type: "String!", resolve: (src) => (src.label as LabelRec).name },
    color: { type: "String!", resolve: (src) => (src.label as LabelRec).color },
    description: { type: "String", resolve: (src) => (src.label as LabelRec).description },
  },
};
GTYPES["IssueComment"] = {
  kind: "OBJECT",
  fields: {
    id: { type: "ID!", resolve: (src) => globalId("IssueComment", (src.comment as CommentRec).id) },
    databaseId: { type: "Int", resolve: (src) => (src.comment as CommentRec).id },
    body: { type: "String!", resolve: (src) => (src.comment as CommentRec).body },
    createdAt: { type: "DateTime!", resolve: (src) => (src.comment as CommentRec).createdAt },
    updatedAt: { type: "DateTime!", resolve: (src) => (src.comment as CommentRec).updatedAt },
    author: { type: "User", resolve: (src) => wrapUser((src.repo as RepoRec).owner) },
  },
};

function issueStateGql(issue: IssueRec): string { return issue.state === "open" ? "OPEN" : "CLOSED"; }
function pullStateGql(pull: PullRec): string { return pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED"; }

GTYPES["Issue"] = {
  kind: "OBJECT",
  fields: {
    id: { type: "ID!", resolve: (src) => globalId("Issue", (src.issue as IssueRec).dbId) },
    databaseId: { type: "Int", resolve: (src) => (src.issue as IssueRec).dbId },
    number: { type: "Int!", resolve: (src) => (src.issue as IssueRec).number },
    title: { type: "String!", resolve: (src) => (src.issue as IssueRec).title },
    body: { type: "String", resolve: (src) => (src.issue as IssueRec).body },
    state: { type: "IssueState!", resolve: (src) => issueStateGql(src.issue as IssueRec) },
    closed: { type: "Boolean!", resolve: (src) => (src.issue as IssueRec).state === "closed" },
    url: { type: "URI!", resolve: (src) => `https://github.local/${(src.repo as RepoRec).owner}/${(src.repo as RepoRec).name}/issues/${(src.issue as IssueRec).number}` },
    createdAt: { type: "DateTime!", resolve: (src) => (src.issue as IssueRec).createdAt },
    updatedAt: { type: "DateTime!", resolve: (src) => (src.issue as IssueRec).updatedAt },
    author: { type: "User", resolve: (src) => wrapUser((src.repo as RepoRec).owner) },
    repository: { type: "Repository!", resolve: (src) => wrapRepo(src.repo as RepoRec) },
    labels: {
      type: "LabelConnection",
      resolve: (src, args) => {
        const repo = src.repo as RepoRec;
        const issue = src.issue as IssueRec;
        const wrapped = issue.labels.map((name) => repo.labels.get(name)).filter((l): l is LabelRec => l !== undefined).map((label) => ({ __t: "Label", repo, label }));
        return connection("LabelConnection", "LabelEdge", wrapped, args, (item) => (item.label as LabelRec).name, wrapped.length);
      },
    },
    comments: {
      type: "IssueCommentConnection",
      resolve: (src, args) => {
        const repo = src.repo as RepoRec;
        const issue = src.issue as IssueRec;
        const wrapped = (repo.comments.get(issue.number) ?? []).map((comment) => ({ __t: "IssueComment", repo, comment }));
        return connection("IssueCommentConnection", "IssueCommentEdge", wrapped, args, (item) => (item.comment as CommentRec).id, wrapped.length);
      },
    },
  },
};

GTYPES["PullRequest"] = {
  kind: "OBJECT",
  fields: {
    id: { type: "ID!", resolve: (src) => globalId("PullRequest", (src.pull as PullRec).dbId) },
    databaseId: { type: "Int", resolve: (src) => (src.pull as PullRec).dbId },
    number: { type: "Int!", resolve: (src) => (src.pull as PullRec).number },
    title: { type: "String!", resolve: (src) => (src.pull as PullRec).title },
    body: { type: "String", resolve: (src) => (src.pull as PullRec).body },
    state: { type: "PullRequestState!", resolve: (src) => pullStateGql(src.pull as PullRec) },
    merged: { type: "Boolean!", resolve: (src) => (src.pull as PullRec).merged },
    closed: { type: "Boolean!", resolve: (src) => (src.pull as PullRec).state === "closed" },
    mergeable: {
      type: "MergeableState!",
      resolve: (src, _args, ctx) => {
        const pull = src.pull as PullRec;
        if (pull.merged) return "MERGEABLE";
        return ctx.forge.tryMerge(src.repo as RepoRec, pull) !== null ? "MERGEABLE" : "CONFLICTING";
      },
    },
    headRefName: { type: "String!", resolve: (src) => (src.pull as PullRec).headRef },
    baseRefName: { type: "String!", resolve: (src) => (src.pull as PullRec).baseRef },
    headRefOid: { type: "GitObjectID!", resolve: (src, _a, ctx) => ctx.forge.tipOf(src.repo as RepoRec, (src.pull as PullRec).headRef) ?? (src.pull as PullRec).headShaAtCreate },
    baseRefOid: { type: "GitObjectID!", resolve: (src, _a, ctx) => ctx.forge.tipOf(src.repo as RepoRec, (src.pull as PullRec).baseRef) ?? (src.pull as PullRec).baseShaAtCreate },
    url: { type: "URI!", resolve: (src) => `https://github.local/${(src.repo as RepoRec).owner}/${(src.repo as RepoRec).name}/pull/${(src.pull as PullRec).number}` },
    createdAt: { type: "DateTime!", resolve: (src) => (src.pull as PullRec).createdAt },
    updatedAt: { type: "DateTime!", resolve: (src) => (src.pull as PullRec).updatedAt },
    mergedAt: { type: "DateTime", resolve: (src) => (src.pull as PullRec).mergedAt },
    author: { type: "User", resolve: (src) => wrapUser((src.repo as RepoRec).owner) },
    repository: { type: "Repository!", resolve: (src) => wrapRepo(src.repo as RepoRec) },
    mergeCommit: {
      type: "Commit",
      resolve: (src) => {
        const pull = src.pull as PullRec;
        return pull.mergeCommitSha ? { __t: "Commit", repo: src.repo, sha: pull.mergeCommitSha } : null;
      },
    },
    files: {
      type: "PullRequestChangedFileConnection",
      resolve: (src, args, ctx) => {
        const repo = src.repo as RepoRec;
        const files = ctx.forge.pullFiles(repo, src.pull as PullRec);
        const wrapped = files.map((f) => ({
          __t: "PullRequestChangedFile",
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changeType: f.status === "added" ? "ADDED" : f.status === "removed" ? "DELETED" : "MODIFIED",
        }));
        return connection("PullRequestChangedFileConnection", "PullRequestChangedFileEdge", wrapped, args, (item) => item.path as string, wrapped.length);
      },
    },
    changedFiles: { type: "Int!", resolve: (src, _a, ctx) => ctx.forge.pullFiles(src.repo as RepoRec, src.pull as PullRec).length },
    additions: { type: "Int!", resolve: (src, _a, ctx) => ctx.forge.pullFiles(src.repo as RepoRec, src.pull as PullRec).reduce((sum, f) => sum + f.additions, 0) },
    deletions: { type: "Int!", resolve: (src, _a, ctx) => ctx.forge.pullFiles(src.repo as RepoRec, src.pull as PullRec).reduce((sum, f) => sum + f.deletions, 0) },
  },
};
GTYPES["PullRequestChangedFile"] = {
  kind: "OBJECT",
  fields: {
    path: { type: "String!" }, additions: { type: "Int!" }, deletions: { type: "Int!" }, changeType: { type: "String!" },
  },
};

function registerConnection(name: string, nodeType: string): void {
  GTYPES[name] = {
    kind: "OBJECT",
    fields: {
      nodes: { type: `[${nodeType}]`, resolve: (src) => src.nodes },
      edges: { type: "[Edge]", resolve: (src) => src.edges },
      pageInfo: { type: "PageInfo!", resolve: (src) => src.pageInfo },
      totalCount: { type: "Int!", resolve: (src) => src.totalCount },
    },
  };
}
GTYPES["Edge"] = {
  kind: "OBJECT",
  fields: {
    node: { type: "Node", resolve: (src) => src.node },
    cursor: { type: "String!", resolve: (src) => src.cursor },
  },
};
registerConnection("IssueConnection", "Issue");
registerConnection("PullRequestConnection", "PullRequest");
registerConnection("LabelConnection", "Label");
registerConnection("IssueCommentConnection", "IssueComment");
registerConnection("PullRequestChangedFileConnection", "PullRequestChangedFile");
GTYPES["SearchResultItemConnection"] = {
  kind: "OBJECT",
  fields: {
    issueCount: { type: "Int!", resolve: () => 0 },
    repositoryCount: { type: "Int!", resolve: () => 0 },
    nodes: { type: "[Node]", resolve: () => [] },
    edges: { type: "[Edge]", resolve: () => [] },
    pageInfo: { type: "PageInfo!", resolve: () => ({ __t: "PageInfo", hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) },
  },
};

GTYPES["Repository"] = {
  kind: "OBJECT",
  fields: {
    id: { type: "ID!", resolve: (src) => globalId("Repository", (src.repo as RepoRec).dbId) },
    databaseId: { type: "Int", resolve: (src) => (src.repo as RepoRec).dbId },
    name: { type: "String!", resolve: (src) => (src.repo as RepoRec).name },
    nameWithOwner: { type: "String!", resolve: (src) => `${(src.repo as RepoRec).owner}/${(src.repo as RepoRec).name}` },
    description: { type: "String", resolve: (src) => (src.repo as RepoRec).description },
    owner: { type: "User!", resolve: (src) => wrapUser((src.repo as RepoRec).owner) },
    url: { type: "URI!", resolve: (src) => `https://github.local/${(src.repo as RepoRec).owner}/${(src.repo as RepoRec).name}` },
    isPrivate: { type: "Boolean!", resolve: () => false },
    hasIssuesEnabled: { type: "Boolean!", resolve: () => true },
    hasWikiEnabled: { type: "Boolean!", resolve: () => false },
    viewerPermission: { type: "Permission!", resolve: () => "ADMIN" },
    createdAt: { type: "DateTime!", resolve: (src) => (src.repo as RepoRec).createdAt },
    updatedAt: { type: "DateTime!", resolve: (src) => (src.repo as RepoRec).updatedAt },
    defaultBranchRef: {
      type: "Ref",
      resolve: (src, _a, ctx) => {
        const repo = src.repo as RepoRec;
        const tip = ctx.forge.tipOf(repo, "main");
        return tip ? { __t: "Ref", repo, name: "main", sha: tip } : null;
      },
    },
    issue: {
      type: "Issue",
      resolve: (src, args) => {
        const repo = src.repo as RepoRec;
        const issue = repo.issues.get(Number(args.number));
        return issue ? wrapIssue(repo, issue) : null;
      },
    },
    issues: {
      type: "IssueConnection!",
      resolve: (src, args) => {
        const repo = src.repo as RepoRec;
        let list = [...repo.issues.values()];
        if (Array.isArray(args.states)) {
          const want = (args.states as unknown[]).map((s) => String(s).toLowerCase());
          list = list.filter((i) => want.includes(i.state));
        }
        const orderBy = (args.orderBy ?? {}) as { direction?: string };
        const asc = orderBy.direction === "ASC";
        list.sort((a, b) => (asc ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
        return connection("IssueConnection", "IssueEdge", list.map((i) => wrapIssue(repo, i)), args, (item) => (item.issue as IssueRec).number, list.length);
      },
    },
    pullRequest: {
      type: "PullRequest",
      resolve: (src, args) => {
        const repo = src.repo as RepoRec;
        const pull = repo.pulls.get(Number(args.number));
        return pull ? wrapPull(repo, pull) : null;
      },
    },
    pullRequests: {
      type: "PullRequestConnection!",
      resolve: (src, args) => {
        const repo = src.repo as RepoRec;
        let list = [...repo.pulls.values()];
        if (Array.isArray(args.states)) {
          const want = (args.states as unknown[]).map((s) => String(s).toUpperCase());
          list = list.filter((p) => want.includes(pullStateGql(p)));
        }
        const orderBy = (args.orderBy ?? {}) as { direction?: string };
        const asc = orderBy.direction === "ASC";
        list.sort((a, b) => (asc ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
        return connection("PullRequestConnection", "PullRequestEdge", list.map((p) => wrapPull(repo, p)), args, (item) => (item.pull as PullRec).number, list.length);
      },
    },
  },
};

GTYPES["CreateIssuePayload"] = { kind: "OBJECT", fields: { issue: { type: "Issue", resolve: (src) => src.issue }, clientMutationId: { type: "String", resolve: (src) => src.clientMutationId ?? null } } };
GTYPES["CloseIssuePayload"] = { kind: "OBJECT", fields: { issue: { type: "Issue", resolve: (src) => src.issue }, clientMutationId: { type: "String", resolve: (src) => src.clientMutationId ?? null } } };
GTYPES["AddCommentPayload"] = { kind: "OBJECT", fields: { commentEdge: { type: "IssueCommentEdge", resolve: (src) => src.commentEdge }, clientMutationId: { type: "String", resolve: (src) => src.clientMutationId ?? null } } };
GTYPES["CreatePullRequestPayload"] = { kind: "OBJECT", fields: { pullRequest: { type: "PullRequest", resolve: (src) => src.pullRequest }, clientMutationId: { type: "String", resolve: (src) => src.clientMutationId ?? null } } };
GTYPES["MergePullRequestPayload"] = { kind: "OBJECT", fields: { pullRequest: { type: "PullRequest", resolve: (src) => src.pullRequest }, clientMutationId: { type: "String", resolve: (src) => src.clientMutationId ?? null } } };
GTYPES["IssueCommentEdge"] = GTYPES["Edge"];
GTYPES["IssueEdge"] = GTYPES["Edge"];
GTYPES["PullRequestEdge"] = GTYPES["Edge"];
GTYPES["LabelEdge"] = GTYPES["Edge"];
GTYPES["PullRequestChangedFileEdge"] = GTYPES["Edge"];

GTYPES["Query"] = {
  kind: "OBJECT",
  fields: {
    viewer: { type: "User!", resolve: (_src, _a, ctx) => wrapUser(ctx.login) },
    repository: {
      type: "Repository",
      resolve: (_src, args, ctx) => {
        const repo = ctx.forge.resolveRepo(String(args.owner ?? ""), String(args.name ?? ""), ctx.login);
        return repo ? wrapRepo(repo) : null;
      },
    },
    node: { type: "Node", resolve: (_src, args, ctx) => nodeByGlobalId(ctx.forge, String(args.id ?? "")) },
    search: { type: "SearchResultItemConnection!", resolve: () => ({ __t: "SearchResultItemConnection" }) },
    __type: { type: "__Type", resolve: (_src, args) => metaTypeOf(String(args.name ?? "")) },
    __schema: { type: "__Schema", resolve: () => ({ __t: "__Schema" }) },
  },
};

GTYPES["Mutation"] = {
  kind: "OBJECT",
  fields: {
    createIssue: {
      type: "CreateIssuePayload",
      resolve: (_src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ""));
        const repo = decoded && decoded.kind === "Repository" ? repoByDbId(ctx.forge, parseInt(decoded.key, 10)) : null;
        if (!repo) throw new Error("repository not found");
        const labelNames: string[] = [];
        if (Array.isArray(input.labelIds)) {
          for (const rawId of input.labelIds) {
            const labelDecoded = decodeGlobalId(String(rawId));
            if (!labelDecoded || labelDecoded.kind !== "Label") continue;
            const labelId = parseInt(labelDecoded.key, 10);
            for (const label of repo.labels.values()) if (label.id === labelId) labelNames.push(label.name);
          }
        }
        const issue = ctx.forge.createIssue(repo, String(input.title ?? ""), typeof input.body === "string" ? input.body : "", labelNames);
        return { __t: "CreateIssuePayload", issue: wrapIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
      },
    },
    closeIssue: {
      type: "CloseIssuePayload",
      resolve: (_src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = nodeByGlobalId(ctx.forge, String(input.issueId ?? ""));
        if (!node || node.__t !== "Issue") throw new Error("issue not found");
        const issue = node.issue as IssueRec;
        issue.state = "closed";
        issue.updatedAt = nowIso();
        return { __t: "CloseIssuePayload", issue: node, clientMutationId: input.clientMutationId ?? null };
      },
    },
    addComment: {
      type: "AddCommentPayload",
      resolve: (_src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = nodeByGlobalId(ctx.forge, String(input.subjectId ?? ""));
        if (!node || (node.__t !== "Issue" && node.__t !== "PullRequest")) throw new Error("subject not found");
        const repo = node.repo as RepoRec;
        const number = node.__t === "Issue" ? (node.issue as IssueRec).number : (node.pull as PullRec).number;
        const comment = ctx.forge.addComment(repo, number, String(input.body ?? ""));
        const commentObj: GObj = { __t: "IssueComment", repo, comment };
        return {
          __t: "AddCommentPayload",
          commentEdge: { __t: "IssueCommentEdge", node: commentObj, cursor: cursorOf(comment.id) },
          clientMutationId: input.clientMutationId ?? null,
        };
      },
    },
    createPullRequest: {
      type: "CreatePullRequestPayload",
      resolve: (_src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ""));
        const repo = decoded && decoded.kind === "Repository" ? repoByDbId(ctx.forge, parseInt(decoded.key, 10)) : null;
        if (!repo) throw new Error("repository not found");
        const head = String(input.headRefName ?? "");
        const base = String(input.baseRefName ?? "");
        if (!ctx.forge.tipOf(repo, head) || !ctx.forge.tipOf(repo, base)) throw new Error("head or base branch does not exist");
        const pull = ctx.forge.createPull(repo, String(input.title ?? ""), typeof input.body === "string" ? input.body : "", head, base);
        return { __t: "CreatePullRequestPayload", pullRequest: wrapPull(repo, pull), clientMutationId: input.clientMutationId ?? null };
      },
    },
    mergePullRequest: {
      type: "MergePullRequestPayload",
      resolve: (_src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = nodeByGlobalId(ctx.forge, String(input.pullRequestId ?? ""));
        if (!node || node.__t !== "PullRequest") throw new Error("pull request not found");
        const repo = node.repo as RepoRec;
        const pull = node.pull as PullRec;
        if (pull.merged) throw new Error("Pull Request already merged");
        const result = ctx.forge.mergePull(repo, pull, "squash", typeof input.commitHeadline === "string" ? input.commitHeadline : "", typeof input.commitBody === "string" ? input.commitBody : "");
        if (result === "conflict") throw new Error("Pull Request is not mergeable");
        if (result === "gone") throw new Error("pull request branches are gone");
        return { __t: "MergePullRequestPayload", pullRequest: wrapPull(repo, pull), clientMutationId: input.clientMutationId ?? null };
      },
    },
  },
};

function unwrapType(typeStr: string): { named: string; isList: boolean } {
  let t = typeStr.trim();
  let isList = false;
  if (t.endsWith("!")) t = t.slice(0, -1);
  if (t.startsWith("[") && t.endsWith("]")) {
    isList = true;
    t = t.slice(1, -1);
    if (t.endsWith("!")) t = t.slice(0, -1);
  }
  return { named: t, isList };
}

function completeGqlValue(typeStr: string, value: unknown, selection: GField[] | undefined, ctx: GqlCtx): unknown {
  if (value === null || value === undefined) return null;
  const { named, isList } = unwrapType(typeStr);
  if (isList) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeGqlValue(named, item, selection, ctx));
  }
  const obj = value as GObj;
  // A wrapped object completes against its runtime type, whatever the
  // declared field type says — this is what makes interface-typed fields
  // (Node) and the shared edge types resolve their selections at all.
  if (obj && typeof obj === "object" && typeof obj.__t === "string" && GTYPES[obj.__t]) {
    return executeGqlFields(obj.__t, obj, selection ?? [], ctx);
  }
  const def = GTYPES[named];
  if (!def || def.kind === "SCALAR" || def.kind === "ENUM") return value;
  return executeGqlFields(named, obj, selection ?? [], ctx);
}

function executeGqlFields(typeName: string, source: GObj, fields: GField[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const expanded: GField[] = [];
  for (const field of fields) {
    if (field.fragment) {
      const frag = ctx.fragments.get(field.fragment);
      if (frag && frag.typeCondition === typeName) expanded.push(...frag.selection);
      else if (frag && !GTYPES[frag.typeCondition]) expanded.push(...frag.selection);
      continue;
    }
    if (field.inlineType) {
      if (field.inlineType === typeName || !GTYPES[field.inlineType]) expanded.push(...(field.selection ?? []));
      continue;
    }
    expanded.push(field);
  }
  for (const field of expanded) {
    const key = field.alias ?? field.name;
    if (field.name === "__typename") { out[key] = typeName; continue; }
    const def = GTYPES[typeName]?.fields?.[field.name];
    if (!def) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(field.args)) args[argName] = resolveGVal(argValue, ctx);
    let raw: unknown;
    try {
      raw = def.resolve ? def.resolve(source, args, ctx) : (source as Record<string, unknown>)[field.name];
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeGqlValue(def.type, raw, field.selection, ctx);
  }
  return out;
}

function handleGraphQL(forge: Forge, res: ServerResponse, login: string, raw: Buffer): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch { sendJson(res, 400, { errors: [{ message: "Invalid JSON in request body" }] }); return; }
  const runOne = (entry: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof entry.query === "string" ? entry.query : "";
    const variables = (entry.variables && typeof entry.variables === "object" ? entry.variables : {}) as Record<string, unknown>;
    let operations: GOperation[];
    const parser = new GParser([]);
    try {
      const realParser = new GParser(lexGraphQL(query));
      operations = realParser.parseDocument();
      parser.fragments = realParser.fragments;
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : "parse error" }] };
    }
    if (operations.length === 0) return { errors: [{ message: "No operation found" }] };
    const operationName = typeof entry.operationName === "string" ? entry.operationName : undefined;
    const operation = (operationName ? operations.find((op) => op.name === operationName) : undefined) ?? operations[0];
    const ctx: GqlCtx = { forge, login, variables, errors: [], fragments: parser.fragments };
    const rootType = operation.opType === "mutation" ? "Mutation" : "Query";
    const data = executeGqlFields(rootType, { __t: rootType }, operation.selection, ctx);
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOne((entry ?? {}) as Record<string, unknown>)));
    return;
  }
  sendJson(res, 200, runOne((parsed ?? {}) as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over streamable HTTP
// ---------------------------------------------------------------------------

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the repository to create." },
        description: { type: "string", description: "A short description of the repository." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        full_name: { type: "string", description: "The full name of the repository, owner/repo." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        title: { type: "string", description: "The title of the issue." },
        body: { type: "string", description: "The body of the issue." },
        labels: { type: "array", items: { type: "string" }, description: "Labels to attach to the issue." },
        full_name: { type: "string", description: "The full name of the repository, owner/repo." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        state: { type: "string", description: "Filter by state: open, closed or all." },
        full_name: { type: "string", description: "The full name of the repository, owner/repo." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a new pull request in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        title: { type: "string", description: "The title of the pull request." },
        head: { type: "string", description: "The name of the branch to merge from." },
        base: { type: "string", description: "The name of the branch to merge into." },
        body: { type: "string", description: "The body of the pull request." },
        full_name: { type: "string", description: "The full name of the repository, owner/repo." },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        pull_number: { type: "number", description: "The number of the pull request to merge." },
        full_name: { type: "string", description: "The full name of the repository, owner/repo." },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

function mcpToolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], isError };
}

function mcpCallTool(forge: Forge, login: string, rawName: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: { code: number; message: string } } {
  const lower = rawName.toLowerCase();
  const tool = MCP_TOOLS.map((t) => t.name as string).find((name) => lower === name || lower.endsWith(`__${name}`) || lower.endsWith(name));
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${rawName}` } };
  const fullName = typeof args.full_name === "string" ? args.full_name : "";
  const owner = (typeof args.owner === "string" ? args.owner : fullName.split("/")[0]) || login;
  const repoName = (typeof args.repo === "string" ? args.repo : fullName.split("/")[1]) || "";
  const repo = tool === "create_repo" ? null : forge.resolveRepo(owner, repoName, login);
  switch (tool) {
    case "create_repo": {
      const name = typeof args.name === "string" ? args.name : repoName;
      if (!name) return mcpToolResult("missing required argument: name", true);
      if (forge.repos.has(`${login}/${name}`)) return mcpToolResult(`repository ${login}/${name} already exists`, true);
      const created = forge.createRepo(login, name, typeof args.description === "string" ? args.description : "");
      return mcpToolResult(forge.repoJson(created));
    }
    case "get_repo": {
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      return mcpToolResult(forge.repoJson(repo));
    }
    case "create_issue": {
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      const title = typeof args.title === "string" ? args.title : "";
      if (!title) return mcpToolResult("missing required argument: title", true);
      const labelNames: string[] = [];
      if (Array.isArray(args.labels)) {
        for (const raw of args.labels) {
          const labelName = typeof raw === "string" ? raw : (raw as { name?: string })?.name;
          if (typeof labelName === "string" && repo.labels.has(labelName)) labelNames.push(labelName);
        }
      }
      const issue = forge.createIssue(repo, title, typeof args.body === "string" ? args.body : "", labelNames);
      return mcpToolResult(forge.issueJson(repo, issue));
    }
    case "list_issues": {
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      const state = typeof args.state === "string" ? args.state : "open";
      let list = [...repo.issues.values()];
      if (state === "open") list = list.filter((i) => i.state === "open");
      else if (state === "closed") list = list.filter((i) => i.state === "closed");
      list.sort((a, b) => a.number - b.number);
      return mcpToolResult(list.map((i) => forge.issueJson(repo, i)));
    }
    case "create_pull_request": {
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      const title = typeof args.title === "string" ? args.title : "";
      const head = (typeof args.head === "string" ? args.head : "").split(":").pop() ?? "";
      const base = (typeof args.base === "string" ? args.base : "").split(":").pop() ?? "";
      if (!title) return mcpToolResult("missing required argument: title", true);
      if (!head) return mcpToolResult("missing required argument: head", true);
      if (!base) return mcpToolResult("missing required argument: base", true);
      if (!forge.tipOf(repo, head) || !forge.tipOf(repo, base)) return mcpToolResult("head or base branch does not exist", true);
      const pull = forge.createPull(repo, title, typeof args.body === "string" ? args.body : "", head, base);
      return mcpToolResult(forge.pullJson(repo, pull));
    }
    case "merge_pull_request": {
      if (!repo) return mcpToolResult(`repository ${owner}/${repoName} not found`, true);
      const pullNumber = typeof args.pull_number === "number" ? args.pull_number : parseInt(String(args.pull_number ?? ""), 10);
      if (!Number.isFinite(pullNumber)) return mcpToolResult("missing required argument: pull_number", true);
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return mcpToolResult(`pull request ${pullNumber} not found`, true);
      if (pull.merged) return mcpToolResult("Pull Request already merged", true);
      const result = forge.mergePull(repo, pull, "squash", "", "");
      if (result === "conflict") return mcpToolResult("Pull Request is not mergeable", true);
      if (result === "gone") return mcpToolResult("pull request branches are gone", true);
      return mcpToolResult(forge.pullJson(repo, pull));
    }
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${rawName}` } };
  }
}

function handleMCP(forge: Forge, res: ServerResponse, login: string, raw: Buffer): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }
  const processOne = (msg: Record<string, unknown>): Record<string, unknown> | null => {
    const method = typeof msg.method === "string" ? msg.method : "";
    const id = msg.id;
    if (id === undefined || id === null) {
      if (method.startsWith("notifications/")) return null;
      if (method === "") return null;
      return null; // notifications never get a response
    }
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    switch (method) {
      case "server/discover":
        return { jsonrpc: "2.0", id, result: {
          supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
          capabilities: { tools: {} },
          serverInfo: { name: "crisp-forge", version: "1.0.0" },
        } };
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
        const supported = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
        return { jsonrpc: "2.0", id, result: {
          protocolVersion: supported.includes(requested) ? requested : "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "crisp-forge", version: "1.0.0" },
        } };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        const outcome = mcpCallTool(forge, login, name, args);
        if ("rpcError" in outcome) return { jsonrpc: "2.0", id, error: outcome.rpcError };
        return { jsonrpc: "2.0", id, result: outcome };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => processOne((entry ?? {}) as Record<string, unknown>)).filter((r) => r !== null);
    if (results.length === 0) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, results);
    return;
  }
  const result = processOne((parsed ?? {}) as Record<string, unknown>);
  if (result === null) { res.writeHead(202); res.end(); return; }
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// Server factory and request routing
// ---------------------------------------------------------------------------

export function createForgeServer(expectedToken: string): Server {
  const forge = new Forge(expectedToken);
  const server = createServer((req, res) => {
    routeRequest(forge, expectedToken, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: "Internal Server Error" });
      else { try { res.end(); } catch { /* already closed */ } }
    });
  });
  return server;
}

async function routeRequest(forge: Forge, expectedToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path === "/healthz") { sendJson(res, 200, { ok: true }); return; }
  const login = loginFor(req, expectedToken);

  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    if (!login) { sendJson(res, 401, { message: "Bad credentials" }); return; }
    let body: Record<string, unknown> | undefined;
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsedBody: unknown = JSON.parse(raw.toString("utf8"));
          body = parsedBody && typeof parsedBody === "object" ? (parsedBody as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { message: "Problems parsing JSON" });
          return;
        }
      } else {
        body = {};
      }
    }
    handleRest(forge, req, res, url, login, body);
    return;
  }

  if (path === "/api/graphql") {
    if (!login) { sendJson(res, 401, { message: "Bad credentials" }); return; }
    if (req.method !== "POST") { sendJson(res, 405, { errors: [{ message: "Method not allowed" }] }); return; }
    const raw = await readBody(req);
    handleGraphQL(forge, res, login, raw);
    return;
  }

  if (path === "/mcp") {
    if (!login) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
      return;
    }
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method Not Allowed" }); return; }
    const raw = await readBody(req);
    handleMCP(forge, res, login, raw);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    if (!login) { sendJson(res, 401, { message: "Bad credentials" }); return; }
    const repo = forge.resolveRepo(decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), login);
    if (!repo) { sendJson(res, 404, { message: "Not Found" }); return; }
    const action = gitMatch[3];
    if (action === "info/refs" && req.method === "GET") {
      const service = url.searchParams.get("service");
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        sendJson(res, 403, { message: "Forbidden" });
        return;
      }
      // Protocol v2 is requested with the Git-Protocol header (or the
      // protocol query parameter); its advertisement is a capability list,
      // not a ref listing.
      const protoHeader = req.headers["git-protocol"];
      const wantsV2 = service === "git-upload-pack"
        && ((typeof protoHeader === "string" && protoHeader.includes("version=2"))
          || (url.searchParams.get("protocol") ?? "").includes("version=2"));
      if (wantsV2) {
        const advert = Buffer.concat([
          pktLine("version 2\n"),
          pktLine("agent=crisp-forge/1.0\n"),
          pktLine("ls-refs=unborn\n"),
          pktLine("fetch=shallow wait-for-done\n"),
          pktLine("object-format=sha1\n"),
          pktFlush(),
        ]);
        sendRaw(res, 200, advert, `application/x-${service}-advertisement`);
        return;
      }
      sendRaw(res, 200, advertiseRefs(repo, service), `application/x-${service}-advertisement`);
      return;
    }
    if (action === "git-upload-pack" && req.method === "POST") {
      const raw = await readBody(req);
      const proto = req.headers["git-protocol"] ?? "";
      handleUploadPack(repo, raw, typeof proto === "string" && proto.includes("version=2"), res);
      return;
    }
    if (action === "git-receive-pack" && req.method === "POST") {
      const raw = await readBody(req);
      handleReceivePack(repo, raw, res);
      return;
    }
    sendJson(res, 404, { message: "Not Found" });
    return;
  }

  sendJson(res, 404, { message: "Not Found" });
}
