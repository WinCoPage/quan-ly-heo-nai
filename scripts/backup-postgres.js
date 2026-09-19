// Sao lưu định kỳ cơ sở dữ liệu PostgreSQL (Neon).
// Ưu tiên dùng pg_dump nếu có sẵn trên máy/host; nếu không, tự sao lưu bằng Node (JSON) để
// vẫn hoạt động trên các môi trường không cài công cụ dòng lệnh PostgreSQL (ví dụ Render cron mặc định).
// Sử dụng: node scripts/backup-postgres.js
// Tuỳ chọn: BACKUP_DIR (mặc định: <thư mục dự án>/backups), BACKUP_RETENTION (mặc định: 14 bản gần nhất)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL chưa được cấu hình.');
  process.exit(1);
}

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const RETENTION = Number(process.env.BACKUP_RETENTION) || 14;
const TABLES = ['farms', 'users', 'sows', 'sow_care_logs', 'sow_deletions', 'audit_logs'];

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function tryPgDump() {
  const file = path.join(BACKUP_DIR, `backup-${stamp}.sql`);
  let result;
  try {
    result = spawnSync('pg_dump', ['--no-owner', '--no-privileges', '--format=plain', `--file=${file}`, DATABASE_URL], { stdio: 'inherit' });
  } catch (error) {
    return null; // pg_dump không có trong PATH
  }
  if (!result || result.error || result.status !== 0) return null;
  return file;
}

async function jsonFallback() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL_DISABLE === '1' ? false : { rejectUnauthorized: false },
  });
  const dump = {};
  try {
    for (const table of TABLES) {
      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
      dump[table] = rows;
    }
  } finally {
    await pool.end();
  }
  const file = path.join(BACKUP_DIR, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  return file;
}

function cleanupOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^backup-.*\.(sql|json)$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(RETENTION)) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`Đã xoá bản sao lưu cũ: ${f}`);
  }
}

(async () => {
  let file = tryPgDump();
  if (!file) {
    console.warn('Không tìm thấy pg_dump khả dụng, chuyển sang sao lưu JSON bằng Node.');
    file = await jsonFallback();
  }
  console.log(`Đã sao lưu vào: ${file}`);
  cleanupOldBackups();
})().catch((error) => {
  console.error('Sao lưu thất bại:', error.message);
  process.exitCode = 1;
});
