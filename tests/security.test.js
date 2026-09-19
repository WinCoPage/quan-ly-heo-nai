const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
process.env.JWT_SECRET = 'TestOnlyAa19' + randomBytes(48).toString('base64url');
process.env.NODE_ENV = 'test';
process.env.TRUST_PROXY_HOPS = '0';
if (!process.env.DATABASE_URL) {
  throw new Error(
    'Đặt biến môi trường DATABASE_URL trỏ tới một CSDL PostgreSQL dùng RIÊNG cho kiểm thử trước khi chạy npm test (ví dụ một Neon branch tạm thời).'
  );
}
if (process.env.ALLOW_TEST_DB_WIPE !== '1') {
  throw new Error(
    'Bộ kiểm thử sẽ xoá trắng toàn bộ dữ liệu trong DATABASE_URL. Đặt ALLOW_TEST_DB_WIPE=1 để xác nhận đây là CSDL kiểm thử dùng riêng, không phải CSDL vận hành.'
  );
}
const app = require('../server');
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { recordAudit } = require('../utils/audit');
const { validPassword } = require('../utils/validation');
let server;
let base;
const password = 'SecureTest123!';
const hash = bcrypt.hashSync(password, 4);
async function user(name, role, farm = null) {
  const info = await db.prepare("INSERT INTO users (username, password_hash, full_name, role, status, farm_id) VALUES (?, ?, ?, ?, 'approved', ?)").run(name, hash, name, role, farm);
  return Number(info.lastInsertRowid);
}
async function token(id) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return jwt.sign({ id, role: u.role, username: u.username, farm_id: u.farm_id, token_version: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function request(url, method = 'GET', body, auth) {
  const res = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}
before(async () => {
  await db.ready;
  // Xoá trắng CSDL kiểm thử và tái tạo trại mặc định (id = 1) trước khi chạy bộ kiểm thử.
  await db.pool.query('TRUNCATE farms, users, sows, sow_care_logs, sow_deletions, audit_logs RESTART IDENTITY CASCADE');
  await db.pool.query("INSERT INTO farms (name, address) VALUES ('Trại 1', '')");
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
});

test('Production safeguards against an isolated in-memory database', async t => {
  const admin = await user('testadmin', 'admin');
  const farm1 = 1;
  const farm2 = Number((await db.prepare("INSERT INTO farms (name) VALUES ('Second farm') RETURNING id").run()).lastInsertRowid);
  const staff = await user('teststaff', 'staff', farm1);
  const viewer = await user('testviewer', 'viewer');
  const adminToken = await token(admin), staffToken = await token(staff), viewerToken = await token(viewer);
  let sow1, sow2, createdStaff;

  await t.test('Authentication required, viewer writes denied, API 404 is JSON', async () => {
    assert.equal((await request('/sows')).status, 401);
    assert.equal((await request('/sows', 'POST', { farm_id: farm1, ma_so_nai: 'x' }, viewerToken)).status, 403);
    assert.equal((await request('/does-not-exist')).status, 404);
    const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type'), /json/);
    assert.ok(bad.headers.get('content-security-policy'));
  });

  await t.test('Registration accepts blank optional phone, remains pending, requires approval', async () => {
    const reg = await request('/auth/register', 'POST', { username: 'newviewer', full_name: '<img src=x onerror=alert(1)>', password, phone: '', address: '' });
    assert.equal(reg.status, 201);
    assert.equal((await request('/auth/login', 'POST', { username: 'newviewer', password })).status, 403);
    assert.equal((await request('/users/' + reg.data.id, 'PATCH', { status: 'approved' }, adminToken)).status, 200);
    assert.equal((await request('/auth/login', 'POST', { username: 'newviewer', password })).status, 200);
  });

  await t.test('Creating a staff account returns success and audit contains no credentials', async () => {
    const result = await request('/users', 'POST', { username: 'createdstaff', password, farm_id: farm1, role: 'staff' }, adminToken);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    createdStaff = result.data.id;
    const record = db.prepare("SELECT after_snapshot FROM audit_logs WHERE entity_type = 'user' AND entity_id = ? AND action = 'create'").get(createdStaff);
    assert.ok(record);
    assert.doesNotMatch(record.after_snapshot, /password|token_version/);
    const invalid = await request('/users/' + createdStaff, 'PATCH', { role: 'bad' }, adminToken);
    assert.equal(invalid.status, 400);
    assert.equal((await request('/users', 'POST', { username: 'badfarm', password, farm_id: 9999 }, adminToken)).status, 400);
    assert.equal(validPassword('ắ'.repeat(30)), false);
  });

  await t.test('Updates and historical audit responses never disclose password hashes', async () => {
    assert.equal((await request('/users/' + createdStaff, 'PATCH', { full_name: 'Updated' }, adminToken)).status, 200);
    const latest = db.prepare("SELECT before_snapshot FROM audit_logs WHERE entity_type = 'user' AND entity_id = ? ORDER BY id DESC").get(createdStaff);
    assert.doesNotMatch(latest.before_snapshot, /password_hash/);
    db.prepare("INSERT INTO audit_logs (entity_type, action, before_snapshot) VALUES ('user', 'update', ?)").run(JSON.stringify({ password_hash: 'legacy-secret', username: 'legacy' }));
    const audit = await request('/audit-logs?limit=12.5', 'GET', undefined, adminToken);
    assert.equal(audit.status, 200);
    assert.doesNotMatch(JSON.stringify(audit.data), /legacy-secret|password_hash/);
  });

  await t.test('Last active administrator cannot be demoted or locked', async () => {
    assert.equal((await request('/users/' + admin, 'PATCH', { role: 'viewer' }, adminToken)).status, 400);
    assert.equal((await request('/users/' + admin, 'PATCH', { status: 'rejected' }, adminToken)).status, 400);
  });

  await t.test('Changes roll back when writing audit history fails', async () => {
    db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
    try {
      const res = await request('/users', 'POST', { username: 'rollbackuser', password, role: 'staff' }, adminToken);
      assert.equal(res.status, 500);
      assert.equal(db.prepare("SELECT id FROM users WHERE username = 'rollbackuser'").get(), undefined);
    } finally { db.exec('DROP TRIGGER fail_audit'); }
  });

  await t.test('Sow dates and counts are validated on both create and update', async () => {
    for (const body of [{ ngay_phoi: '31/02/2026' }, { song: -1 }, { song: 1.5 }, { ghi_chu: {} }, { ma_so_nai: ' ' }]) {
      assert.equal((await request('/sows', 'POST', { farm_id: farm1, ma_so_nai: 'invalid', ...body }, adminToken)).status, 400);
    }
    let res = await request('/sows', 'POST', { farm_id: farm1, ma_so_nai: 'S001', ngay_phoi: '01/01/2026', song: '10' }, adminToken);
    assert.equal(res.status, 201); sow1 = res.data.id;
    res = await request('/sows', 'POST', { farm_id: farm2, ma_so_nai: 'S002' }, adminToken);
    assert.equal(res.status, 201); sow2 = res.data.id;
    assert.equal((await request('/sows/' + sow1, 'GET', undefined, staffToken)).data.ngay_du_kien_de, '25/04/2026');
    assert.equal((await request('/sows/' + sow1, 'PUT', { ngay_de: '29/02/2025' }, staffToken)).status, 400);
    assert.equal((await request('/sows/' + sow1, 'PUT', { song: {} }, staffToken)).status, 400);
    assert.equal((await request('/sows/' + sow1, 'PUT', { ngay_phoi: '02/01/2026' }, staffToken)).status, 200);
    assert.equal((await request('/sows/' + sow1, 'GET', undefined, staffToken)).data.ngay_du_kien_de, '26/04/2026');
  });

  await t.test('Staff cannot read, edit, delete, log or export another farm', async () => {
    for (const [url, method, body] of [
      ['/sows/' + sow2, 'GET'], ['/sows/' + sow2, 'PUT', { ghi_chu: 'no' }],
      ['/sows/' + sow2, 'DELETE'], ['/sows/' + sow2 + '/logs', 'GET'],
      ['/sows/' + sow2 + '/logs', 'POST', { note: 'no' }], ['/care-logs/export?sow_id=' + sow2, 'GET'],
    ]) assert.equal((await request(url, method, body, staffToken)).status, 403);
    const listed = await request('/sows?farm_id=' + farm2, 'GET', undefined, staffToken);
    assert.ok(listed.data.every(s => s.farm_id === farm1));
  });

  await t.test('Excel export works with patched dependency and uses Vietnam time', async () => {
    assert.equal((await request('/sows/' + sow1 + '/logs', 'POST', { status: 'Bình thường', note: 'Ghi nhận' }, staffToken)).status, 201);
    db.prepare("UPDATE sow_care_logs SET created_at = '2026-09-19 00:00:00' WHERE sow_id = ?").run(sow1);
    const result = await request('/care-logs/export?sow_id=' + sow1, 'GET', undefined, staffToken);
    assert.equal(result.status, 200);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(result.data);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell('B2').value, 'Trại 1');
    assert.match(sheet.getCell('G2').value, /07:00:00/);
    // Exercise ExcelJS's uuid v4 integration, used by extended conditional formatting.
    sheet.addConditionalFormatting({ ref: 'A2:A3', rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF00FF00' } }] });
    assert.ok((await workbook.xlsx.writeBuffer()).byteLength > 0);
  });

  await t.test('Archived farms are hidden from viewers and cannot be modified', async () => {
    assert.equal((await request('/farms/' + farm1 + '/archive', 'POST', {}, adminToken)).status, 200);
    assert.ok(!(await request('/sows', 'GET', undefined, viewerToken)).data.some(s => s.farm_id === farm1));
    for (const auth of [adminToken, staffToken]) {
      assert.equal((await request('/sows', 'POST', { farm_id: farm1, ma_so_nai: 'blocked' }, auth)).status, 403);
      assert.equal((await request('/sows/' + sow1, 'PUT', { ghi_chu: 'blocked' }, auth)).status, 403);
      assert.equal((await request('/sows/' + sow1, 'DELETE', undefined, auth)).status, 403);
      assert.equal((await request('/sows/' + sow1 + '/logs', 'POST', { note: 'blocked' }, auth)).status, 403);
    }
    assert.equal((await request('/care-logs/export?sow_id=' + sow1, 'GET', undefined, viewerToken)).status, 403);
    assert.equal((await request('/care-logs/export', 'GET', undefined, staffToken)).status, 403);
    assert.equal((await request('/farms/' + farm1, 'DELETE', undefined, adminToken)).status, 405);
    assert.equal((await request('/farms/' + farm1 + '/restore', 'POST', {}, adminToken)).status, 200);
    assert.ok((await request('/sows', 'GET', undefined, viewerToken)).data.some(s => s.id === sow1));
  });

  await t.test('Deleting a sow preserves care logs inside the deletion snapshot', async () => {
    assert.equal((await request('/sows/' + sow1, 'DELETE', undefined, staffToken)).status, 200);
    const deletion = db.prepare('SELECT snapshot FROM sow_deletions WHERE sow_id = ?').get(sow1);
    assert.equal(JSON.parse(deletion.snapshot).care_logs[0].note, 'Ghi nhận');
  });

  await t.test('Changing role, farm or status revokes previously issued tokens', async () => {
    for (const patch of [{ farm_id: farm2 }, { role: 'viewer' }, { status: 'rejected' }]) {
      const before = token(createdStaff);
      assert.equal((await request('/users/' + createdStaff, 'PATCH', patch, adminToken)).status, 200);
      assert.equal((await request('/sows', 'GET', undefined, before)).status, 401);
    }
  });

  await t.test('Changing password revokes old sessions', async () => {
    assert.equal((await request('/auth/change-password', 'POST', { old_password: password, new_password: 'ChangedPassword123!' }, staffToken)).status, 200);
    assert.equal((await request('/sows', 'GET', undefined, staffToken)).status, 401);
    assert.equal((await request('/auth/login', 'POST', { username: 'teststaff', password: 'ChangedPassword123!' })).status, 200);
  });

  await t.test('Repeated failed login is throttled', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await request('/auth/login', 'POST', { username: 'missinguser', password })).status, 401);
    assert.equal((await request('/auth/login', 'POST', { username: 'missinguser', password })).status, 429);
  });
});

