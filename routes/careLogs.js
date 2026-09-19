const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { positiveId } = require('../utils/validation');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired);

router.get('/export', asyncHandler(async (req, res) => {
  const requestedFarmId = req.query.farm_id ? positiveId(req.query.farm_id, 'Trại') : null;
  const requestedSowId = req.query.sow_id ? positiveId(req.query.sow_id, 'Heo nái') : null;

  if (req.user.role === 'staff' && requestedFarmId && requestedFarmId !== req.user.farm_id) {
    return res.status(403).json({ error: 'Không có quyền xuất dữ liệu trại khác' });
  }
  if (req.user.role === 'staff' && !req.user.farm_id) {
    return res.status(400).json({ error: 'Tài khoản chưa được gán trại' });
  }

  for (const farmId of [requestedFarmId, req.user.role === 'staff' ? req.user.farm_id : null].filter(Boolean)) {
    const farm = await db.prepare('SELECT status FROM farms WHERE id = ?').get(farmId);
    if (!farm) return res.status(404).json({ error: 'Không tìm thấy trại' });
    if (req.user.role !== 'admin' && farm.status !== 'active') return res.status(403).json({ error: 'Trại đã ngừng sử dụng' });
  }
  if (requestedSowId) {
    const sow = await db.prepare('SELECT s.farm_id, f.status FROM sows s JOIN farms f ON f.id = s.farm_id WHERE s.id = ?').get(requestedSowId);
    if (!sow) return res.status(404).json({ error: 'Không tìm thấy heo nái' });
    if ((req.user.role === 'staff' && sow.farm_id !== req.user.farm_id) || (req.user.role !== 'admin' && sow.status !== 'active')) return res.status(403).json({ error: 'Không có quyền xuất dữ liệu này' });
  }
  const conditions = req.user.role === 'admin' ? [] : ["f.status = 'active'"];
  const params = [];
  if (req.user.role === 'staff') {
    conditions.push('scl.farm_id = ?');
    params.push(req.user.farm_id);
  } else if (requestedFarmId) {
    conditions.push('scl.farm_id = ?');
    params.push(requestedFarmId);
  }
  if (requestedSowId) {
    conditions.push('scl.sow_id = ?');
    params.push(requestedSowId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db
    .prepare(
      `SELECT f.name AS farm_name, s.ma_so_nai, s.dong_nai, scl.status, scl.note,
              scl.created_at, u.full_name AS created_by_name
       FROM sow_care_logs scl
       JOIN sows s ON s.id = scl.sow_id
       LEFT JOIN farms f ON f.id = scl.farm_id
       LEFT JOIN users u ON u.id = scl.created_by
       ${where}
       ORDER BY scl.created_at DESC`
    )
    .all(...params);

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Nhat ky cham soc');
  worksheet.columns = [
    { header: 'STT', key: 'index', width: 7 },
    { header: 'Tên trại', key: 'farm_name', width: 22 },
    { header: 'Mã số nái', key: 'ma_so_nai', width: 15 },
    { header: 'Dòng nái', key: 'dong_nai', width: 16 },
    { header: 'Trạng thái', key: 'status', width: 28 },
    { header: 'Ghi chú chăm sóc', key: 'note', width: 42 },
    { header: 'Ngày giờ ghi nhận', key: 'created_at', width: 24 },
    { header: 'Nhân viên ghi nhận', key: 'created_by_name', width: 26 },
  ];
  rows.forEach((row, index) => worksheet.addRow({ ...row, created_at: new Date(row.created_at.replace(' ', 'T') + 'Z').toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }), index: index + 1 }));
  if (!rows.length) worksheet.addRow({ farm_name: 'Chưa có nhật ký chăm sóc' });
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8622C' } };
  worksheet.autoFilter = { from: 'A1', to: 'H1' };
  const buffer = await workbook.xlsx.writeBuffer();
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="nhat-ky-cham-soc-${date}.xlsx"`);
  res.send(buffer);
}));

module.exports = router;
