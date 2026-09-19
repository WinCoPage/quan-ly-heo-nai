const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { sanitize } = require('../utils/audit');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Math.floor(Number(req.query.limit) || 100), 1), 500);
  const rows = await db
    .prepare(
      `SELECT id, entity_type, entity_id, action, before_snapshot, after_snapshot,
              actor_id, actor_name, created_at
       FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(limit);
  for (const row of rows) {
    for (const key of ['before_snapshot', 'after_snapshot']) {
      if (row[key]) {
        try { row[key] = sanitize(JSON.parse(row[key])); }
        catch { row[key] = null; }
      }
    }
  }
  res.json(rows);
}));

module.exports = router;
