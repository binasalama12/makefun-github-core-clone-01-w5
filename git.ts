// git.ts — git smart HTTP, implemented from the protocol up: pkt-line framing, packfiles with
// delta resolution, the v2 upload-pack commands (ls-refs, fetch with shallow support), a v0
// upload-pack fallback, and v0 receive-pack with per-ref report-status. The object store itself
// lives in core.ts, inside each repository record; this module only moves objects in and out.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  OWNER_LOGIN,
  parseCommit,
  parseTag,
  peelToCommit,
  hashObject,
  isAncestor,
  type GitObject,
  type GitObjectType,
  type RepoRec,
  type State,
} from './core.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// -------------------------------------------------------------------------------------------
// pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse a whole buffer of pkt-lines; throws on malformed framing (callers turn that into 400). */
export function parsePkts(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// -------------------------------------------------------------------------------------------
// packfiles

/** Inflate one deflate stream starting at `start`, finding its exact consumed length. */
function inflateAt(buffer: Buffer, start: number): { data: Buffer; next: number } {
  const rest = buffer.subarray(start);
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(rest.subarray(0, lo)), next: start + lo };
}

/** Apply a git delta (copy/insert program) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++] as number;
      if (op & 0x02) copyOffset |= (delta[offset++] as number) << 8;
      if (op & 0x04) copyOffset |= (delta[offset++] as number) << 16;
      if (op & 0x08) copyOffset |= (delta[offset++] as number) << 24;
      if (op & 0x10) copySize = delta[offset++] as number;
      if (op & 0x20) copySize |= (delta[offset++] as number) << 8;
      if (op & 0x40) copySize |= (delta[offset++] as number) << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile into full objects. Delta bases may live inside the pack or in `external`
 * (the receiving repository's store, for ref-deltas). Throws on any structural problem.
 */
export function readPack(pack: Buffer, external: ReadonlyMap<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (code === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let baseBack = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        baseBack = ((baseBack + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      entry = { offset: entryStart, type: 'ofs-delta', data: inflated.data, baseOffset: entryStart - baseBack };
      offset = inflated.next;
    } else if (code === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      entry = { offset: entryStart, type: 'ref-delta', data: inflated.data, baseOid };
      offset = inflated.next;
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`bad pack object type ${code}`);
      const inflated = inflateAt(pack, offset);
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      entry = { offset: entryStart, type, data: inflated.data };
      offset = inflated.next;
    }
    entries.push(entry);
    byOffset.set(entryStart, entry);
  }
  const resolved = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: PackEntry): GitObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      return { type: entry.type, data: entry.data };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base outside the pack');
      base = resolveEntry(baseEntry);
    } else {
      const inPack = entries.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === entry.baseOid);
      if (inPack !== undefined) base = resolveEntry(inPack);
      else base = external.get(entry.baseOid as string);
      if (base === undefined) throw new Error('ref-delta base not available');
    }
    const data = applyDelta(base.data, entry.data);
    resolving.delete(entry.offset);
    return { type: base.type, data };
  };
  for (const entry of entries) {
    const object = resolveEntry(entry);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

/** Write a packfile of full (undeltified) objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODES[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    if (size === 0) {
      bytes.push((code << 4) | first);
    } else {
      bytes.push((code << 4) | first | 0x80);
      while (size > 0) {
        const chunk = size & 0x7f;
        size >>= 7;
        bytes.push(size > 0 ? chunk | 0x80 : chunk);
      }
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------
// object closure computation for fetch

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** Every object reachable from `tips`; commits in `boundary` are included but not descended. */
function closure(
  repo: RepoRec,
  tips: readonly string[],
  boundary: ReadonlySet<string> = new Set(),
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  const addTree = (treeOid: string): void => {
    const inner: string[] = [treeOid];
    while (inner.length > 0) {
      const oid = inner.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') continue;
      seen.add(oid);
      for (const entry of parseTreeEntries(object.data)) {
        if (entry.mode === '40000') inner.push(entry.oid);
        else seen.add(entry.oid);
      }
    }
  };
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      seen.add(oid);
      stack.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') {
      seen.add(oid);
      continue;
    }
    seen.add(oid);
    addTree(parseCommit(object.data).tree);
    if (!boundary.has(oid)) {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }
  return seen;
}

