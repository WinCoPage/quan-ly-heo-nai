const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET, authRequired } = require('../middleware/auth');
const { validPassword } = require('../utils/validation');
const rateLimit = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const cleanupAttempts = setInterval(() => {
  for (const [key, value] of loginAttempts) if (Date.now() - value.firstFailure >= LOGIN_WINDOW_MS) loginAttempts.delete(key);
}, 60000);
cleanupAttempts.unref();

function text(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validUsername(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{3,64}$/.test(value);
}

function attemptKey(req, username) {
  return `${req.ip}:${String(username || '').toLowerCase()}`;
}

function isLoginBlocked(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt || Date.now() - attempt.firstFailure >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return attempt.failures >= MAX_LOGIN_FAILURES;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (!attempt || now - attempt.firstFailure >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { failures: 1, firstFailure: now });
  } else {
    attempt.failures += 1;
  }
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

// Tài khoản mới cần quản trị viên duyệt trước khi xem số liệu.
router.post('/register', rateLimit(10, LOGIN_WINDOW_MS), asyncHandler(async (req, res) => {
  const { username, password, full_name, address, phone } = req.body || {};
  if (!validUsername(username) || !text(full_name, 120) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Họ tên hoặc tên đăng nhập không hợp lệ' });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'Mật khẩu cần ít nhất 8 ký tự, tối đa 72 byte UTF-8' });
  }
  if (address !== undefined && address !== null && (typeof address !== 'string' || address.length > 250)) {
    return res.status(400).json({ error: 'Địa chỉ không hợp lệ' });
  }
  if (phone !== undefined && phone !== null && phone !== '' && (typeof phone !== 'string' || !/^\+?[0-9 ()-]{7,20}$/.test(phone))) {
    return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  }
  const existed = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existed) {
    return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = await db
    .prepare(
      "INSERT INTO users (username, password_hash, full_name, address, phone, role, status) VALUES (?, ?, ?, ?, ?, 'viewer', 'pending') RETURNING id"
    )
    .run(username, hash, full_name, address || null, phone || null);
  res.status(201).json({
    message: 'Đăng ký thành công. Vui lòng chờ quản trị viên duyệt tài khoản.',
    id: info.lastInsertRowid,
  });
}));

router.post('/login', rateLimit(60, LOGIN_WINDOW_MS), asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const key = attemptKey(req, username);
  if (!validUsername(username) || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Thông tin đăng nhập không hợp lệ' });
  }
  if (isLoginBlocked(key)) {
    return res.status(429).json({ error: 'Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau 15 phút.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(key);
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  clearLoginFailures(key);
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Tài khoản đang chờ quản trị viên duyệt' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'Tài khoản của bạn đã bị từ chối' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, farm_id: user.farm_id, token_version: user.token_version },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      farm_id: user.farm_id,
    },
  });
}));

router.get('/me', authRequired, asyncHandler(async (req, res) => {
  const user = await db
    .prepare('SELECT id, username, full_name, role, status, farm_id FROM users WHERE id = ?')
    .get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
  res.json(user);
}));

router.post('/change-password', authRequired, rateLimit(10, LOGIN_WINDOW_MS), asyncHandler(async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (typeof old_password !== 'string' || typeof new_password !== 'string') {
    return res.status(400).json({ error: 'Thiếu dữ liệu' });
  }
  if (!validPassword(new_password)) {
    return res.status(400).json({ error: 'Mật khẩu mới cần ít nhất 8 ký tự, tối đa 72 byte UTF-8' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(401).json({ error: 'Mật khẩu cũ không đúng' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, user.id);
  res.json({ message: 'Đổi mật khẩu thành công' });
}));

module.exports = router;
