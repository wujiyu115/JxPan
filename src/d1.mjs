// Cloudflare D1 API 垫片，底层用 node:sqlite。
// _worker.js 实际只用到 prepare / bind / first / all / run，
// batch / exec 一并实现，防混淆代码里有静态 grep 不到的动态调用路径。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// D1 只接受 null / number / string / boolean / ArrayBuffer；
// node:sqlite 不接受 boolean 和 undefined，需要先规整。
function normalizeParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// lastInsertRowid / changes 可能是 BigInt，JSON.stringify 会抛 TypeError
function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : (value ?? 0);
}

// JXPAN_D1_DEBUG=1 时打印每次 SQL 调用，用于排查垫片与真实 D1 的行为差异
const DEBUG = process.env.JXPAN_D1_DEBUG === '1';
function debug(op, sql, params, result) {
  if (!DEBUG) return;
  console.log(`[d1:${op}] ${sql.replace(/\s+/g, ' ').slice(0, 120)} | params=${JSON.stringify(params)} | -> ${JSON.stringify(result)?.slice(0, 300)}`);
}

function meta({ changes = 0, lastRowId = 0, rowsRead = 0, rowsWritten = 0, duration = 0 }) {
  return {
    served_by: 'jxpan-sqlite',
    duration,
    changes,
    last_row_id: lastRowId,
    rows_read: rowsRead,
    rows_written: rowsWritten,
    size_after: 0,
    changed_db: changes > 0,
  };
}

class D1PreparedStatement {
  #db;
  #sql;
  #params;

  constructor(db, sql, params = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  // D1 的 bind() 返回新语句，不修改原语句
  bind(...params) {
    return new D1PreparedStatement(this.#db, this.#sql, params.map(normalizeParam));
  }

  async first(colName) {
    const row = this.#db.statement(this.#sql).get(...this.#params) ?? null;
    const out = colName === undefined ? row : (row === null ? null : (row[colName] ?? null));
    debug('first', this.#sql, this.#params, out);
    return out;
  }

  async all() {
    const started = performance.now();
    const results = this.#db.statement(this.#sql).all(...this.#params);
    debug('all', this.#sql, this.#params, results);
    return {
      success: true,
      results,
      meta: meta({ rowsRead: results.length, duration: performance.now() - started }),
    };
  }

  async raw({ columnNames = false } = {}) {
    const { results } = await this.all();
    const rows = results.map((row) => Object.values(row));
    if (columnNames && results.length > 0) rows.unshift(Object.keys(results[0]));
    return rows;
  }

  async run() {
    const started = performance.now();
    const result = this.#db.statement(this.#sql).run(...this.#params);
    debug('run', this.#sql, this.#params, result);
    const changes = toNumber(result?.changes);
    return {
      success: true,
      results: [],
      meta: meta({
        changes,
        lastRowId: toNumber(result?.lastInsertRowid),
        rowsWritten: changes,
        duration: performance.now() - started,
      }),
    };
  }
}

class D1Database {
  #sqlite;
  #cache = new Map();

  constructor(sqlite) {
    this.#sqlite = sqlite;
  }

  // 预编译语句缓存：同一条 SQL 在解析流程里会被反复执行
  statement(sql) {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = this.#sqlite.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  prepare(sql) {
    return new D1PreparedStatement(this, sql);
  }

  async batch(statements) {
    this.#sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const stmt of statements) out.push(await stmt.all());
      this.#sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.#sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql) {
    const started = performance.now();
    const count = sql.split(';').filter((s) => s.trim().length > 0).length;
    this.#sqlite.exec(sql);
    return { count, duration: performance.now() - started };
  }

  async dump() {
    throw new Error('D1Database.dump() 在 SQLite 垫片中不支持');
  }

  close() {
    this.#cache.clear();
    this.#sqlite.close();
  }
}

export function openD1(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA foreign_keys = ON');
  return new D1Database(sqlite);
}