function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.subarray(offset, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Decide what a fetch sends: the wants' closure minus what the haves prove the client holds,
 * with depth limiting the commit walk and moving the shallow boundary.
 */
export function planFetch(
  repo: RepoRec,
  request: { wants: readonly string[]; haves: readonly string[]; shallowIn: readonly string[]; depth: number | null },
): FetchPlan {
  const boundary = new Set(request.shallowIn);
  const haveSet = closure(repo, request.haves, boundary);
  const depth = request.depth;
  let wantSet: Set<string>;
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    wantSet = closure(repo, request.wants, boundary);
  } else {
    // Breadth-first by commit distance from the wants; trees/blobs of included commits follow.
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = [];
    for (const want of request.wants) {
      const commit = peelToCommit(repo.objects, want);
      if (commit !== null) queue.push({ oid: commit, dist: 0 });
    }
    const included = new Set<string>();
    while (queue.length > 0) {
      const { oid, dist } = queue.shift() as { oid: string; dist: number };
      if (distance.has(oid) && (distance.get(oid) as number) <= dist) continue;
      distance.set(oid, dist);
      if (dist >= depth) continue;
      included.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
    }
    wantSet = new Set<string>();
    for (const oid of request.wants) wantSet.add(oid); // tags and the wanted objects themselves
    for (const commit of included) {
      for (const oid of closure(repo, [commit], new Set([commit]))) wantSet.add(oid);
      // closure with the commit as its own boundary yields commit + its full tree only.
    }
    for (const commit of included) {
      const object = repo.objects.get(commit);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !included.has(parent))) shallow.push(commit);
      if (boundary.has(commit) && parents.every((parent) => included.has(parent))) unshallow.push(commit);
    }
    // Objects the client already holds at its boundary stay shallow there.
    for (const oid of boundary) {
      if (!included.has(oid) && request.haves.includes(oid)) shallow.push(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wantSet) {
    if (haveSet.has(oid) && depth === null) continue;
    if (haveSet.has(oid) && depth !== null) {
      // In a deepen fetch the boundary commits' own trees may still be needed only when the
      // client lacks them; haveSet already encodes what it holds, so skip held objects.
      continue;
    }
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: [...new Set(shallow)], unshallow: [...new Set(unshallow)] };
}

// -------------------------------------------------------------------------------------------
// advertisements

