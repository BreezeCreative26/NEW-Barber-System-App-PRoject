// Postgres client exposing the small D1-shaped surface the server was written against:
//   db.prepare(sql).bind(...args).first<T>() | .all<T>() | .run()      and      db.batch([...stmts])
// so the routers port without rewriting ~370 call sites. `?` placeholders become $1..$n; `batch`
// runs inside one transaction (D1 batches are transactional too). `meta.changes` is the row count.
//
// Dialect notes handled here: none — SQL must be Postgres. See src/db/schema.sql and the ports in
// src/server/*.ts for the few places the original SQLite text was adjusted.
import postgres, { type Sql, type TransactionSql } from "postgres";

export type Row = Record<string, unknown>;
export type Meta = { changes: number; last_row_id: number; duration: number };
export type Result<T = Row> = { results: T[]; success: true; meta: Meta };

export interface Statement {
  readonly sql: string;
  readonly args: unknown[];
  bind(...args: unknown[]): Statement;
  first<T = Row>(): Promise<T | null>;
  first<T = unknown>(column: string): Promise<T | null>;
  all<T = Row>(): Promise<Result<T>>;
  run(): Promise<Result<Row>>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch<T = Row>(statements: Statement[]): Promise<Result<T>[]>;
  /** Run a function inside a transaction with the same Database interface bound to it. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  /** Escape hatch for raw tagged queries. */
  readonly sql: Sql | TransactionSql;
}

// Convert `?` placeholders to typed `$n` parameters, ignoring question marks inside string
// literals. Postgres cannot infer a parameter's type when it is only compared with another
// parameter or tested with IS NULL (SQLite never cared), so each placeholder is cast from the
// JS value it carries: strings → text, integers → bigint, floats → double precision, booleans →
// int (our schema stores 0/1), null → untyped NULL literal.
export function toPositional(sql: string, args: unknown[] = []): { text: string; values: unknown[] } {
  let out = "";
  let n = 0;
  let inStr = false;
  const values: unknown[] = [];
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inStr = !inStr;
      out += ch;
    } else if (ch === "?" && !inStr) {
      const v = args[n++];
      if (v === null || v === undefined) {
        out += "NULL";
        continue;
      }
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
      const idx = values.length;
      if (typeof v === "string") out += `$${idx}::text`;
      else if (typeof v === "number") out += Number.isInteger(v) ? `$${idx}::bigint` : `$${idx}::double precision`;
      else if (typeof v === "boolean") out += `$${idx}::int`;
      else if (typeof v === "bigint") out += `$${idx}::bigint`;
      else out += `$${idx}`;
    } else out += ch;
  }
  if (n !== args.length) throw new Error(`SQL expects ${n} parameters but ${args.length} were bound`);
  return { text: out, values };
}

// D1 returns booleans as 0/1 and SQLite has no bool type; our schema uses INTEGER 0/1 too, so
// nothing to coerce. BIGINT columns are avoided (INTEGER + timestamps as BIGINT → we use int8
// only for epoch millis and postgres.js returns those as strings unless told otherwise).
const options: postgres.Options<Record<string, never>> = {
  // Epoch-millisecond columns are int8; parse to JS numbers (safe until year 275760).
  types: { bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } } as never,
  transform: undefined,
  prepare: false, // transaction pooler (pgbouncer) does not support named prepared statements
  max: 8,
  idle_timeout: 20,
  connect_timeout: 15,
  onnotice: () => {},
};

// SQLite's changes() = rows affected by the previous statement. Batches rely on it for
// "audit only if the update happened" and "assert something changed". We track it per wrapper
// (per transaction) and substitute the literal before sending the statement to Postgres.
const CHANGES = /\bchanges\(\)/gi;
function wrap(client: Sql | TransactionSql, state = { changes: 0 }): Database {
  const run = async <T>(stmt: Statement) => {
    const started = Date.now();
    const raw = CHANGES.test(stmt.sql) ? stmt.sql.replace(CHANGES, String(state.changes)) : stmt.sql;
    CHANGES.lastIndex = 0;
    const { text, values } = toPositional(raw, stmt.args);
    const rows = (await client.unsafe(text, values as never[])) as unknown as T[] & { count?: number };
    const changes = typeof rows.count === "number" ? rows.count : rows.length;
    state.changes = changes;
    return { results: Array.from(rows) as T[], success: true as const, meta: { changes, last_row_id: 0, duration: Date.now() - started } };
  };
  const make = (sql: string, args: unknown[] = []): Statement => ({
    sql,
    args,
    bind: (...next) => make(sql, next),
    async first(column?: string) {
      const r = await run<Row>(this);
      const row = r.results[0] ?? null;
      if (!row) return null;
      return (column ? row[column] : row) as never;
    },
    all: function <T>() {
      return run<T>(this);
    },
    run: function () {
      return run<Row>(this);
    },
  });
  const db: Database = {
    sql: client,
    prepare: (sql) => make(sql),
    async batch<T>(statements: Statement[]) {
      if ("begin" in client && typeof (client as Sql).begin === "function") {
        return (client as Sql).begin(async (tx) => {
          const inner = wrap(tx, { changes: 0 });
          const out: Result<T>[] = [];
          for (const s of statements) out.push(await inner.prepare(s.sql).bind(...s.args).all<T>());
          return out;
        }) as Promise<Result<T>[]>;
      }
      // Already inside a transaction: run sequentially.
      const out: Result<T>[] = [];
      for (const s of statements) out.push(await db.prepare(s.sql).bind(...s.args).all<T>());
      return out;
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>) {
      if ("begin" in client && typeof (client as Sql).begin === "function") return (client as Sql).begin((tx) => fn(wrap(tx))) as Promise<T>;
      return fn(db);
    },
  };
  return db;
}

let singleton: Database | null = null;
export function getDb(url = process.env.DATABASE_URL): Database {
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!singleton) singleton = wrap(postgres(url, options));
  return singleton;
}
export function makeDb(url: string, extra: Partial<typeof options> = {}): Database {
  return wrap(postgres(url, { ...options, ...extra }));
}

// Postgres raises constraint violations with our SQLite-era codes in the message (RAISE EXCEPTION
// USING MESSAGE = 'slot_taken'); handleError() greps for those, so nothing else changes. Unique
// violations come back as SQLSTATE 23505 — normalise the message so the existing check matches.
export function normaliseDbError(err: unknown): Error {
  const e = err as { code?: string; message?: string; constraint_name?: string };
  if (e?.code === "23505") return new Error(`UNIQUE constraint failed: ${e.constraint_name ?? ""} ${e.message ?? ""}`);
  if (e?.code === "23514") return new Error(`CHECK constraint failed: ${e.constraint_name ?? ""} ${e.message ?? ""}`);
  return err instanceof Error ? err : new Error(String(err));
}
