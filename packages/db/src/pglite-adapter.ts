/**
 * A Prisma 7 driver adapter over `@electric-sql/pglite` — embedded Postgres
 * (WASM) running in-process. This is the "lite mode" on-ramp from the data-store
 * epic: the *same* Postgres dialect, the *same* `schema.prisma`, just a different
 * driver. No separate server, no port, no `docker:up`.
 *
 * `@prisma/adapter-pglite` is not (yet) published, so this is the in-repo
 * `SqlDriverAdapter` shim the epic's design doc anticipated. It faithfully mirrors
 * `@prisma/adapter-pg`'s value/column-type mapping (OID → Prisma `ColumnType`,
 * arg coercion, custom text parsers) so query results are identical across modes.
 *
 * PGlite is single-connection / single-process. That is exactly lite mode's
 * model: the controller is the sole DB client. Transactions are serialized
 * through PGlite's internal queue; we drive BEGIN/COMMIT/ROLLBACK imperatively to
 * satisfy Prisma's start/commit/rollback `Transaction` interface (PGlite's own
 * `transaction(cb)` API is callback-shaped and doesn't fit).
 */
import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';
import {
  ColumnTypeEnum,
  DriverAdapterError,
  type ArgType,
  type ColumnType,
  type ConnectionInfo,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlMigrationAwareDriverAdapterFactory,
  type SqlQuery,
  type SqlQueryable,
  type SqlResultSet,
  type Transaction,
  type TransactionOptions,
} from '@prisma/driver-adapter-utils';
import { parse as parseArray } from 'postgres-array';

const FIRST_NORMAL_OBJECT_ID = 16384;

// ── OID constants (subset; matches pg's builtins) ───────────────────────────

const Scalar = {
  BOOL: 16,
  BYTEA: 17,
  CHAR: 18,
  NAME: 19,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  OID: 26,
  JSON: 114,
  XML: 142,
  FLOAT4: 700,
  FLOAT8: 701,
  MONEY: 790,
  INET: 869,
  CIDR: 650,
  BPCHAR: 1042,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  TIMETZ: 1266,
  BIT: 1560,
  VARBIT: 1562,
  NUMERIC: 1700,
  UUID: 2950,
  JSONB: 3802,
} as const;

const Arr = {
  BIT_ARRAY: 1561,
  BOOL_ARRAY: 1000,
  BYTEA_ARRAY: 1001,
  BPCHAR_ARRAY: 1014,
  CHAR_ARRAY: 1002,
  CIDR_ARRAY: 651,
  DATE_ARRAY: 1182,
  FLOAT4_ARRAY: 1021,
  FLOAT8_ARRAY: 1022,
  INET_ARRAY: 1041,
  INT2_ARRAY: 1005,
  INT4_ARRAY: 1007,
  INT8_ARRAY: 1016,
  JSONB_ARRAY: 3807,
  JSON_ARRAY: 199,
  MONEY_ARRAY: 791,
  NUMERIC_ARRAY: 1231,
  OID_ARRAY: 1028,
  TEXT_ARRAY: 1009,
  TIMESTAMP_ARRAY: 1115,
  TIMESTAMPTZ_ARRAY: 1185,
  TIME_ARRAY: 1183,
  UUID_ARRAY: 2951,
  VARBIT_ARRAY: 1563,
  VARCHAR_ARRAY: 1015,
  XML_ARRAY: 143,
} as const;

class UnsupportedNativeDataType extends Error {
  readonly type: string;
  constructor(code: number) {
    super(`Unsupported column type OID ${code}`);
    this.type = String(code);
  }
}

