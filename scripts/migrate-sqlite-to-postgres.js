// Di chuyển dữ liệu từ data.sqlite (node:sqlite) hiện có sang PostgreSQL (DATABASE_URL).
// KHÔNG xoá tệp SQLite gốc; script chỉ đọc dữ liệu, không ghi ngược lại SQLite.
// Sử dụng: node scripts/migrate-sqlite-to-postgres.js
// Tuỳ chọn: SQLITE_MIGRATION_PATH=/duong/dan/data.sqlite (mặc định: ../data.sqlite)
require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

// Thứ tự phải theo đúng phụ thuộc khoá ngoại: farms -> users -> sows -> sow_care_logs -> sow_deletions -> audit_logs
const TABLES = [
  { name: 'farms', columns: ['id', 'name', 'address', 'status', 'archived_at', 'archived_by', 'created_at'] },
  { name: 'users', columns: ['id', 'username', 'password_hash', 'full_name', 'address', 'phone', 'role', 'status', 'farm_id', 'token_version', 'created_at'] },
  { name: 'sows', columns: ['id', 'farm_id', 'stt', 'ma_so_nai', 'dong_nai', 'lua', 'ngay_phoi', 'duc_phoi', 'log_ky1', 'log_ky2', 'log_ky3', 'ngay_du_kien_de', 'sieu_am', 'ngay_de', 'so_con_so_sinh', 'song', 'chet', 'so_con_cai_sua', 'ngay_cai_sua', 'ngay_phoi_lai', 'ghi_chu', 'created_by', 'created_at', 'updated_at'] },
  { name: 'sow_care_logs', columns: ['id', 'sow_id', 'farm_id', 'status', 'note', 'created_by', 'created_at'] },
  { name: 'sow_deletions', columns: ['id', 'sow_id', 'farm_id', 'ma_so_nai', 'snapshot', 'deleted_by', 'deleted_by_name', 'deleted_at'] },
  { name: 'audit_logs', columns: ['id', 'entity_type', 'entity_id', 'action', 'before_snapshot', 'after_snapshot', 'actor_id', 'actor_name', 'created_at'] },
];

async function migrateTable(client, sqlite, table) {
  let rows;
  try {
    rows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
  } catch (error) {
    console.warn(`Bỏ qua bảng '${table.name}': ${error.message}`);
    return;
  }
  let migrated = 0;
  for (const row of rows) {
    const cols = table.columns.filter((c) => row[c] !== undefined);
    const values = cols.map((c) => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const result = await client.query(
      `INSERT INTO ${table.name} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
      values
    );
    if (result.rowCount) migrated++;
  }
  if (rows.length) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table.name}))`,
      [table.name]
    );
  }
  console.log(`${table.name}: đã chuyển ${migrated}/${rows.length} dòng (dòng trùng id được bỏ qua).`);
}

async function main() {
  await db.ready; // đảm bảo lược đồ PostgreSQL đã được tạo trước khi di chuyển dữ liệu

  const sqlitePath = process.env.SQLITE_MIGRATION_PATH || process.env.DATABASE_PATH || path.join(__dirname, '..', 'data.sqlite');
  console.log(`Đọc dữ liệu từ SQLite: ${sqlitePath}`);
  const sqlite = new DatabaseSync(sqlitePath);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of TABLES) {
      await migrateTable(client, sqlite, table);
    }
    await client.query('COMMIT');
    console.log('Hoàn tất di chuyển dữ liệu từ SQLite sang PostgreSQL. Tệp SQLite gốc vẫn được giữ nguyên.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    sqlite.close();
    await db.close();
  }
}

main().catch((error) => {
  console.error('Di chuyển thất bại:', error.message);
  process.exitCode = 1;
});
