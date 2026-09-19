-- Lược đồ PostgreSQL (Neon) cho ứng dụng quản lý heo nái.
-- Script này chạy lại an toàn mỗi lần khởi động (idempotent).

CREATE OR REPLACE FUNCTION now_utc_text() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS farms (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at TEXT,
  archived_by INTEGER,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  address TEXT,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','staff','viewer')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
  farm_id INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE TABLE IF NOT EXISTS sows (
  id SERIAL PRIMARY KEY,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  stt INTEGER,
  ma_so_nai TEXT NOT NULL,
  dong_nai TEXT,
  lua INTEGER,
  ngay_phoi TEXT,
  duc_phoi TEXT,
  log_ky1 TEXT,
  log_ky2 TEXT,
  log_ky3 TEXT,
  ngay_du_kien_de TEXT,
  sieu_am TEXT,
  ngay_de TEXT,
  so_con_so_sinh INTEGER,
  song INTEGER,
  chet INTEGER,
  so_con_cai_sua INTEGER,
  ngay_cai_sua TEXT,
  ngay_phoi_lai TEXT,
  ghi_chu TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- Nhật ký chăm sóc hàng ngày, ghi nhận theo thời gian thực khi nhân viên đến chăm sóc
CREATE TABLE IF NOT EXISTS sow_care_logs (
  id SERIAL PRIMARY KEY,
  sow_id INTEGER NOT NULL REFERENCES sows(id) ON DELETE CASCADE,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  status TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- Lưu vết dữ liệu heo nái bị xoá để admin tra soát (không xoá cascade theo sows)
CREATE TABLE IF NOT EXISTS sow_deletions (
  id SERIAL PRIMARY KEY,
  sow_id INTEGER,
  farm_id INTEGER,
  ma_so_nai TEXT,
  snapshot TEXT NOT NULL,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_by_name TEXT,
  deleted_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  before_snapshot TEXT,
  after_snapshot TEXT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE TABLE IF NOT EXISTS breeding_animals (
  id SERIAL PRIMARY KEY,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  ma_so_nai TEXT NOT NULL,
  dong_nai TEXT,
  weight_kg NUMERIC(6,2) NOT NULL CHECK (weight_kg >= 90 AND weight_kg <= 170),
  source TEXT,
  arrival_date TEXT NOT NULL,
  breeding_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text(),
  UNIQUE (farm_id, ma_so_nai)
);

CREATE TABLE IF NOT EXISTS vaccination_events (
  id SERIAL PRIMARY KEY,
  animal_id INTEGER NOT NULL REFERENCES breeding_animals(id) ON DELETE CASCADE,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('heifer', 'pregnant')),
  vaccine_name TEXT NOT NULL,
  day_offset INTEGER NOT NULL,
  scheduled_date TEXT NOT NULL,
  administered_at TEXT,
  administered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- An toàn cho lược đồ cũ hơn (thêm cột nếu còn thiếu khi nâng cấp).
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE farms ADD COLUMN IF NOT EXISTS archived_at TEXT;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS archived_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_farm_id ON users(farm_id);
CREATE INDEX IF NOT EXISTS idx_sows_farm_id ON sows(farm_id);
CREATE INDEX IF NOT EXISTS idx_sow_care_logs_sow_id ON sow_care_logs(sow_id);
CREATE INDEX IF NOT EXISTS idx_sow_care_logs_farm_id ON sow_care_logs(farm_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sow_deletions_deleted_at ON sow_deletions(deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_breeding_animals_farm_id ON breeding_animals(farm_id);
CREATE INDEX IF NOT EXISTS idx_vaccination_events_animal_id ON vaccination_events(animal_id);
CREATE INDEX IF NOT EXISTS idx_vaccination_events_scheduled_date ON vaccination_events(scheduled_date);
