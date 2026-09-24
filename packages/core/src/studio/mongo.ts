/**
 * Mongo side of the studio: the console accepts either a command document
 * (`{"find": "users", "filter": {…}}`, run with `runCommand`) or the familiar
 * shell shorthand (`db.users.find({ age: { $gt: 30 } }).sort({ age: -1 }).limit(20)`),
 * which is translated into the SAME command document before it is classified,
 * shown, audited and run. Nothing is ever evaluated as JavaScript.
 *
 * Arguments are "relaxed JSON": unquoted keys, single-quoted strings, trailing
 * commas, and the shell helpers `ObjectId("…")`, `ISODate("…")`, `new Date("…")`,
 * `NumberLong(…)`, `NumberInt(…)`, `NumberDecimal("…")` → Extended JSON.
 */

export interface MongoCommand {
  /** The runCommand document (Extended JSON values). */
  doc: Record<string, unknown>;
  /** The collection it targets, when it has one. */
  collection: string | null;
}

// ── relaxed JSON ─────────────────────────────────────────────────────────────

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
      if (this.s.startsWith('//', this.i)) {
        const nl = this.s.indexOf('\n', this.i);
        this.i = nl < 0 ? this.s.length : nl + 1;
        continue;
      }
      if (this.s.startsWith('/*', this.i)) {
        const e = this.s.indexOf('*/', this.i + 2);
        this.i = e < 0 ? this.s.length : e + 2;
        continue;
      }
      return;
    }
  }
  peek(): string {
    this.ws();
    return this.s[this.i] ?? '';
  }
  eat(c: string): void {
    if (this.peek() !== c) throw new Error(`expected "${c}" at ${this.i}${this.s[this.i] ? ` (found "${this.s[this.i]}")` : ''}`);
    this.i++;
  }
  done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }
}

function readString(r: Reader): string {
  const q = r.peek();
  r.i++;
  let out = '';
  while (r.i < r.s.length) {
    const c = r.s[r.i]!;
    if (c === q) {
      r.i++;
      return out;
    }
    if (c === '\\') {
      const e = r.s[r.i + 1] ?? '';
      r.i += 2;
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === 'b') out += '\b';
      else if (e === 'f') out += '\f';
      else if (e === 'u') {
        out += String.fromCharCode(parseInt(r.s.slice(r.i, r.i + 4), 16));
        r.i += 4;
      } else out += e;
      continue;
    }
    out += c;
    r.i++;
  }
  throw new Error('unterminated string');
}

function readIdent(r: Reader): string {
  r.ws();
  const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(r.s.slice(r.i));
  if (!m) throw new Error(`unexpected "${r.s[r.i] ?? 'end of input'}" at ${r.i}`);
  r.i += m[0].length;
  return m[0];
}

const HELPERS: Record<string, (args: unknown[]) => unknown> = {
  ObjectId: (a) => ({ $oid: String(a[0] ?? '') }),
  ISODate: (a) => ({ $date: String(a[0] ?? new Date().toISOString()) }),
  Date: (a) => ({ $date: a.length ? String(a[0]) : new Date().toISOString() }),
  NumberLong: (a) => ({ $numberLong: String(a[0] ?? '0') }),
  NumberInt: (a) => Number(a[0] ?? 0),
  NumberDecimal: (a) => ({ $numberDecimal: String(a[0] ?? '0') }),
  UUID: (a) => ({ $uuid: String(a[0] ?? '') }),
};

export function readValue(r: Reader): unknown {
  const c = r.peek();
  if (c === '{') {
    r.i++;
    const obj: Record<string, unknown> = {};
    while (r.peek() !== '}') {
      const k = r.peek() === '"' || r.peek() === "'" ? readString(r) : readIdent(r);
      r.eat(':');
      obj[k] = readValue(r);
      if (r.peek() === ',') r.i++;
      else break;
    }
    r.eat('}');
    return obj;
  }
  if (c === '[') {
    r.i++;
    const arr: unknown[] = [];
    while (r.peek() !== ']') {
      arr.push(readValue(r));
      if (r.peek() === ',') r.i++;
      else break;
    }
    r.eat(']');
    return arr;
  }
  if (c === '"' || c === "'") return readString(r);
  if (c === '/') {
    // /regex/flags → {$regex, $options}
    const m = /^\/((?:\\.|[^/\\\n])+)\/([imsx]*)/.exec(r.s.slice(r.i));
    if (!m) throw new Error(`bad regular expression at ${r.i}`);
    r.i += m[0].length;
    return m[2] ? { $regex: m[1], $options: m[2] } : { $regex: m[1] };
  }
  const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(r.s.slice(r.i));
  if (num) {
    r.i += num[0].length;
    return Number(num[0]);
  }
  let word = readIdent(r);
  if (word === 'new') word = readIdent(r);
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (word === 'null' || word === 'undefined') return null;
  const helper = HELPERS[word];
  if (helper) {
    const args = readArgs(r);
    return helper(args);
  }
  throw new Error(`unknown value "${word}"`);
}

