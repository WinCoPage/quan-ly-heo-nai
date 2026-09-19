const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL chưa được cấu hình. Hãy trỏ tới cơ sở dữ liệu PostgreSQL (ví dụ Neon) trước khi khởi động.'
  );
}

function resolveSsl() {
  if (process.env.PGSSL_DISABLE === '1') return false;
  if (/sslmode=disable/i.test(connectionString)) return false;
  // Neon và hầu hết nhà cung cấp PostgreSQL quản lý dùng chứng chỉ do họ tự ký.
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  ssl: resolveSsl(),
  max: Number(process.env.PG_POOL_MAX) || 10,
});

pool.on('error', (error) => {
  // Lỗi trên kết nối rảnh trong pool, không liên quan tới một truy vấn cụ thể.
  console.error('Lỗi kết nối PostgreSQL ngoài luồng truy vấn:', error.message);
});

// Cho phép route trong cùng một request dùng chung 1 client khi nằm trong giao dịch.
const txStorage = new AsyncLocalStorage();

function currentExecutor() {
  return txStorage.getStore()?.client || pool;
}

// Chuyển placeholder kiểu SQLite/better-sqlite3 (?) sang PostgreSQL ($1, $2, ...)
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function run(sql, params = []) {
  const result = await currentExecutor().query(toPgQuery(sql), params);
  return {
    changes: result.rowCount,
    lastInsertRowid: result.rows[0]?.id,
    rows: result.rows,
  };
}

async function get(sql, params = []) {
  const result = await currentExecutor().query(toPgQuery(sql), params);
  return result.rows[0];
}

async function all(sql, params = []) {
  const result = await currentExecutor().query(toPgQuery(sql), params);
  return result.rows;
}

function prepare(sql) {
  return {
    get: (...params) => get(sql, params),
    all: (...params) => all(sql, params),
    run: (...params) => run(sql, params),
  };
}

async function query(sql, params = []) {
  return currentExecutor().query(toPgQuery(sql), params);
}

// Chạy handler bên trong 1 giao dịch PostgreSQL dùng chung 1 client từ pool.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStorage.run({ client }, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function initSchema() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db-postgres', 'schema.sql'), 'utf8');
  await pool.query(schemaSql);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM farms');
  if (rows[0].c === 0) {
    await pool.query('INSERT INTO farms (name, address) VALUES ($1, $2)', ['Trại 1', '']);
  }
}

const ready = initSchema().catch((error) => {
  console.error('Không thể khởi tạo lược đồ PostgreSQL:', error.message);
  throw error;
});

async function close() {
  await pool.end();
}

module.exports = { prepare, query, pool, withTransaction, ready, close };
