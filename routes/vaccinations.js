const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { positiveId, optionalText } = require('../utils/validation');
const transactional = require('../middleware/transaction');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authRequired);

const HEIFER_SCHEDULE = [
  ['Tẩy ký sinh trùng', 2],
  ['Pavo (chống khô thai)', 7],
  ['Dịch tả', 14],
  ['PRRS (Tai Xanh)', 21],
  ['FMD (Lở mồm long móng)', 28],
  ['Aujeszky (Giả dại)', 35],
];
const PREGNANT_SCHEDULE = [
  ['Bravo (Khô Thai)', 42],
  ['PRRS (Tai Xanh)', 50],
  ['Ecoli', 84],
  ['Tẩy KST', 105],
];

function normalizeDate(value, label) {
  if (typeof value !== 'string') throw Object.assign(new Error(`${label} không hợp lệ`), { status: 400 });
  const parts = value.includes('-') ? value.split('-').map(Number) : value.split(/[\/]/).map(Number).reverse();
  if (parts.length !== 3) throw Object.assign(new Error(`${label} không hợp lệ`), { status: 400 });
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw Object.assign(new Error(`${label} không hợp lệ`), { status: 400 });
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function scheduleFor(animalId, farmId, phase, baseDate) {
  const schedule = phase === 'pregnant' ? PREGNANT_SCHEDULE : HEIFER_SCHEDULE;
  return schedule.map(([vaccineName, dayOffset]) => ({
    animalId,
    farmId,
    phase,
    vaccineName,
    dayOffset,
    scheduledDate: addDays(baseDate, dayOffset),
  }));
}

function scopeFarm(req, requestedFarmId) {
  if (req.user.role === 'staff') return req.user.farm_id;
  return requestedFarmId ? positiveId(requestedFarmId, 'Trại') : null;
}

async function insertSchedule(events) {
  for (const event of events) {
    await db.prepare(
      `INSERT INTO vaccination_events
       (animal_id, farm_id, phase, vaccine_name, day_offset, scheduled_date)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(event.animalId, event.farmId, event.phase, event.vaccineName, event.dayOffset, event.scheduledDate);
  }
}

router.get('/animals', asyncHandler(async (req, res) => {
  const farmId = scopeFarm(req, req.query.farm_id);
  const params = [];
  let where = "ba.status = 'active'";
  if (farmId) { where += ' AND ba.farm_id = ?'; params.push(farmId); }
  if (req.user.role === 'staff' && !farmId) return res.status(400).json({ error: 'Tài khoản chưa được gán trại' });
  const animals = await db.prepare(
    `SELECT ba.*, f.name AS farm_name
     FROM breeding_animals ba JOIN farms f ON f.id = ba.farm_id
     WHERE ${where} ORDER BY ba.arrival_date DESC, ba.ma_so_nai`
  ).all(...params);
  const events = animals.length
    ? await db.prepare('SELECT ve.*, u.full_name AS administered_by_name FROM vaccination_events ve LEFT JOIN users u ON u.id = ve.administered_by WHERE ve.animal_id = ANY(?) ORDER BY ve.scheduled_date, ve.id').all(animals.map((animal) => animal.id))
    : [];
  res.json(animals.map((animal) => ({ ...animal, vaccination_events: events.filter((event) => event.animal_id === animal.id) })));
}));

router.post('/animals', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const { farm_id, ma_so_nai, dong_nai, weight_kg, source, arrival_date, breeding_date } = req.body || {};
  const farmId = req.user.role === 'staff' ? req.user.farm_id : positiveId(farm_id, 'Trại');
  if (!farmId) return res.status(400).json({ error: 'Tài khoản chưa được gán trại' });
  if (typeof ma_so_nai !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(ma_so_nai)) return res.status(400).json({ error: 'Mã số nái không hợp lệ' });
  const weight = Number(weight_kg);
  if (!Number.isFinite(weight) || weight < 90 || weight > 170) return res.status(400).json({ error: 'Trọng lượng heo hậu bị phải từ 90 đến 170 kg' });
  const farm = await db.prepare("SELECT id FROM farms WHERE id = ? AND status = 'active'").get(farmId);
  if (!farm) return res.status(400).json({ error: 'Trại không tồn tại hoặc đã lưu trữ' });
  const arrival = normalizeDate(arrival_date, 'Ngày nhập');
  const breeding = breeding_date ? normalizeDate(breeding_date, 'Ngày phối') : null;
  if (breeding && breeding < arrival) return res.status(400).json({ error: 'Ngày phối không thể trước ngày nhập' });
  const info = await db.prepare(
    `INSERT INTO breeding_animals (farm_id, ma_so_nai, dong_nai, weight_kg, source, arrival_date, breeding_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).run(farmId, ma_so_nai, optionalText(dong_nai, 80, 'Dòng nái'), optionalText(String(weight), 20, 'Trọng lượng'), optionalText(source, 200, 'Nguồn nhập'), arrival, breeding, req.user.id);
  await insertSchedule(scheduleFor(info.lastInsertRowid, farmId, 'heifer', arrival));
  if (breeding) await insertSchedule(scheduleFor(info.lastInsertRowid, farmId, 'pregnant', breeding));
  const animal = await db.prepare('SELECT * FROM breeding_animals WHERE id = ?').get(info.lastInsertRowid);
  await recordAudit(db, req.user, 'breeding_animal', animal.id, 'create', null, animal);
  res.status(201).json(animal);
}));

router.patch('/animals/:id', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const id = positiveId(req.params.id, 'Heo hậu bị');
  const animal = await db.prepare('SELECT * FROM breeding_animals WHERE id = ?').get(id);
  if (!animal) return res.status(404).json({ error: 'Không tìm thấy heo hậu bị' });
  if (req.user.role === 'staff' && animal.farm_id !== req.user.farm_id) return res.status(403).json({ error: 'Không có quyền sửa trại khác' });
  const breeding = req.body.breeding_date ? normalizeDate(req.body.breeding_date, 'Ngày phối') : req.body.breeding_date === null ? null : animal.breeding_date;
  if (breeding && breeding < animal.arrival_date) return res.status(400).json({ error: 'Ngày phối không thể trước ngày nhập' });
  await db.prepare('UPDATE breeding_animals SET breeding_date = ?, updated_at = now_utc_text() WHERE id = ?').run(breeding, id);
  if (breeding !== animal.breeding_date) {
    await db.prepare("DELETE FROM vaccination_events WHERE animal_id = ? AND phase = 'pregnant' AND administered_at IS NULL").run(id);
    if (breeding) await insertSchedule(scheduleFor(id, animal.farm_id, 'pregnant', breeding));
  }
  const updated = await db.prepare('SELECT * FROM breeding_animals WHERE id = ?').get(id);
  await recordAudit(db, req.user, 'breeding_animal', id, 'update', animal, updated);
  res.json(updated);
}));

