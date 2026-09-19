require('dotenv').config();
const path = require('path');
const express = require('express');

const db = require('./db'); // khởi tạo pool kết nối & lược đồ PostgreSQL

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const farmRoutes = require('./routes/farms');
const sowRoutes = require('./routes/sows');
const sowDeletionRoutes = require('./routes/sowDeletions');
const careLogRoutes = require('./routes/careLogs');
const auditLogRoutes = require('./routes/auditLogs');
const vaccinationRoutes = require('./routes/vaccinations');

const app = express();
if (process.env.TRUST_PROXY_HOPS) {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new Error('TRUST_PROXY_HOPS không hợp lệ');
  app.set('trust proxy', hops);
}
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '100kb' }));

// Kiểm tra tồn tại/khởi động (Render, giám sát ...) - không cần đăng nhập
app.get('/healthz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (['POST', 'PUT', 'PATCH'].includes(req.method) &&
      (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return res.status(400).json({ error: 'Dữ liệu yêu cầu phải là đối tượng JSON' });
  }
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/farms', farmRoutes);
app.use('/api/sows', sowRoutes);
app.use('/api/sow-deletions', sowDeletionRoutes);
app.use('/api/care-logs', careLogRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/vaccinations', vaccinationRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy chức năng' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status === 413 ? 413 : error.status === 400 || error.type === 'entity.parse.failed' ? 400 : 500;
  if (status === 500) console.error('Lỗi xử lý yêu cầu:', error.code || error.name);
  res.status(status).json({ error: status === 500 ? 'Có lỗi hệ thống. Vui lòng thử lại.' : status === 413 ? 'Dữ liệu quá lớn' : error.type === 'entity.parse.failed' ? 'JSON không hợp lệ' : error.message });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  db.ready
    .then(() => {
      const server = app.listen(PORT, () => console.log(`Server đang chạy tại http://localhost:${PORT}`));
      const shutdown = () => server.close(() => { db.close().finally(() => process.exit(0)); });
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((error) => {
      console.error('Không thể khởi động máy chủ (lỗi kết nối PostgreSQL):', error.message);
      process.exit(1);
    });
}
module.exports = app;
