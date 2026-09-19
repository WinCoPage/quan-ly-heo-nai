const transactional = require('../middleware/transaction');
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired);

// Mọi người dùng đã đăng nhập đều xem được danh sách trại
router.get('/', asyncHandler(async (req, res) => {
  const includeArchived = req.user.role === 'admin' && req.query.include_archived === '1';
  const sql = includeArchived
    ? 'SELECT * FROM farms ORDER BY status, name'
    : "SELECT * FROM farms WHERE status = 'active' ORDER BY name";
  res.json(await db.prepare(sql).all());
}));

router.post('/', requireRole('admin'), transactional(async (req, res) => {
  const { name, address } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 120) {
    return res.status(400).json({ error: 'Tên trại không hợp lệ' });
  }
  if (address !== undefined && address !== null && (typeof address !== 'string' || address.length > 250)) {
    return res.status(400).json({ error: 'Địa chỉ trại không hợp lệ' });
  }
  const info = await db.prepare('INSERT INTO farms (name, address) VALUES (?, ?) RETURNING id').run(name, address || '');
  const farm = await db.prepare('SELECT * FROM farms WHERE id = ?').get(info.lastInsertRowid);
  await recordAudit(db, req.user, 'farm', farm.id, 'create', null, farm);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.patch('/:id', requireRole('admin'), transactional(async (req, res) => {
  const { name, address } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 120)) {
    return res.status(400).json({ error: 'Tên trại không hợp lệ' });
  }
  if (address !== undefined && address !== null && (typeof address !== 'string' || address.length > 250)) {
    return res.status(400).json({ error: 'Địa chỉ trại không hợp lệ' });
  }
  const farm = await db.prepare('SELECT * FROM farms WHERE id = ?').get(req.params.id);
  if (!farm) return res.status(404).json({ error: 'Không tìm thấy trại' });
  await db.prepare('UPDATE farms SET name = ?, address = ? WHERE id = ?').run(
    name || farm.name,
    address !== undefined ? address : farm.address,
    req.params.id
  );
  await recordAudit(db, req.user, 'farm', farm.id, 'update', farm, await db.prepare('SELECT * FROM farms WHERE id = ?').get(farm.id));
  res.json({ message: 'Cập nhật thành công' });
}));

router.post('/:id/archive', requireRole('admin'), transactional(async (req, res) => {
  const farm = await db.prepare('SELECT * FROM farms WHERE id = ?').get(req.params.id);
  if (!farm) return res.status(404).json({ error: 'Không tìm thấy trại' });
  if (farm.status === 'archived') return res.status(400).json({ error: 'Trại đã được lưu trữ' });
  await db.prepare("UPDATE farms SET status = 'archived', archived_at = now_utc_text(), archived_by = ? WHERE id = ?").run(req.user.id, farm.id);
  const updated = await db.prepare('SELECT * FROM farms WHERE id = ?').get(farm.id);
  await recordAudit(db, req.user, 'farm', farm.id, 'archive', farm, updated);
  res.json({ message: 'Đã ngừng sử dụng và lưu trữ trại' });
}));

router.post('/:id/restore', requireRole('admin'), transactional(async (req, res) => {
  const farm = await db.prepare('SELECT * FROM farms WHERE id = ?').get(req.params.id);
  if (!farm) return res.status(404).json({ error: 'Không tìm thấy trại' });
  if (farm.status === 'active') return res.status(400).json({ error: 'Trại đang hoạt động' });
  await db.prepare("UPDATE farms SET status = 'active', archived_at = NULL, archived_by = NULL WHERE id = ?").run(farm.id);
  const updated = await db.prepare('SELECT * FROM farms WHERE id = ?').get(farm.id);
  await recordAudit(db, req.user, 'farm', farm.id, 'restore', farm, updated);
  res.json({ message: 'Đã khôi phục trại' });
}));

router.delete('/:id', requireRole('admin'), transactional(async (req, res) => {
  return res.status(405).json({ error: 'Không hỗ trợ xoá vĩnh viễn trại. Hãy lưu trữ trại.' });
}));

module.exports = router;