/** OID → Prisma ColumnType. Mirrors @prisma/adapter-pg's `fieldToColumnType`. */
export function fieldToColumnType(oid: number): ColumnType {
  switch (oid) {
    case Scalar.INT2:
    case Scalar.INT4:
      return ColumnTypeEnum.Int32;
    case Scalar.INT8:
      return ColumnTypeEnum.Int64;
    case Scalar.FLOAT4:
      return ColumnTypeEnum.Float;
    case Scalar.FLOAT8:
      return ColumnTypeEnum.Double;
    case Scalar.BOOL:
      return ColumnTypeEnum.Boolean;
    case Scalar.DATE:
      return ColumnTypeEnum.Date;
    case Scalar.TIME:
    case Scalar.TIMETZ:
      return ColumnTypeEnum.Time;
    case Scalar.TIMESTAMP:
    case Scalar.TIMESTAMPTZ:
      return ColumnTypeEnum.DateTime;
    case Scalar.NUMERIC:
    case Scalar.MONEY:
      return ColumnTypeEnum.Numeric;
    case Scalar.JSON:
    case Scalar.JSONB:
      return ColumnTypeEnum.Json;
    case Scalar.UUID:
      return ColumnTypeEnum.Uuid;
    case Scalar.OID:
      return ColumnTypeEnum.Int64;
    case Scalar.BPCHAR:
    case Scalar.TEXT:
    case Scalar.VARCHAR:
    case Scalar.BIT:
    case Scalar.VARBIT:
    case Scalar.INET:
    case Scalar.CIDR:
    case Scalar.XML:
    case Scalar.CHAR:
    case Scalar.NAME:
      return ColumnTypeEnum.Text;
    case Scalar.BYTEA:
      return ColumnTypeEnum.Bytes;
    case Arr.INT2_ARRAY:
    case Arr.INT4_ARRAY:
      return ColumnTypeEnum.Int32Array;
    case Arr.FLOAT4_ARRAY:
      return ColumnTypeEnum.FloatArray;
    case Arr.FLOAT8_ARRAY:
      return ColumnTypeEnum.DoubleArray;
    case Arr.NUMERIC_ARRAY:
    case Arr.MONEY_ARRAY:
      return ColumnTypeEnum.NumericArray;
    case Arr.BOOL_ARRAY:
      return ColumnTypeEnum.BooleanArray;
    case Arr.CHAR_ARRAY:
      return ColumnTypeEnum.CharacterArray;
    case Arr.BPCHAR_ARRAY:
    case Arr.TEXT_ARRAY:
    case Arr.VARCHAR_ARRAY:
    case Arr.VARBIT_ARRAY:
    case Arr.BIT_ARRAY:
    case Arr.INET_ARRAY:
    case Arr.CIDR_ARRAY:
    case Arr.XML_ARRAY:
      return ColumnTypeEnum.TextArray;
    case Arr.DATE_ARRAY:
      return ColumnTypeEnum.DateArray;
    case Arr.TIME_ARRAY:
      return ColumnTypeEnum.TimeArray;
    case Arr.TIMESTAMP_ARRAY:
    case Arr.TIMESTAMPTZ_ARRAY:
      return ColumnTypeEnum.DateTimeArray;
    case Arr.JSON_ARRAY:
    case Arr.JSONB_ARRAY:
      return ColumnTypeEnum.JsonArray;
    case Arr.BYTEA_ARRAY:
      return ColumnTypeEnum.BytesArray;
    case Arr.UUID_ARRAY:
      return ColumnTypeEnum.UuidArray;
    case Arr.INT8_ARRAY:
    case Arr.OID_ARRAY:
      return ColumnTypeEnum.Int64Array;
    default:
      if (oid >= FIRST_NORMAL_OBJECT_ID) {
        // user-defined types (enums) come back as text.
        return ColumnTypeEnum.Text;
      }
      throw new UnsupportedNativeDataType(oid);
  }
}

// ── text-format custom parsers (normalise dates/json/bytea like adapter-pg) ──

const identity = (x: string): string => x;
const normalizeTimestamp = (t: string): string => `${t.replace(' ', 'T')}+00:00`;
const normalizeTimestamptz = (t: string): string =>
  t.replace(' ', 'T').replace(/[+-]\d{2}(:\d{2})?$/, '+00:00');
const normalizeTimez = (t: string): string => t.replace(/[+-]\d{2}(:\d{2})?$/, '');
const normalizeMoney = (m: string): string => m.slice(1);
const toJson = (j: string): string => j;
function normalizeArray(el: (s: string) => unknown): (s: string) => unknown {
  return (s: string) => parseArray(s, el as never);
}

const parsePgBytes = pgliteTypes.parsers[Scalar.BYTEA] as (s: string) => Uint8Array;

