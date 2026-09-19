const transactional = require('../middleware/transaction');
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { validateSow, positiveId } = require('../utils/validation');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired);

const EDITABLE_FIELDS = [
  'stt',
  'ma_so_nai',
  'dong_nai',
  'lua',
  'ngay_phoi',
  'duc_phoi',
  'log_ky1',
  'log_ky2',
  'log_ky3',
  'ngay_du_kien_de',
  'sieu_am',
  'ngay_de',
  'so_con_so_sinh',
  'song',
  'chet',
  'so_con_cai_sua',
  'ngay_cai_sua',
  'ngay_phoi_lai',
  'ghi_chu',
];

function resolveFarmId(req) {
  // Admin và người xem (viewer) được xem mọi trại qua query/body farm_id, staff chỉ giới hạn trại của mình
  if (req.user.role === 'admin' || req.user.role === 'viewer') {
    return req.query.farm_id ? positiveId(req.query.farm_id, 'Trại') : null;
  }
  return req.user.farm_id;
}

// Danh sách heo nái theo trại
router.get('/', asyncHandler(async (req, res) => {
  const farmId = resolveFarmId(req);
  if (!farmId) {
    if (req.user.role === 'admin' || req.user.role === 'viewer') {
      const sql = req.user.role === 'admin' ? 'SELECT * FROM sows ORDER BY farm_id, stt' : "SELECT s.* FROM sows s JOIN farms f ON f.id = s.farm_id WHERE f.status = 'active' ORDER BY s.farm_id, s.stt";
      return res.json(await db.prepare(sql).all());
    }
    return res.status(400).json({ error: 'Tài khoản của bạn chưa được gán trại, vui lòng liên hệ quản trị viên' });
  }
  const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(farmId);
  if (!farm) return res.status(404).json({ error: 'Không tìm thấy trại' });
  if (req.user.role !== 'admin' && farm.status === 'archived') {
    return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  }
  res.json(await db.prepare('SELECT * FROM sows WHERE farm_id = ? ORDER BY stt').all(farmId));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const sow = await db.prepare('SELECT * FROM sows WHERE id = ?').get(req.params.id);
  if (!sow) return res.status(404).json({ error: 'Không tìm thấy heo nái' });
  const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(sow.farm_id);
  if (req.user.role !== 'admin' && farm?.status === 'archived') {
    return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  }
  if (req.user.role === 'staff' && sow.farm_id !== req.user.farm_id) {
    return res.status(403).json({ error: 'Không có quyền xem dữ liệu trại khác' });
  }
  res.json(sow);
}));

// Nhật ký chăm sóc hàng ngày của một heo nái (theo thời gian thực)
router.get('/:id/logs', asyncHandler(async (req, res) => {
  const sow = await db.prepare('SELECT * FROM sows WHERE id = ?').get(req.params.id);
  if (!sow) return res.status(404).json({ error: 'Không tìm thấy heo nái' });
  const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(sow.farm_id);
  if (req.user.role !== 'admin' && farm?.status === 'archived') {
    return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  }
  if (req.user.role === 'staff' && sow.farm_id !== req.user.farm_id) {
    return res.status(403).json({ error: 'Không có quyền xem dữ liệu trại khác' });
  }
  const logs = await db
    .prepare(
      `SELECT scl.*, u.full_name AS created_by_name
       FROM sow_care_logs scl LEFT JOIN users u ON u.id = scl.created_by
       WHERE scl.sow_id = ? ORDER BY scl.created_at DESC`
    )
    .all(req.params.id);
  res.json(logs);
}));

router.post('/:id/logs', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const sow = await db.prepare('SELECT * FROM sows WHERE id = ?').get(req.params.id);
  if (!sow) return res.status(404).json({ error: 'Không tìm thấy heo nái' });
  const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(sow.farm_id);
  if (farm?.status === 'archived') return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  if (req.user.role !== 'admin' && sow.farm_id !== req.user.farm_id) {
    return res.status(403).json({ error: 'Không có quyền cập nhật dữ liệu trại khác' });
  }
  const { status, note } = req.body || {};
  if ((status !== undefined && (typeof status !== 'string' || status.length > 80)) ||
      (note !== undefined && (typeof note !== 'string' || note.length > 1000))) {
    return res.status(400).json({ error: 'Trạng thái hoặc ghi chú không hợp lệ' });
  }
  if ((!status || !status.trim()) && (!note || !note.trim())) {
    return res.status(400).json({ error: 'Vui lòng nhập trạng thái hoặc ghi chú' });
  }
  const info = await db
    .prepare(
      "INSERT INTO sow_care_logs (sow_id, farm_id, status, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, now_utc_text()) RETURNING id"
    )
    .run(sow.id, sow.farm_id, status || null, note || null, req.user.id);
  const log = await db
    .prepare(
      `SELECT scl.*, u.full_name AS created_by_name
       FROM sow_care_logs scl LEFT JOIN users u ON u.id = scl.created_by WHERE scl.id = ?`
    )
    .get(info.lastInsertRowid);
  await recordAudit(db, req.user, 'care_log', log.id, 'create', null, log);
  res.status(201).json(log);
}));

