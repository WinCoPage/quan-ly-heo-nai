const express = require('express');
const ExcelJS = require('exceljs');
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

function pregnancyConfirmed(sow) {
  return ['log_ky1', 'log_ky2', 'log_ky3'].some((field) => {
    const value = String(sow[field] || '').trim().toLowerCase();
    return ['x', 'đậu', 'dau', 'đậu thai', 'dau thai', 'có', 'co', 'positive'].includes(value);
  });
}

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

function sowDateToIso(value) {
  if (!value) return null;
  const [day, month, year] = String(value).split(/[/-]/).map(Number);
  if (!day || !month || !year) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

async function syncPregnancyFromSow(animal) {
  const sow = await db.prepare('SELECT * FROM sows WHERE farm_id = ? AND ma_so_nai = ? ORDER BY id DESC LIMIT 1').get(animal.farm_id, animal.ma_so_nai);
  const confirmed = sow && pregnancyConfirmed(sow) && sow.ngay_phoi;
  const breedingDate = confirmed ? sowDateToIso(sow.ngay_phoi) : null;
  if (animal.breeding_date === breedingDate) return;
  await db.prepare('UPDATE breeding_animals SET breeding_date = ?, updated_at = now_utc_text() WHERE id = ?').run(breedingDate, animal.id);
  await db.prepare("DELETE FROM vaccination_events WHERE animal_id = ? AND phase = 'pregnant' AND administered_at IS NULL").run(animal.id);
  if (breedingDate) await insertSchedule(scheduleFor(animal.id, animal.farm_id, 'pregnant', breedingDate));
}

async function getAnimalsWithEvents(req, requestedFarmId) {
  const farmId = scopeFarm(req, requestedFarmId);
  const params = [];
  let where = "ba.status = 'active'";
  if (farmId) { where += ' AND ba.farm_id = ?'; params.push(farmId); }
  if (req.user.role === 'staff' && !farmId) throw Object.assign(new Error('Tài khoản chưa được gán trại'), { status: 400 });
  let animals = await db.prepare(
    `SELECT ba.*, f.name AS farm_name
     FROM breeding_animals ba JOIN farms f ON f.id = ba.farm_id
     WHERE ${where} ORDER BY ba.arrival_date DESC, ba.ma_so_nai`
  ).all(...params);
  for (const animal of animals) await syncPregnancyFromSow(animal);
  animals = await db.prepare(
    `SELECT ba.*, f.name AS farm_name,
       s.ngay_phoi AS sow_breeding_date,
       CASE WHEN lower(trim(coalesce(s.log_ky1, ''))) IN ('x', 'đậu', 'dau', 'đậu thai', 'dau thai', 'có', 'co', 'positive')
              OR lower(trim(coalesce(s.log_ky2, ''))) IN ('x', 'đậu', 'dau', 'đậu thai', 'dau thai', 'có', 'co', 'positive')
              OR lower(trim(coalesce(s.log_ky3, ''))) IN ('x', 'đậu', 'dau', 'đậu thai', 'dau thai', 'có', 'co', 'positive')
            THEN 'Đậu thai' ELSE 'Chưa xác nhận' END AS pregnancy_result
     FROM breeding_animals ba JOIN farms f ON f.id = ba.farm_id
     LEFT JOIN LATERAL (SELECT ngay_phoi, log_ky1, log_ky2, log_ky3 FROM sows WHERE farm_id = ba.farm_id AND ma_so_nai = ba.ma_so_nai ORDER BY id DESC LIMIT 1) s ON true
     WHERE ${where} ORDER BY ba.arrival_date DESC, ba.ma_so_nai`
  ).all(...params);
  const events = animals.length
    ? await db.prepare('SELECT ve.*, u.full_name AS administered_by_name FROM vaccination_events ve LEFT JOIN users u ON u.id = ve.administered_by WHERE ve.animal_id = ANY(?) ORDER BY ve.scheduled_date, ve.id').all(animals.map((animal) => animal.id))
    : [];
  return animals.map((animal) => ({ ...animal, vaccination_events: events.filter((event) => event.animal_id === animal.id) }));
}

router.get('/animals', asyncHandler(async (req, res) => {
  res.json(await getAnimalsWithEvents(req, req.query.farm_id));
}));

router.get('/export', asyncHandler(async (req, res) => {
  const animals = await getAnimalsWithEvents(req, req.query.farm_id);
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Theo doi tiem chung');
  const vaccineColumns = [...HEIFER_SCHEDULE.map(([name]) => `HB: ${name}`), ...PREGNANT_SCHEDULE.map(([name]) => `NC: ${name}`)];
  worksheet.columns = [
    { header: 'STT', key: 'index', width: 7 },
    { header: 'Tên trại', key: 'farm_name', width: 20 },
    { header: 'Mã số nái', key: 'ma_so_nai', width: 15 },
    { header: 'Dòng nái', key: 'dong_nai', width: 16 },
    { header: 'Kg', key: 'weight_kg', width: 9 },
    { header: 'Ngày nhập', key: 'arrival_date', width: 14 },
    { header: 'Ngày phối', key: 'breeding_date', width: 14 },
    { header: 'Kết quả đậu thai', key: 'pregnancy_result', width: 18 },
    ...vaccineColumns.map((name, index) => ({ header: name, key: `v${index}`, width: 24 })),
  ];
  animals.forEach((animal, index) => {
    const row = {
      index: index + 1,
      farm_name: animal.farm_name,
      ma_so_nai: animal.ma_so_nai,
      dong_nai: animal.dong_nai || '',
      weight_kg: Number(animal.weight_kg),
      arrival_date: animal.arrival_date,
      breeding_date: animal.sow_breeding_date || animal.breeding_date || '',
      pregnancy_result: animal.pregnancy_result || 'Chưa xác nhận',
    };
    vaccineColumns.forEach((column, eventIndex) => {
      const phase = eventIndex < HEIFER_SCHEDULE.length ? 'heifer' : 'pregnant';
      const vaccineName = column.slice(4);
      const event = animal.vaccination_events.find((item) => item.phase === phase && item.vaccine_name === vaccineName);
      row[`v${eventIndex}`] = event ? `${event.administered_at ? 'Đã tiêm' : 'Chưa tiêm'} - ${event.scheduled_date}${event.administered_at ? ` - ${event.administered_at}` : ''}` : 'Chưa tạo lịch';
    });
    worksheet.addRow(row);
  });
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8622C' } };
  worksheet.views = [{ state: 'frozen', xSplit: 7, ySplit: 1 }];
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="theo-doi-tiem-chung-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buffer);
}));

router.post('/animals', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const { farm_id, ma_so_nai, dong_nai, weight_kg, source, arrival_date } = req.body || {};
  const farmId = req.user.role === 'staff' ? req.user.farm_id : positiveId(farm_id, 'Trại');
  if (!farmId) return res.status(400).json({ error: 'Tài khoản chưa được gán trại' });
  if (typeof ma_so_nai !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(ma_so_nai)) return res.status(400).json({ error: 'Mã số nái không hợp lệ' });
  const weight = Number(weight_kg);
  if (!Number.isFinite(weight) || weight < 90 || weight > 170) return res.status(400).json({ error: 'Trọng lượng heo hậu bị phải từ 90 đến 170 kg' });
  const farm = await db.prepare("SELECT id FROM farms WHERE id = ? AND status = 'active'").get(farmId);
  if (!farm) return res.status(400).json({ error: 'Trại không tồn tại hoặc đã lưu trữ' });
  const arrival = normalizeDate(arrival_date, 'Ngày nhập');
  const info = await db.prepare(
    `INSERT INTO breeding_animals (farm_id, ma_so_nai, dong_nai, weight_kg, source, arrival_date, breeding_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).run(farmId, ma_so_nai, optionalText(dong_nai, 80, 'Dòng nái'), weight, optionalText(source, 200, 'Nguồn nhập'), arrival, null, req.user.id);
  await insertSchedule(scheduleFor(info.lastInsertRowid, farmId, 'heifer', arrival));
  const animal = await db.prepare('SELECT * FROM breeding_animals WHERE id = ?').get(info.lastInsertRowid);
  await recordAudit(db, req.user, 'breeding_animal', animal.id, 'create', null, animal);
  res.status(201).json(animal);
}));

router.patch('/animals/:id', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const id = positiveId(req.params.id, 'Heo hậu bị');
  const animal = await db.prepare('SELECT * FROM breeding_animals WHERE id = ?').get(id);
  if (!animal) return res.status(404).json({ error: 'Không tìm thấy heo hậu bị' });
  if (req.user.role === 'staff' && animal.farm_id !== req.user.farm_id) return res.status(403).json({ error: 'Không có quyền sửa trại khác' });
  return res.status(400).json({ error: 'Ngày phối được đồng bộ từ Số liệu heo nái và kết quả đậu thai Log kỳ 1, 2 hoặc 3.' });
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

router.post('/events/:id/revert', requireRole('admin', 'staff'), transactional(async (req, res) => {
  const id = positiveId(req.params.id, 'Mũi tiêm');
  const event = await db.prepare('SELECT * FROM vaccination_events WHERE id = ?').get(id);
  if (!event) return res.status(404).json({ error: 'Không tìm thấy lịch tiêm' });
  if (req.user.role === 'staff' && event.farm_id !== req.user.farm_id) {
    return res.status(403).json({ error: 'Không có quyền sửa trại khác' });
  }
  if (!event.administered_at) return res.status(400).json({ error: 'Mũi tiêm chưa được ghi nhận' });
  const updated = await db.prepare(
    'UPDATE vaccination_events SET administered_at = NULL, administered_by = NULL, note = ? WHERE id = ? RETURNING *'
  ).run(`Hoàn tác lúc ${new Date().toISOString()}: ${optionalText(req.body?.note, 500, 'Ghi chú') || 'Bấm nhầm'}`, id);
  await recordAudit(db, req.user, 'vaccination_event', id, 'revert', event, updated.rows[0]);
  res.json(updated.rows[0]);
}));

router.syncPregnancyFromSow = syncPregnancyFromSow;
module.exports = router;
