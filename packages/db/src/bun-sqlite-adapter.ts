/**
 * Prisma driver adapter over Bun's built-in `bun:sqlite`.
 *
 * Ported from `@prisma/adapter-better-sqlite3` (7.8.0): Prisma's docs say
 * better-sqlite3 does not load under Bun, and `bun:sqlite` has the same
 * synchronous, one-connection shape. One `Database` handle serves the whole
 * process; transactions are serialised by a mutex, like the upstream adapter
 * (SQLite has one writer, so this costs nothing that WAL doesn't already).
 *
 * One handle means a query issued OUTSIDE an open interactive transaction runs
 * on the same connection and so joins it (the same as PGlite before). Inside a
 * `$transaction(async (tx) => …)` callback, use `tx`, never the global client.
 * A second connection would not help: bun:sqlite is synchronous, so a writer
 * waiting on busy_timeout would block the event loop the open transaction
 * needs to finish.
 *
 * Values: DateTime is stored as ISO-8601 text with an explicit `+00:00`
 * offset (text order = time order), Json as TEXT in a JSONB-declared column,
 * BigInt as INTEGER (safeIntegers on, so reads never lose precision), Bytes as
 * BLOB, Boolean as 0/1.
 */
import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import {
  ColumnTypeEnum,
  DriverAdapterError,
  type ArgType,
  type ColumnType,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlMigrationAwareDriverAdapterFactory,
  type SqlQuery,
  type SqlQueryable,
  type SqlResultSet,
  type Transaction,
  type TransactionOptions,
} from '@prisma/driver-adapter-utils';

const ADAPTER_NAME = '@swarmy/db-bun-sqlite';

/** PRAGMAs every connection gets. WAL + NORMAL is durable across process crashes;
 *  only an OS crash can lose the last few commits. */
export const DEFAULT_PRAGMAS: Record<string, string | number> = {
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  foreign_keys: 'ON',
  busy_timeout: 5000,
};

export interface BunSqliteOptions {
  /** `:memory:`, a path, or a `file:` URL. */
  url: string;
  /** Override or extend DEFAULT_PRAGMAS. */
  pragmas?: Record<string, string | number>;
}

// ── Conversion ────────────────────────────────────────────────────────────────

function mapDeclType(declType: string | null): ColumnType | null {
  if (declType === null) return null;
  switch (declType.toUpperCase()) {
    case '':
      return null;
    case 'DECIMAL':
      return ColumnTypeEnum.Numeric;
    case 'FLOAT':
      return ColumnTypeEnum.Float;
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'NUMERIC':
    case 'REAL':
      return ColumnTypeEnum.Double;
    case 'TINYINT':
    case 'SMALLINT':
    case 'MEDIUMINT':
    case 'INT':
    case 'INTEGER':
    case 'SERIAL':
    case 'INT2':
      return ColumnTypeEnum.Int32;
    case 'BIGINT':
    case 'UNSIGNED BIG INT':
    case 'INT8':
      return ColumnTypeEnum.Int64;
    case 'DATETIME':
    case 'TIMESTAMP':
      return ColumnTypeEnum.DateTime;
    case 'TIME':
      return ColumnTypeEnum.Time;
    case 'DATE':
      return ColumnTypeEnum.Date;
    case 'TEXT':
    case 'CLOB':
    case 'CHARACTER':
    case 'VARCHAR':
    case 'VARYING CHARACTER':
    case 'NCHAR':
    case 'NATIVE CHARACTER':
    case 'NVARCHAR':
      return ColumnTypeEnum.Text;
    case 'BLOB':
      return ColumnTypeEnum.Bytes;
    case 'BOOLEAN':
      return ColumnTypeEnum.Boolean;
    case 'JSONB':
      return ColumnTypeEnum.Json;
    default:
      return null;
  }
}

function inferColumnType(value: unknown): ColumnType {
  switch (typeof value) {
    case 'string':
      return ColumnTypeEnum.Text;
    case 'bigint':
      return ColumnTypeEnum.Int64;
    case 'boolean':
      return ColumnTypeEnum.Boolean;
    case 'number':
      return ColumnTypeEnum.UnknownNumber;
    default:
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) return ColumnTypeEnum.Bytes;
      throw new Error(`bun-sqlite adapter: unexpected value of type ${typeof value}`);
  }
}

/** Column types from the declared types, falling back to the first non-null
 *  value for expressions (`count(*)`, `1 AS x`) that have no declared type. */