test('Frontend escaping, date validation, timezone and corrupted saved session', () => {
  const storage = new Map([['user', '{broken']]);
  const stub = { addEventListener() {} };
  const context = vm.createContext({
    localStorage: { getItem: k => storage.get(k), removeItem: k => storage.delete(k) },
    document: { getElementById: () => stub }, window: { addEventListener() {} },
    Date, Intl, console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8').replace(/initialize\(\);\s*$/, '');
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('readStoredUser()', context), null);
  assert.equal(vm.runInContext('escapeHtml(\'<img src=x onerror="alert(1)">\')', context), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(vm.runInContext("parseVNDate('31/02/2026')", context), null);
  assert.ok(vm.runInContext("parseVNDate('29/02/2024')", context));
  assert.match(vm.runInContext("formatTimestamp('2026-09-19 00:00:00')", context), /07:00:00/);
  assert.equal(vm.runInContext("buildAlerts([{ ngay_du_kien_de: formatVNDate(todayVN()), ma_so_nai: 'due-today' }])[0].type", context), 'ok');
  assert.equal(vm.runInContext("computeDashboardStats([{ ngay_phoi: '01/01/2026', ngay_de: '25/04/2026' }, { ngay_de: '01/01/2026' }]).tyLeDaDe", context), 100);
});