const customParsers: Record<number, (value: string) => unknown> = {
  [Scalar.NUMERIC]: identity,
  [Arr.NUMERIC_ARRAY]: normalizeArray(identity),
  [Scalar.TIME]: identity,
  [Arr.TIME_ARRAY]: normalizeArray(identity),
  [Scalar.TIMETZ]: normalizeTimez,
  [Scalar.DATE]: identity,
  [Arr.DATE_ARRAY]: normalizeArray(identity),
  [Scalar.TIMESTAMP]: normalizeTimestamp,
  [Arr.TIMESTAMP_ARRAY]: normalizeArray(normalizeTimestamp),
  [Scalar.TIMESTAMPTZ]: normalizeTimestamptz,
  [Arr.TIMESTAMPTZ_ARRAY]: normalizeArray(normalizeTimestamptz),
  [Scalar.MONEY]: normalizeMoney,
  [Arr.MONEY_ARRAY]: normalizeArray(normalizeMoney),
  [Scalar.JSON]: toJson,
  [Arr.JSON_ARRAY]: normalizeArray(toJson),
  [Scalar.JSONB]: toJson,
  [Arr.JSONB_ARRAY]: normalizeArray(toJson),
  [Scalar.BYTEA]: (s: string) => parsePgBytes(s),
};

// ── arg coercion (JS value → wire value), mirrors adapter-pg's `mapArg` ──────

function pad(n: number, z = 2): string {
  return String(n).padStart(z, '0');
}
function formatDateTime(d: Date): string {
  const ms = d.getUTCMilliseconds();
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    (ms ? `.${String(ms).padStart(3, '0')}` : '')
  );
}
function formatDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function formatTime(d: Date): string {
  const ms = d.getUTCMilliseconds();
  return (
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    (ms ? `.${String(ms).padStart(3, '0')}` : '')
  );
}

function mapArg(arg: unknown, argType: ArgType): unknown {
  if (arg === null || arg === undefined) return null;
  if (Array.isArray(arg) && argType.arity === 'list') {
    return arg.map((v) => mapArg(v, argType));
  }
  if (typeof arg === 'string' && argType.scalarType === 'datetime') {
    arg = new Date(arg);
  }
  if (arg instanceof Date) {
    switch (argType.dbType) {
      case 'TIME':
      case 'TIMETZ':
        return formatTime(arg);
      case 'DATE':
        return formatDate(arg);
      default:
        return formatDateTime(arg);
    }
  }
  if (typeof arg === 'string' && argType.scalarType === 'bytes') {
    return Buffer.from(arg, 'base64');
  }
  if (ArrayBuffer.isView(arg)) {
    const view = arg as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return arg;
}

function convertError(e: unknown): DriverAdapterError {
  const err = e as { code?: string; severity?: string; message?: string; detail?: string; column?: string; hint?: string };
  if (err && typeof err.code === 'string') {
    switch (err.code) {
      case '23505': {
        const fields = err.detail?.match(/Key \(([^)]+)\)/)?.at(1)?.split(', ');
        return new DriverAdapterError({
          kind: 'UniqueConstraintViolation',
          constraint: fields ? { fields } : undefined,
        });
      }
      case '23502': {
        const fields = err.detail?.match(/Key \(([^)]+)\)/)?.at(1)?.split(', ');
        return new DriverAdapterError({
          kind: 'NullConstraintViolation',
          constraint: fields ? { fields } : undefined,
        });
      }
      case '23503':
        return new DriverAdapterError({
          kind: 'ForeignKeyConstraintViolation',
          constraint: err.column ? { fields: [err.column] } : undefined,
        });
      case '42P01':
        return new DriverAdapterError({ kind: 'TableDoesNotExist', table: err.message });
      default:
        return new DriverAdapterError({
          kind: 'postgres',
          code: err.code ?? 'N/A',
          severity: err.severity ?? 'N/A',
          message: err.message ?? String(e),
          detail: err.detail,
          column: err.column,
          hint: err.hint,
        });
    }
  }
  return new DriverAdapterError({ kind: 'GenericJs', id: 0 });
}

type Runner = Pick<PGlite, 'query' | 'exec'>;

/** Shared query/execute logic for both the top-level adapter and transactions. */
class PGliteQueryable implements SqlQueryable {
  readonly provider = 'postgres';
  readonly adapterName = '@swarmy/db/adapter-pglite';