export function getColumnTypes(declared: (string | null)[], rows: unknown[][]): ColumnType[] {
  return declared.map((d, i) => {
    const mapped = mapDeclType(d);
    if (mapped !== null) return mapped;
    for (const row of rows) {
      if (row[i] !== null && row[i] !== undefined) return inferColumnType(row[i]);
    }
    return ColumnTypeEnum.Int32;
  });
}

function mapRow(row: unknown[], types: ColumnType[]): unknown[] {
  const out = new Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    const t = types[i];
    if (typeof v === 'number' && (t === ColumnTypeEnum.Int32 || t === ColumnTypeEnum.Int64) && !Number.isInteger(v)) {
      out[i] = Math.trunc(v);
    } else if ((typeof v === 'number' || typeof v === 'bigint') && t === ColumnTypeEnum.DateTime) {
      out[i] = new Date(Number(v)).toISOString();
    } else if (typeof v === 'bigint') {
      const n = Number(v);
      out[i] = Number.isSafeInteger(n) ? n : v.toString();
    } else if (v instanceof ArrayBuffer) {
      out[i] = new Uint8Array(v);
    } else {
      out[i] = v;
    }
  }
  return out;
}

function mapArg(arg: unknown, argType: ArgType | undefined): SQLQueryBindings {
  if (arg === null || arg === undefined) return null;
  const scalar = argType?.scalarType;
  if (typeof arg === 'string') {
    if (scalar === 'int') return Number.parseInt(arg, 10);
    if (scalar === 'float' || scalar === 'decimal') return Number.parseFloat(arg);
    if (scalar === 'bigint') return BigInt(arg);
    if (scalar === 'bytes') return Buffer.from(arg, 'base64');
    if (scalar === 'datetime') arg = new Date(arg);
  }
  if (typeof arg === 'boolean') return arg ? 1 : 0;
  // ISO-8601 with an explicit offset, the upstream adapter's default format, so
  // text ordering matches time ordering across every row.
  if (arg instanceof Date) return arg.toISOString().replace('Z', '+00:00');
  return arg as SQLQueryBindings;
}

// ── Errors ────────────────────────────────────────────────────────────────────

type SqliteErr = { code?: string; message: string };

function fieldsFrom(message: string): string[] | undefined {
  return message
    .split('constraint failed: ')
    .at(1)
    ?.split(', ')
    .map((f) => f.split('.').pop()!);
}

function toDriverError(e: unknown): never {
  const err = e as SqliteErr;
  if (!err || typeof err.message !== 'string') throw e;
  const base = { originalCode: err.code ?? '', originalMessage: err.message };
  switch (err.code) {
    case 'SQLITE_BUSY':
      throw new DriverAdapterError({ ...base, kind: 'SocketTimeout' });
    case 'SQLITE_CONSTRAINT_UNIQUE':
    case 'SQLITE_CONSTRAINT_PRIMARYKEY': {
      const fields = fieldsFrom(err.message);
      throw new DriverAdapterError({
        ...base,
        kind: 'UniqueConstraintViolation',
        constraint: fields ? { fields } : undefined,
      });
    }
    case 'SQLITE_CONSTRAINT_NOTNULL': {
      const fields = fieldsFrom(err.message);
      throw new DriverAdapterError({
        ...base,
        kind: 'NullConstraintViolation',
        constraint: fields ? { fields } : undefined,
      });
    }
    case 'SQLITE_CONSTRAINT_FOREIGNKEY':
    case 'SQLITE_CONSTRAINT_TRIGGER':
      throw new DriverAdapterError({ ...base, kind: 'ForeignKeyConstraintViolation', constraint: { foreignKey: {} } });
  }
  if (err.message.startsWith('no such table')) {
    throw new DriverAdapterError({ ...base, kind: 'TableDoesNotExist', table: err.message.split(': ').at(1) });
  }
  if (err.message.startsWith('no such column')) {
    throw new DriverAdapterError({ ...base, kind: 'ColumnNotFound', column: err.message.split(': ').at(1) });
  }
  if (err.message.includes('has no column named ')) {
    throw new DriverAdapterError({
      ...base,
      kind: 'ColumnNotFound',
      column: err.message.split('has no column named ').at(1),
    });
  }
  throw e;
}

// ── Queryables ────────────────────────────────────────────────────────────────

class BunSqliteQueryable implements SqlQueryable {
  readonly provider = 'sqlite' as const;
  readonly adapterName = ADAPTER_NAME;
  constructor(protected readonly db: Database) {}

