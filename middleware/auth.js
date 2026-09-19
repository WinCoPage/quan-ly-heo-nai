const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;

function isStrongSecret(secret) {
  if (!secret || secret.length < 32) return false;
  if (/^(dev|change|replace|secret|doi_secret)/i.test(secret)) return false;
  return new Set(secret).size >= 16 && /[A-Z]/.test(secret) && /[a-z]/.test(secret) && /\d/.test(secret);
}

if (!isStrongSecret(JWT_SECRET)) {
  throw new Error(
    'JWT_SECRET thiếu hoặc quá yếu. Hãy đặt JWT_SECRET ngẫu nhiên, tối thiểu 32 ký tự, trước khi khởi động server.'
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = await db.prepare('SELECT id, username, full_name, role, status, farm_id, token_version FROM users WHERE id = ?').get(payload.id);
    if (!user || user.status !== 'approved') {
      return res.status(401).json({ error: 'Tài khoản không còn hoạt động' });
    }
    if ((payload.token_version ?? 0) !== user.token_version) {
      return res.status(401).json({ error: 'Phiên đăng nhập đã bị thu hồi. Vui lòng đăng nhập lại.' });
    }
    payload.role = user.role;
    payload.farm_id = user.farm_id;
    req.user = { ...payload, ...user };
  } catch (err) {
    return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này' });
    }
    next();
  };
}

module.exports = { authRequired, requireRole, JWT_SECRET };