  constructor(protected readonly runner: Runner) {}

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const { fields, rows } = await this.performIO(query);
    const columnNames = fields.map((f) => f.name);
    let columnTypes: ColumnType[];
    try {
      columnTypes = fields.map((f) => fieldToColumnType(f.dataTypeID));
    } catch (e) {
      if (e instanceof UnsupportedNativeDataType) {
        throw new DriverAdapterError({ kind: 'UnsupportedNativeDataType', type: e.type });
      }
      throw e;
    }
    return { columnNames, columnTypes, rows: rows as unknown[][] };
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    const res = await this.performIO(query);
    return res.affectedRows ?? 0;
  }

  protected async performIO(query: SqlQuery): Promise<{
    fields: { name: string; dataTypeID: number }[];
    rows: unknown[][];
    affectedRows?: number;
  }> {
    const values = query.args.map((arg, i) => mapArg(arg, query.argTypes[i]!));
    try {
      const result = await this.runner.query<unknown[]>(query.sql, values, {
        rowMode: 'array',
        parsers: customParsers,
      });
      return {
        fields: result.fields,
        rows: result.rows,
        affectedRows: result.affectedRows,
      };
    } catch (e) {
      throw convertError(e);
    }
  }
}

class PGliteTransaction extends PGliteQueryable implements Transaction {
  readonly options: TransactionOptions = { usePhantomQuery: false };

  constructor(
    runner: Runner,
    private readonly done: () => void,
  ) {
    super(runner);
  }

  async commit(): Promise<void> {
    try {
      await this.runner.exec('COMMIT');
    } finally {
      this.done();
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.runner.exec('ROLLBACK');
    } finally {
      this.done();
    }
  }

  async createSavepoint(name: string): Promise<void> {
    await this.runner.exec(`SAVEPOINT ${name}`);
  }
  async rollbackToSavepoint(name: string): Promise<void> {
    await this.runner.exec(`ROLLBACK TO SAVEPOINT ${name}`);
  }
  async releaseSavepoint(name: string): Promise<void> {
    await this.runner.exec(`RELEASE SAVEPOINT ${name}`);
  }
}

export class PrismaPGliteAdapter extends PGliteQueryable implements SqlDriverAdapter {
  /** Serialises transactions: PGlite is one connection, so only one tx at a time. */
  private txGate: Promise<void> = Promise.resolve();

  /**
   * @param ownsClient when false, `dispose()` leaves the PGlite instance open —
   *   used when many adapters share one long-lived embedded instance.
   */
  constructor(
    private readonly pg: PGlite,
    private readonly ownsClient = true,
  ) {
    super(pg);
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    // Acquire the gate so a second startTransaction waits until this tx ends.
    let release!: () => void;
    const prev = this.txGate;
    this.txGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;

    try {
      await this.pg.exec('BEGIN');
      if (isolationLevel) {
        await this.pg.exec(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      }
    } catch (e) {
      release();
      throw convertError(e);
    }
    return new PGliteTransaction(this.pg, release);
  }

  async executeScript(script: string): Promise<void> {
    try {
      await this.pg.exec(script);
    } catch (e) {
      throw convertError(e);
    }
  }

  getConnectionInfo(): ConnectionInfo {
    return { supportsRelationJoins: true, maxBindValues: 32767 };
  }

  async dispose(): Promise<void> {
    if (this.ownsClient && !this.pg.closed) await this.pg.close();
  }
}

export interface PGliteAdapterOptions {
  /** Directory to persist the embedded Postgres data dir. Omit for in-memory. */
  dataDir?: string;
  /** Pass an already-constructed PGlite instance (tests). */
  client?: PGlite;
}

/**
 * Factory Prisma calls to obtain the adapter. Implements the migration-aware
 * factory so `prisma migrate`/`db push` can target the embedded instance too.
 */
export class PrismaPGlite implements SqlMigrationAwareDriverAdapterFactory {
  readonly provider = 'postgres';
  readonly adapterName = '@swarmy/db/adapter-pglite';
  private clientPromise?: Promise<PGlite>;
  /** A caller-injected client is shared and must not be closed on dispose. */
  private readonly sharedClient: boolean;

  constructor(private readonly options: PGliteAdapterOptions = {}) {
    this.sharedClient = Boolean(options.client);
    if (options.client) this.clientPromise = Promise.resolve(options.client);
  }

  private getClient(): Promise<PGlite> {
    if (!this.clientPromise) {
      this.clientPromise = this.options.dataDir
        ? PGlite.create({ dataDir: this.options.dataDir })
        : PGlite.create();
    }
    return this.clientPromise;
  }

  async connect(): Promise<SqlDriverAdapter> {
    const pg = await this.getClient();
    await pg.waitReady;
    return new PrismaPGliteAdapter(pg, !this.sharedClient);
  }

  /** Shadow DB for migrations: an ephemeral in-memory PGlite. */
  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    const pg = await PGlite.create();
    await pg.waitReady;
    return new PrismaPGliteAdapter(pg);
  }
}