  // Statements are prepared per call and always finalized (not db.query()'s
  // cache: Prisma's SQL varies with IN-list sizes, so a cache would only grow).
  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    let stmt: Statement | undefined;
    try {
      stmt = this.db.prepare(query.sql);
      const args = query.args.map((a, i) => mapArg(a, query.argTypes[i]));
      if (stmt.columnNames.length === 0) {
        stmt.run(...args);
        return { columnNames: [], columnTypes: [], rows: [] };
      }
      const rows = stmt.values(...args) as unknown[][];
      const columnTypes = getColumnTypes(stmt.declaredTypes as (string | null)[], rows);
      return { columnNames: stmt.columnNames, columnTypes, rows: rows.map((r) => mapRow(r, columnTypes)) };
    } catch (e) {
      return toDriverError(e);
    } finally {
      stmt?.finalize();
    }
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    let stmt: Statement | undefined;
    try {
      stmt = this.db.prepare(query.sql);
      return stmt.run(...query.args.map((a, i) => mapArg(a, query.argTypes[i]))).changes;
    } catch (e) {
      return toDriverError(e);
    } finally {
      stmt?.finalize();
    }
  }
}

class BunSqliteTransaction extends BunSqliteQueryable implements Transaction {
  // startTransaction() sent BEGIN; Prisma sends COMMIT/ROLLBACK itself
  // (usePhantomQuery: false), so commit()/rollback() only release the lock.
  readonly options: TransactionOptions = { usePhantomQuery: false };
  constructor(
    db: Database,
    private readonly release: () => void,
  ) {
    super(db);
  }
  async commit(): Promise<void> {
    this.release();
  }
  async rollback(): Promise<void> {
    this.release();
  }
  async createSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `SAVEPOINT ${name}`, args: [], argTypes: [] });
  }
  async rollbackToSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `ROLLBACK TO ${name}`, args: [], argTypes: [] });
  }
  async releaseSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `RELEASE SAVEPOINT ${name}`, args: [], argTypes: [] });
  }
}

/** A tiny FIFO mutex: one interactive transaction at a time per handle. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    return prev.then(() => {
      let done = false;
      return () => {
        if (!done) {
          done = true;
          release();
        }
      };
    });
  }
}

export class BunSqliteAdapter extends BunSqliteQueryable implements SqlDriverAdapter {
  private readonly mutex = new Mutex();
  constructor(
    db: Database,
    private readonly onDispose: () => void,
  ) {
    super(db);
  }

  async executeScript(script: string): Promise<void> {
    try {
      this.db.exec(script);
    } catch (e) {
      toDriverError(e);
    }
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (isolationLevel && isolationLevel !== 'SERIALIZABLE') {
      throw new DriverAdapterError({ kind: 'InvalidIsolationLevel', level: isolationLevel });
    }
    const release = await this.mutex.acquire();
    try {
      // Prisma sends COMMIT/ROLLBACK itself (usePhantomQuery: false) but not BEGIN.
      this.db.exec('BEGIN');
    } catch (e) {
      release();
      toDriverError(e);
    }
    return new BunSqliteTransaction(this.db, release);
  }

  getConnectionInfo() {
    return { supportsRelationJoins: false };
  }

  async dispose(): Promise<void> {
    this.onDispose();
  }
}

/** Open a `bun:sqlite` handle with swarmy's PRAGMAs. */
export function openSqlite(url: string, pragmas: Record<string, string | number> = DEFAULT_PRAGMAS): Database {
  const path = url.replace(/^file:(\/\/)?/, '');
  const db = new Database(path, { create: true, safeIntegers: true, strict: false });
  for (const [k, v] of Object.entries(pragmas)) db.exec(`PRAGMA ${k} = ${v}`);
  return db;
}

/** Prisma adapter factory. `connect()` hands out the same handle each time
 *  (SQLite is one file, one writer); `dispose()` on the last user closes it. */
export class PrismaBunSqlite implements SqlMigrationAwareDriverAdapterFactory {
  readonly provider = 'sqlite' as const;
  readonly adapterName = ADAPTER_NAME;
  private db: Database | undefined;
  private refs = 0;
  constructor(private readonly options: BunSqliteOptions) {}

  async connect(): Promise<SqlDriverAdapter> {
    this.db ??= openSqlite(this.options.url, { ...DEFAULT_PRAGMAS, ...this.options.pragmas });
    this.refs++;
    const db = this.db;
    return new BunSqliteAdapter(db, () => {
      this.refs--;
      if (this.refs <= 0 && this.db === db) {
        db.close();
        this.db = undefined;
      }
    });
  }

  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    const db = openSqlite(':memory:', { foreign_keys: 'ON' });
    return new BunSqliteAdapter(db, () => db.close());
  }
}