const AGENT = 'crisp-owl-forge/1.0';

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The v0 ref advertisement body for a service. */
export function advertiseV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? ZERO_OID;
  if (repo.refs.size === 0) {
    lines.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}`, 'utf8')])));
  } else {
    lines.push(pktLine(Buffer.concat([Buffer.from(`${headOid} HEAD\0${caps}`, 'utf8')])));
    for (const [name, oid] of sortedRefs(repo)) {
      lines.push(pktLine(`${oid} ${name}\n`));
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null && peeled !== oid) lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** The protocol v2 capability advertisement body for upload-pack. */
export function advertiseV2(repo: RepoRec): Buffer {
  void repo;
  const lines: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
  ];
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// -------------------------------------------------------------------------------------------
// ls-refs

export function runLsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      out.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      out.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else {
      out.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// -------------------------------------------------------------------------------------------
// fetch responses

function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 8192;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

export function fetchV2Response(repo: RepoRec, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowIn.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
  }
  const plan = planFetch(repo, { wants, haves, shallowIn, depth });
  const out: Buffer[] = [];
  out.push(pktLine('acknowledgments\n'));
  const common = haves.find((have) => repo.objects.has(have));
  if (common !== undefined) {
    out.push(pktLine(`ACK ${common}\n`));
    out.push(pktLine('ready\n'));
  } else {
    out.push(pktLine('NAK\n'));
  }
  out.push(PKT_DELIM);
  if (depth !== null || shallowIn.length > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(PKT_DELIM);
  }
  out.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  out.push(...sidebandPack(pack));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

export function fetchV0Response(repo: RepoRec, packets: readonly Pkt[]): Buffer {
  // v0: want section, flush, have section, flush. Collect both sections' lines.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(repo, { wants, haves, shallowIn, depth });
  const out: Buffer[] = [];
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  out.push(pktLine('NAK\n'));
  const pack = writePack(plan.objects);
  out.push(...sidebandPack(pack));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// -------------------------------------------------------------------------------------------
// receive-pack

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * Apply one receive-pack request body to the store. Always answers a report-status stream in
 * sideband framing (the client negotiates side-band-64k and report-status from our advertisement).
 */
export function applyPush(
  state: State,
  repo: RepoRec,
  body: Buffer,
  setState: (next: State) => void,
): Buffer {
  // The command list is pkt-lined and ends at the first flush; everything after it is the raw
  // packfile (not pkt-framed), so walk the headers from the front instead of parsing the whole
  // body as packets.
  const commands: PushCommand[] = [];
  let consumedBytes = 0;
  {
    let offset = 0;
    let first = true;
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        consumedBytes = offset;
        break;
      }
      if (length === 1 || length === 2) {
        offset += 4;
        continue;
      }
      if (length < 4 || offset + length > body.length) break;
      let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      offset += length;
      if (first) {
        const nul = line.indexOf('\0');
        if (nul !== -1) line = line.slice(0, nul);
        first = false;
      }
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      }
    }
  }
  const packBytes = body.subarray(consumedBytes);
  // Stage the new objects: the push's objects join the repo record in one snapshot swap.
  const staged = new Map<string, GitObject>(repo.objects);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const incoming = readPack(packBytes, staged);
      for (const [oid, object] of incoming) staged.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }
  const stagedRepo: RepoRec = { ...repo, objects: staged };
  const refs = new Map(repo.refs);
  const reports: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (!unpackOk) {
    for (const command of commands) reports.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) {
      const current = refs.get(command.ref) ?? ZERO_OID;
      const refuse = (reason: string): void => {
        reports.push({ ref: command.ref, ok: false, reason });
      };
      if (command.newOid === ZERO_OID) {
        // delete
        if (!refs.has(command.ref)) refuse('reference does not exist');
        else {
          refs.delete(command.ref);
          reports.push({ ref: command.ref, ok: true });
        }
        continue;
      }
      if (!staged.has(command.newOid)) {
        refuse('missing object');
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (refs.has(command.ref)) refuse('non-fast-forward');
        else {
          refs.set(command.ref, command.newOid);
          reports.push({ ref: command.ref, ok: true });
        }
        continue;
      }
      if (command.oldOid !== current) {
        refuse('non-fast-forward');
        continue;
      }
      if (command.ref.startsWith('refs/heads/')) {
        const oldCommit = peelToCommit(staged, command.oldOid);
        const newCommit = peelToCommit(staged, command.newOid);
        if (oldCommit === null || newCommit === null || !isAncestor(stagedRepo, oldCommit, newCommit)) {
          refuse('non-fast-forward');
          continue;
        }
      }
      refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true });
    }
  }
  // Commit the staged objects (and any accepted refs) as one snapshot, even when every ref was
  // refused: a refused push still unpacks, and git keeps the objects.
  const finalRepo: RepoRec = { ...repo, objects: staged, refs };
  const repos = new Map(state.repos);
  repos.set(`${finalRepo.owner}/${finalRepo.name}`, finalRepo);
  setState({ ...state, repos, seq: state.seq + 1 });

  const reportLines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const report of reports) {
    reportLines.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason ?? 'error'}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const reportStream = Buffer.concat(reportLines);
  const out: Buffer[] = [];
  const CHUNK = 8192;
  for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, offset + CHUNK)])));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

/** Validate the owner segment of a git path the same way REST validates it. */
export function gitRepoVisible(repo: RepoRec | null): repo is RepoRec {
  return repo !== null && repo.owner === OWNER_LOGIN;
}
