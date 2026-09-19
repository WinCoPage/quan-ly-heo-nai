const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

// Lịch sử heo nái đã bị xoá - chỉ admin xem được, phục vụ tra soát
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT sd.*, f.name AS farm_name
       FROM sow_deletions sd LEFT JOIN farms f ON f.id = sd.farm_id
       ORDER BY sd.deleted_at DESC`
    )
    .all();
  res.json(rows);
}));

module.exports = router;