// Chỉ admin và nhân viên chăm sóc mới được nhập/sửa/xoá số liệu
router.post('/', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const farmId = req.user.role === 'admin' ? req.body.farm_id : req.user.farm_id;
  if (!Number.isInteger(Number(farmId)) || Number(farmId) <= 0) return res.status(400).json({ error: 'farm_id không hợp lệ' });
  if (typeof req.body.ma_so_nai !== 'string' || !req.body.ma_so_nai.trim() || req.body.ma_so_nai.length > 40) {
    return res.status(400).json({ error: 'Mã số nái không hợp lệ' });
  }
  if (req.body.dong_nai !== undefined && req.body.dong_nai !== null && (typeof req.body.dong_nai !== 'string' || req.body.dong_nai.length > 80)) {
    return res.status(400).json({ error: 'Dòng nái không hợp lệ' });
  }

  const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(positiveId(farmId, 'Trại'));
  if (!farm) return res.status(400).json({ error: 'Trại không tồn tại' });
  if (farm.status !== 'active') return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  const heifer = await db.prepare(
    "SELECT id, ma_so_nai FROM breeding_animals WHERE farm_id = ? AND ma_so_nai = ? AND status = 'active'"
  ).get(farmId, req.body.ma_so_nai);
  if (!heifer) {
    return res.status(400).json({ error: 'Phải tạo mã số heo hậu bị tại đúng trại trước khi tạo heo nái. Mã số hậu bị và mã số nái phải giống nhau.' });
  }
  const payload = validateSow(req.body, EDITABLE_FIELDS);
  const cols = ['farm_id', 'created_by', ...EDITABLE_FIELDS];
  const values = [farmId, req.user.id, ...EDITABLE_FIELDS.map((f) => payload[f] ?? null)];
  const placeholders = cols.map(() => '?').join(', ');
  const info = await db
    .prepare(`INSERT INTO sows (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`)
    .run(...values);
  await recordAudit(db, req.user, 'sow', info.lastInsertRowid, 'create', null, await db.prepare('SELECT * FROM sows WHERE id = ?').get(info.lastInsertRowid));
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.put('/:id', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const sow = await db.prepare('SELECT * FROM sows WHERE id = ?').get(req.params.id);
  if (!sow) return res.status(404).json({ error: 'Không tìm thấy heo nái' });
  if (req.user.role !== 'admin' && sow.farm_id !== req.user.farm_id) {
    return res.status(403).json({ error: 'Không có quyền sửa dữ liệu trại khác' });
  }
  const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(sow.farm_id);
  if (farm?.status !== 'active') return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  const payload = validateSow(req.body, EDITABLE_FIELDS, sow);
  const setClause = EDITABLE_FIELDS.map((f) => `${f} = ?`).join(', ');
  const values = EDITABLE_FIELDS.map((f) => (payload[f] !== undefined ? payload[f] : sow[f]));
  await db.prepare(`UPDATE sows SET ${setClause}, updated_at = now_utc_text() WHERE id = ?`).run(
    ...values,
    req.params.id
  );
  await recordAudit(db, req.user, 'sow', sow.id, 'update', sow, await db.prepare('SELECT * FROM sows WHERE id = ?').get(sow.id));
  res.json({ message: 'Cập nhật thành công' });
}));

router.delete('/:id', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const sow = await db.prepare('SELECT * FROM sows WHERE id = ?').get(req.params.id);
  if (!sow) return res.status(404).json({ error: 'Không tìm thấy heo nái' });
  if (req.user.role !== 'admin' && sow.farm_id !== req.user.farm_id) {
    return res.status(403).json({ error: 'Không có quyền xoá dữ liệu trại khác' });
  }

  const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(sow.farm_id);
  if (farm?.status !== 'active') return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  const careLogs = await db.prepare('SELECT * FROM sow_care_logs WHERE sow_id = ?').all(sow.id);
  const snapshot = { ...sow, care_logs: careLogs };

  // Lưu vết dữ liệu trước khi xoá để admin tra soát theo thời gian thực
  const deleter = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
  await db.prepare(
    `INSERT INTO sow_deletions (sow_id, farm_id, ma_so_nai, snapshot, deleted_by, deleted_by_name, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, now_utc_text())`
  ).run(
    sow.id,
    sow.farm_id,
    sow.ma_so_nai,
    JSON.stringify(snapshot),
    req.user.id,
    (deleter && deleter.full_name) || req.user.username
  );

  await db.prepare('DELETE FROM sows WHERE id = ?').run(req.params.id);
  await recordAudit(db, req.user, 'sow', sow.id, 'delete', snapshot, null);
  res.json({ message: 'Đã xoá' });
}));

module.exports = router;
