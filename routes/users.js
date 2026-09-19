const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { positiveId, validPassword, optionalText } = require('../utils/validation');
const transactional = require('../middleware/transaction');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

const PUBLIC_FIELDS =
  'id, username, full_name, address, phone, role, status, farm_id, created_at';

// Danh sách toàn bộ người dùng (lọc theo role/status nếu truyền query)
router.get('/', asyncHandler(async (req, res) => {
  const { role, status } = req.query;
  let sql = `SELECT ${PUBLIC_FIELDS} FROM users WHERE 1=1`;
  const params = [];
  if (role) {
    sql += ' AND role = ?';
    params.push(role);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(await db.prepare(sql).all(...params));
}));

// Admin tạo trực tiếp tài khoản nhân viên chăm sóc (được duyệt luôn)
router.post('/', transactional(async (req, res) => {
  const { username, password, full_name, farm_id, role } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    return res.status(400).json({ error: 'Tên đăng nhập không hợp lệ' });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'Mật khẩu cần ít nhất 8 ký tự, tối đa 72 byte UTF-8' });
  }
  if (full_name !== undefined && (typeof full_name !== 'string' || !full_name.trim() || full_name.length > 120)) {
    return res.status(400).json({ error: 'Họ tên không hợp lệ' });
  }
  if (farm_id !== undefined && farm_id !== null && !Number.isInteger(Number(farm_id))) {
    return res.status(400).json({ error: 'Trại không hợp lệ' });
  }
  if (role !== undefined && !['admin', 'staff', 'viewer'].includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  const finalRole = role || 'staff';
  if (farm_id != null) {
    const farm = await db.prepare("SELECT id FROM farms WHERE id = ? AND status = 'active'").get(positiveId(farm_id, 'Trại'));
    if (!farm) return res.status(400).json({ error: 'Trại không tồn tại hoặc đã lưu trữ' });
  }
  const existed = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existed) return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });

  const hash = bcrypt.hashSync(password, 10);
  const info = await db
    .prepare(
      "INSERT INTO users (username, password_hash, full_name, role, status, farm_id) VALUES (?, ?, ?, ?, 'approved', ?) RETURNING id"
    )
    .run(username, hash, full_name || username, finalRole, farm_id || null);
  await recordAudit(db, req.user, 'user', info.lastInsertRowid, 'create', null, await db.prepare('SELECT ' + PUBLIC_FIELDS + ' FROM users WHERE id = ?').get(info.lastInsertRowid));
  res.status(201).json({ id: info.lastInsertRowid });
}));

// Duyệt / từ chối tài khoản đăng ký (viewer) hoặc cập nhật thông tin người dùng
router.patch('/:id', transactional(async (req, res) => {
  const { id } = req.params;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });

  const { status, farm_id, full_name, role } = req.body || {};
  if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  if (role !== undefined && !['admin', 'staff', 'viewer'].includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  if (full_name !== undefined && !optionalText(full_name, 120, 'Họ tên')) return res.status(400).json({ error: 'Họ tên không được để trống' });
  if (farm_id != null) {
    const farm = await db.prepare("SELECT id FROM farms WHERE id = ? AND status = 'active'").get(positiveId(farm_id, 'Trại'));
    if (!farm) return res.status(400).json({ error: 'Trại không tồn tại hoặc đã lưu trữ' });
  }
  const next = {
    status: status || user.status,
    farm_id: farm_id !== undefined ? farm_id : user.farm_id,
    full_name: full_name !== undefined ? full_name : user.full_name,
    role: role || user.role,
  };
  if (user.role === 'admin' && user.status === 'approved' && (next.role !== 'admin' || next.status !== 'approved') &&
      (await db.prepare("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'approved'").get()).n <= 1) {
    return res.status(400).json({ error: 'Phải giữ ít nhất một quản trị viên đang hoạt động' });
  }
  await db.prepare('UPDATE users SET status = ?, farm_id = ?, full_name = ?, role = ? WHERE id = ?').run(
    next.status,
    next.farm_id,
    next.full_name,
    next.role,
    id
  );
  if (next.role !== user.role || next.status !== user.status || String(next.farm_id) !== String(user.farm_id)) {
    await db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
  }
  await recordAudit(db, req.user, 'user', user.id, 'update', user, await db.prepare('SELECT id, username, full_name, role, status, farm_id FROM users WHERE id = ?').get(id));
  res.json({ message: 'Cập nhật thành công' });
}));

// Xoá tài khoản (nhân viên hoặc người dùng thường)
router.delete('/:id', transactional(async (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: 'Không thể tự xoá tài khoản đang đăng nhập' });
  }
  const user = await db.prepare('SELECT id, username, full_name, role, status, farm_id FROM users WHERE id = ?').get(id);
  if (user?.role === 'admin' && user.status === 'approved' && (await db.prepare("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'approved'").get()).n <= 1) {
    return res.status(400).json({ error: 'Không thể xoá quản trị viên cuối cùng' });
  }
  const info = await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
  await recordAudit(db, req.user, 'user', user.id, 'delete', user, null);
  res.json({ message: 'Đã xoá tài khoản' });
}));

module.exports = router;
