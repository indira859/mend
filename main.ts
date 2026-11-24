// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface Split {
  br: string;
  lines: string[];
  ends: boolean;
}

/** Split a file's text at its own line break (CRLF when its first \n follows a \r). */
function splitFile(text: string): Split {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], ends: false };
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function joinFile(lines: string[], ends: boolean, br: string): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

const norm = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));

/** Positions where pattern lines occur in file lines at one tier (overlaps allowed). */
function occurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const np = pat.map((l) => norm(l, tier));
  for (let i = from; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (norm(lines[i + j]!, tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** First tier (0, then 1, then 2; only 0 with --strict) at which pat occurs at least once. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, pat, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One line of an old/new pair: 'ctx' (in both), 'old' (removed), 'add' (added). */
interface PairLine {
  kind: 'ctx' | 'old' | 'add';
  text: string;
}

/** Re-indent one added line at tier 2 (SPEC section 5); other tiers write it as is. */
function reindent(text: string, tier: number, firstOld: string, firstFile: string): string {
  if (tier !== 2) return text;
  if (text === '' || text.trim() === '') return text;
  const p = lead(firstOld);
  const f = lead(firstFile);
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** Build the lines that replace file lines [pos, pos + oldItems.length): context lines
 *  are the file's own matched lines, added lines are re-indented at tier 2. */
function replacement(fileLines: string[], pos: number, oldItems: PairLine[], newItems: PairLine[], tier: number): string[] {
  const out: string[] = [];
  let seenCtx = -1;
  const firstOld = oldItems.length > 0 ? oldItems[0]!.text : '';
  const firstFile = pos < fileLines.length ? fileLines[pos]! : '';
  for (const item of newItems) {
    if (item.kind === 'ctx') {
      seenCtx += 1;
      let n = -1;
      for (let j = 0; j < oldItems.length; j += 1) {
        if (oldItems[j]!.kind === 'ctx') {
          n += 1;
          if (n === seenCtx) {
            out.push(fileLines[pos + j]!);
            break;
          }
        }
      }
    } else {
      out.push(reindent(item.text, tier, firstOld, firstFile));
    }
  }
  return out;
}

const oldOf = (items: PairLine[]): string[] => items.filter((x) => x.kind !== 'add').map((x) => x.text);
const newOf = (items: PairLine[]): string[] => items.filter((x) => x.kind !== 'old').map((x) => x.text);

/** Apply one hunk/chunk (old items replaced by new items) to a file's split lines.
 *  `near` is the 0-based position the match is nearest to (unified), or null to take
 *  the first occurrence at or after `from` (V4A). Returns the new lines, or throws Fail. */
function applyPair(
  split: Split,
  oldItems: PairLine[],
  newItems: PairLine[],
  strict: boolean,
  path: string,
  opts: { near: number | null; from: number; insertAt: number | null; eof: boolean; endBreak: boolean | null },
): { lines: string[]; ends: boolean; endPos: number } {
  const { lines, ends } = split;
  const o = oldOf(oldItems);
  const n = newOf(newItems);
  if (o.length === 0) {
    const at = opts.insertAt !== null ? Math.min(opts.insertAt, lines.length) : lines.length;
    const nl = [...lines.slice(0, at), ...n, ...lines.slice(at)];
    const atEnd = at === lines.length;
    return { lines: nl, ends: atEnd && opts.endBreak !== null ? opts.endBreak : ends, endPos: at + n.length };
  }
  const found = findTier(lines, o, strict, opts.from);
  if (!found) throw new Fail('no-match', path);
  let occ = found.occ;
  if (opts.eof) occ = occ.filter((p) => p + o.length === lines.length);
  if (occ.length === 0) throw new Fail('no-match', path);
  let pos = occ[0]!;
  if (opts.near !== null) {
    for (const p of occ) {
      if (Math.abs(p - opts.near) < Math.abs(pos - opts.near)) pos = p;
    }
  }
  const repl = replacement(lines, pos, oldItems, newItems, found.tier);
  const nl = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
  const toEnd = pos + o.length === lines.length;
  return { lines: nl, ends: toEnd && opts.endBreak !== null ? opts.endBreak : ends, endPos: pos + repl.length };
}

/** One JSON edit object (SPEC section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const nl = [...f.lines];
      nl.splice(line, 0, ...add);
      tree.now.set(p, joinFile(nl, f.ends, f.br));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Unified diffs (SPEC section 6) ---- */

interface BodyLine {
  kind: 'ctx' | 'old' | 'add' | 'mark';
  text: string;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const newSection = (): Section => ({
  pairOld: null,
  pairNew: null,
  renameOld: null,
  renameNew: null,
  diffOld: null,
  diffNew: null,
  hasPair: false,
  isCreate: false,
  isDelete: false,
  hunks: [],
});

/** The path after `--- `/`+++ `: up to the first tab, trimmed, leading a/ or b/ removed. */
function unifiedPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  return parseInt(m[1]!, 10);
}

/** A hunk body starting at i (after its header): returns the body lines and the next index. */
function parseBody(lines: string[], i: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith(' ')) body.push({ kind: 'ctx', text: line.slice(1), rawEmpty: false });
    else if (line.startsWith('-')) body.push({ kind: 'old', text: line.slice(1), rawEmpty: false });
    else if (line.startsWith('+')) body.push({ kind: 'add', text: line.slice(1), rawEmpty: false });
    else if (line.startsWith('\\')) body.push({ kind: 'mark', text: line.slice(1), rawEmpty: false });
    else if (line === '') body.push({ kind: 'ctx', text: '', rawEmpty: true });
    else break;
    i += 1;
  }
  while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
  return { body, next: i };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const b = body[i]!;
    if (b.kind === 'mark') {
      const prev = body[i - 1];
      return prev !== undefined && (prev.kind === 'ctx' || prev.kind === 'add');
    }
    if (b.kind === 'ctx' || b.kind === 'add') return false;
  }
  return false;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = true;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hasPair) {
        cur = newSection();
        sections.push(cur);
        inHeader = true;
      }
      if (cur === null) {
        cur = newSection();
        sections.push(cur);
        inHeader = true;
      }
      cur.pairOld = unifiedPath(line);
      cur.pairNew = unifiedPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line, i);
      const { body, next } = parseBody(lines, i + 1);
      cur.hunks.push({ a, body });
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (!cur.hasPair) cur.pairNew = unifiedPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld !== null ? sec.pairOld : sec.renameOld !== null ? sec.renameOld : sec.diffOld;
  const newPath = sec.pairNew !== null ? sec.pairNew : sec.renameNew !== null ? sec.renameNew : sec.diffNew;
  const oldP = oldPath === '/dev/null' ? null : oldPath;
  const newP = newPath === '/dev/null' ? null : newPath;
  const isDelete = sec.isDelete || (newP === null && oldP !== null);
  const isCreate = !isDelete && (sec.isCreate || oldP === null);
  return (tree) => {
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isCreate) {
      if (newP === null) throw new Fail('missing', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const adds: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'add') adds.push(b.text);
      let noEol = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j += 1) {
          if (h.body[j]!.kind === 'add') noEol = false;
          if (h.body[j]!.kind === 'mark' && j > 0 && h.body[j - 1]!.kind === 'add') noEol = true;
        }
      }
      tree.now.set(newP, adds.length === 0 ? '' : adds.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let split = splitFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      const oldItems: PairLine[] = [];
      const newItems: PairLine[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          oldItems.push({ kind: 'ctx', text: b.text });
          newItems.push({ kind: 'ctx', text: b.text });
        } else if (b.kind === 'old') oldItems.push({ kind: 'old', text: b.text });
        else if (b.kind === 'add') newItems.push({ kind: 'add', text: b.text });
      }
      const noEol = hunkNoEol(h.body);
      const r = applyPair(split, oldItems, newItems, strict, oldP, { near: h.a - 1 + d, from: 0, insertAt: h.a + d, eof: false, endBreak: !noEol });
      split = { br: split.br, lines: r.lines, ends: r.ends };
      d += newOf(newItems).length - oldOf(oldItems).length;
    }
    const out = joinFile(split.lines, split.ends, split.br);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC section 7) ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    const j = lines.findIndex((l, k) => k >= i && l.trimEnd() === '<<<<<<< SEARCH');
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k -= 1) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${j + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = j + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${j + 1}`);
    }
    if (eq < 0) throw new Exit2(`error: parse ${j + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${j + 1}`);
    }
    if (rep < 0) throw new Exit2(`error: parse ${j + 1}`);
    const oldLines = lines.slice(j + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const split = splitFile(text);
    const found = findTier(split.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const repl = newLines.map((l) => reindent(l, found.tier, oldLines[0]!, split.lines[pos]!));
    const nl = [...split.lines.slice(0, pos), ...repl, ...split.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(nl, split.ends, split.br));
  };
}

/* ---- V4A patches (SPEC section 8) ---- */

const V4A_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
const isV4aStart = (l: string): boolean => V4A_STARTS.some((s) => l.startsWith(s));

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    if (line.startsWith('*** Add File: ')) kind = 'add';
    else if (line.startsWith('*** Delete File: ')) kind = 'delete';
    else if (line.startsWith('*** Update File: ')) kind = 'update';
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = line.slice(kind === 'add' ? 14 : 17).trim();
    let j = i + 1;
    while (j < last && !isV4aStart(lines[j]!)) j += 1;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const base = i + 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      raw.forEach((l, k) => {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${base + k + 1}`);
      });
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      raw.forEach((l, k) => {
        if (!blank(l)) throw new Exit2(`error: parse ${base + k + 1}`);
      });
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, base, headerLine, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: string[], base: number, headerLine: number, strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice(13).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (; idx < raw.length; idx += 1) {
    const ln = raw[idx]!;
    const lineNo = base + idx + 1;
    if (ln.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: ln.slice(2).trim() === '' ? null : ln.slice(2).trim(), eof: false, body: [] };
    } else if (ln === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (ln.startsWith(' ') || ln.startsWith('-') || ln.startsWith('+') || ln === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      if (ln.startsWith(' ')) cur.body.push({ kind: 'ctx', text: ln.slice(1), rawEmpty: false });
      else if (ln.startsWith('-')) cur.body.push({ kind: 'old', text: ln.slice(1), rawEmpty: false });
      else if (ln.startsWith('+')) cur.body.push({ kind: 'add', text: ln.slice(1), rawEmpty: false });
      else cur.body.push({ kind: 'ctx', text: '', rawEmpty: true });
    } else {
      throw new Exit2(`error: parse ${lineNo}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const split = splitFile(text);
    let curLines = [...split.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < curLines.length; k += 1) {
            if (norm(curLines[k]!, tier) === norm(ch.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const oldItems: PairLine[] = [];
      const newItems: PairLine[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          oldItems.push({ kind: 'ctx', text: b.text });
          newItems.push({ kind: 'ctx', text: b.text });
        } else if (b.kind === 'old') oldItems.push({ kind: 'old', text: b.text });
        else if (b.kind === 'add') newItems.push({ kind: 'add', text: b.text });
      }
      const r = applyPair(
        { br: split.br, lines: curLines, ends: split.ends },
        oldItems,
        newItems,
        strict,
        path,
        { near: null, from: cursor, insertAt: ch.eof ? curLines.length : cursor, eof: ch.eof, endBreak: null },
      );
      curLines = r.lines;
      cursor = r.endPos;
    }
    const out = joinFile(curLines, split.ends, split.br);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ---- Invocation, output and exit codes (SPEC sections 1, 2, 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const moved = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.now.get(oldP) === null && tree.now.get(newP) !== null && !moved.has(newP)) {
      moved.set(newP, oldP);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  const movedSources = new Set<string>([...moved.values()]);
  for (const p of [...tree.now.keys()].sort(cmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && moved.has(p)) rows.push({ key: p, line: `R ${moved.get(p)} -> ${p}` });
    else if (now === null && movedSources.has(p)) continue;
    else if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => cmp(a.key, b.key));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort(cmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