function readArgs(r: Reader): unknown[] {
  r.eat('(');
  const args: unknown[] = [];
  while (r.peek() !== ')') {
    args.push(readValue(r));
    if (r.peek() === ',') r.i++;
    else break;
  }
  r.eat(')');
  return args;
}

/** Parse one relaxed-JSON value (throws with a position on error). */
export function parseRelaxedJson(text: string): unknown {
  const r = new Reader(text);
  const v = readValue(r);
  if (!r.done()) throw new Error(`unexpected text after the value at ${r.i}`);
  return v;
}

// ── shell shorthand → command document ───────────────────────────────────────

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

function commandFor(coll: string, method: string, args: unknown[], chain: Array<[string, unknown[]]>): Obj {
  const a0 = args[0];
  const a1 = args[1];
  switch (method) {
    case 'find':
    case 'findOne': {
      const doc: Obj = { find: coll, filter: obj(a0) };
      if (a1 !== undefined) doc.projection = obj(a1);
      if (method === 'findOne') doc.limit = 1;
      for (const [m, ca] of chain) {
        if (m === 'sort') doc.sort = obj(ca[0]);
        else if (m === 'limit') doc.limit = Number(ca[0]);
        else if (m === 'skip') doc.skip = Number(ca[0]);
        else if (m === 'projection' || m === 'project') doc.projection = obj(ca[0]);
        else if (m === 'toArray' || m === 'pretty') continue;
        else throw new Error(`.${m}() is not supported after find()`);
      }
      return doc;
    }
    case 'aggregate':
      return { aggregate: coll, pipeline: Array.isArray(a0) ? a0 : [], cursor: {} };
    case 'countDocuments':
    case 'count':
      return { count: coll, query: obj(a0) };
    case 'estimatedDocumentCount':
      return { count: coll };
    case 'distinct':
      return { distinct: coll, key: String(a0 ?? ''), query: obj(a1) };
    case 'insertOne':
      return { insert: coll, documents: [obj(a0)] };
    case 'insertMany':
      return { insert: coll, documents: Array.isArray(a0) ? a0 : [] };
    case 'updateOne':
    case 'updateMany':
    case 'replaceOne':
      return { update: coll, updates: [{ q: obj(a0), u: a1 ?? {}, multi: method === 'updateMany', ...(obj(args[2]).upsert === true ? { upsert: true } : {}) }] };
    case 'deleteOne':
    case 'deleteMany':
      return { delete: coll, deletes: [{ q: obj(a0), limit: method === 'deleteOne' ? 1 : 0 }] };
    case 'drop':
      return { drop: coll };
    case 'getIndexes':
      return { listIndexes: coll };
    case 'createIndex':
      return { createIndexes: coll, indexes: [{ key: obj(a0), name: String(obj(a1).name ?? Object.entries(obj(a0)).map(([k, v]) => `${k}_${v}`).join('_')), ...obj(a1) }] };
    case 'dropIndex':
      return { dropIndexes: coll, index: a0 ?? '' };
    case 'stats':
      return { collStats: coll };
    default:
      throw new Error(`db.${coll}.${method}() is not supported — use a command document`);
  }
}

const DB_HELPERS: Record<string, (args: unknown[]) => Obj> = {
  getCollectionNames: () => ({ listCollections: 1, nameOnly: true }),
  getCollectionInfos: () => ({ listCollections: 1 }),
  stats: () => ({ dbStats: 1 }),
  runCommand: (a) => obj(a[0]),
  adminCommand: (a) => obj(a[0]),
  dropDatabase: () => ({ dropDatabase: 1 }),
  createCollection: (a) => ({ create: String(a[0] ?? ''), ...obj(a[1]) }),
  serverStatus: () => ({ serverStatus: 1 }),
  getProfilingStatus: () => ({ profile: -1 }),
};