router.post('/events/:id/administer', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const id = positiveId(req.params.id, 'Mũi tiêm');
  const event = await db.prepare('SELECT ve.*, ba.ma_so_nai FROM vaccination_events ve JOIN breeding_animals ba ON ba.id = ve.animal_id WHERE ve.id = ?').get(id);
  if (!event) return res.status(404).json({ error: 'Không tìm thấy lịch tiêm' });
  if (req.user.role === 'staff' && event.farm_id !== req.user.farm_id) return res.status(403).json({ error: 'Không có quyền cập nhật trại khác' });
  if (event.administered_at) return res.status(400).json({ error: 'Mũi tiêm này đã được ghi nhận' });
  const note = optionalText(req.body?.note, 500, 'Ghi chú');
  const result = await db.prepare("UPDATE vaccination_events SET administered_at = now_utc_text(), administered_by = ?, note = ? WHERE id = ? RETURNING *").run(req.user.id, note, id);
  const updated = await db.prepare('SELECT ve.*, u.full_name AS administered_by_name FROM vaccination_events ve LEFT JOIN users u ON u.id = ve.administered_by WHERE ve.id = ?').get(id);
  await recordAudit(db, req.user, 'vaccination_event', id, 'administer', event, updated);
  res.json(updated);
}));

module.exports = router;