/** Console input → the runCommand document it means. Throws with a readable message. */
export function parseMongoInput(text: string): MongoCommand {
  const src = text.trim().replace(/;\s*$/, '');
  if (!src) throw new Error('empty command');
  if (src.startsWith('{')) {
    const doc = obj(parseRelaxedJson(src));
    const first = Object.keys(doc)[0];
    const target = first ? doc[first] : undefined;
    return { doc, collection: typeof target === 'string' ? target : null };
  }
  const r = new Reader(src);
  const root = readIdent(r);
  if (root !== 'db' && !root.startsWith('db.')) throw new Error('start with db.<collection>.<method>(…) or a {command} document');
  const path = root.split('.').slice(1);
  let coll: string | null = null;
  let method: string;
  if (path.length === 0) {
    // db.getCollection('x').find(…) / db['x']
    if (r.peek() === '[') {
      r.i++;
      coll = String(readValue(r));
      r.eat(']');
      r.eat('.');
      method = readIdent(r);
    } else throw new Error('expected db.<collection>.<method>(…)');
  } else if (path[0] === 'getCollection' && path.length === 1) {
    coll = String(readArgs(r)[0] ?? '');
    r.eat('.');
    method = readIdent(r);
  } else if (path.length === 1) {
    const helper = DB_HELPERS[path[0]!];
    if (!helper) throw new Error(`db.${path[0]}() is not supported`);
    const doc = helper(readArgs(r));
    if (!r.done()) throw new Error('unexpected text after the command');
    return { doc, collection: null };
  } else {
    coll = path.slice(0, -1).join('.');
    method = path[path.length - 1]!;
  }
  const args = readArgs(r);
  const chain: Array<[string, unknown[]]> = [];
  while (!r.done()) {
    r.eat('.');
    const m = readIdent(r);
    chain.push([m, readArgs(r)]);
  }
  return { doc: commandFor(coll, method, args, chain), collection: coll };
}

// ── builders the studio uses ─────────────────────────────────────────────────

export interface MongoBrowse {
  collection: string;
  filter?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit: number;
  skip: number;
}

export function mongoBrowseCommand(b: MongoBrowse): Record<string, unknown> {
  return {
    find: b.collection,
    filter: b.filter ?? {},
    ...(b.sort && Object.keys(b.sort).length ? { sort: b.sort } : {}),
    skip: Math.max(0, Math.floor(b.skip)),
    limit: Math.max(1, Math.floor(b.limit)) + 1,
  };
}

/** Sample documents to infer a collection's fields. */
export function mongoSampleCommand(collection: string, size = 50): Record<string, unknown> {
  return { aggregate: collection, pipeline: [{ $sample: { size } }], cursor: {} };
}

export function mongoUpdateById(collection: string, id: unknown, set: Record<string, unknown>, unset: string[] = []): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  if (Object.keys(set).length) u.$set = set;
  if (unset.length) u.$unset = Object.fromEntries(unset.map((k) => [k, '']));
  if (!Object.keys(u).length) throw new Error('nothing to update');
  return { update: collection, updates: [{ q: { _id: id }, u, multi: false }] };
}

export function mongoReplaceById(collection: string, id: unknown, doc: Record<string, unknown>): Record<string, unknown> {
  const { _id: _ignored, ...rest } = doc;
  return { update: collection, updates: [{ q: { _id: id }, u: rest, multi: false }] };
}

export function mongoInsert(collection: string, doc: Record<string, unknown>): Record<string, unknown> {
  return { insert: collection, documents: [doc] };
}

export function mongoDeleteById(collection: string, id: unknown): Record<string, unknown> {
  return { delete: collection, deletes: [{ q: { _id: id }, limit: 1 }] };
}

/** Field inference over sampled documents: name → the JSON types seen (first-seen order). */
export function inferFields(docs: unknown[]): Array<{ name: string; types: string[]; seen: number }> {
  const out = new Map<string, { types: Set<string>; seen: number }>();
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      const e = out.get(k) ?? { types: new Set<string>(), seen: 0 };
      e.types.add(ejsonType(v));
      e.seen++;
      out.set(k, e);
    }
  }
  return [...out.entries()].map(([name, e]) => ({ name, types: [...e.types], seen: e.seen }));
}

export function ejsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') {
    const keys = Object.keys(v as object);
    if (keys.length === 1) {
      const k = keys[0]!;
      if (k === '$oid') return 'objectId';
      if (k === '$date') return 'date';
      if (k === '$numberLong') return 'long';
      if (k === '$numberDecimal') return 'decimal';
      if (k === '$binary') return 'binary';
      if (k === '$regularExpression') return 'regex';
      if (k === '$uuid') return 'uuid';
    }
    return 'object';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  return typeof v;
}

/** Profiler: the slowest recent operations (needs profiling level ≥ 1). */
export function mongoProfileCommand(limit = 25): Record<string, unknown> {
  return { find: 'system.profile', filter: {}, sort: { millis: -1 }, limit, projection: { op: 1, ns: 1, command: 1, millis: 1, ts: 1, docsExamined: 1, nreturned: 1, planSummary: 1 } };
}
