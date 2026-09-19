function readStoredUser() {
  try { return JSON.parse(localStorage.getItem('user') || 'null'); }
  catch { localStorage.removeItem('user'); localStorage.removeItem('token'); return null; }
}
function formatTimestamp(value) {
  if (!value) return '';
  const str = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str) ? str.replace(' ', 'T') + 'Z' : str);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}
function todayVN() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return parseVNDate(get('day') + '/' + get('month') + '/' + get('year'));
}
function stopCareTimer() {
  const container = document.getElementById('tabContent');
  if (container?._careTimer) { clearInterval(container._careTimer); container._careTimer = null; }
}
function stopVaccinationTimer() {
  const container = document.getElementById('staffTabContent');
  if (container?._vaccinationTimer) { clearInterval(container._vaccinationTimer); container._vaccinationTimer = null; }
}
const API = '/api';
let state = {
  token: localStorage.getItem('token') || null,
  user: readStoredUser(),
  farms: [],
};

const $app = document.getElementById('app');
const $userBox = document.getElementById('userBox');
const $userInfo = document.getElementById('userInfo');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeText(value) {
  return escapeHtml(value);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && state.token && path !== '/auth/change-password') {
      clearSession();
      document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
      renderApp();
    }
    throw new Error((data && data.error) || 'Có lỗi xảy ra');
  }
  return data;
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

function clearSession() {
  stopCareTimer();
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

const ROLE_LABEL = { admin: 'Quản trị viên', staff: 'Nhân viên chăm sóc', viewer: 'Người xem' };

function renderTopbar() {
  if (!state.user) {
    $userBox.classList.add('hidden');
    return;
  }
  $userBox.classList.remove('hidden');
  $userInfo.textContent = `${state.user.full_name || state.user.username} (${ROLE_LABEL[state.user.role]})`;
}

document.getElementById('btnLogout').addEventListener('click', () => {
  clearSession();
  renderApp();
});

document.getElementById('btnChangePw').addEventListener('click', async () => {
  const old_password = prompt('Mật khẩu hiện tại:');
  if (old_password === null) return;
  const new_password = prompt('Mật khẩu mới (tối thiểu 8 ký tự):');
  if (new_password === null) return;
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ old_password, new_password }) });
    clearSession();
    renderApp();
    alert('Đổi mật khẩu thành công. Vui lòng đăng nhập lại.');
  } catch (e) {
    alert(e.message);
  }
});

// ---------- AUTH VIEW ----------
function renderAuth() {
  const tpl = document.getElementById('tpl-auth');
  $app.innerHTML = '';
  $app.appendChild(tpl.content.cloneNode(true));

  const tabBtns = $app.querySelectorAll('.tab-btn');
  const loginForm = $app.querySelector('#loginForm');
  const registerForm = $app.querySelector('#registerForm');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.tab === 'login') {
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
      } else {
        registerForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
      }
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    const msg = $app.querySelector('#loginMsg');
    msg.textContent = '';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
      });
      saveSession(data.token, data.user);
      renderApp();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(registerForm);
    const msg = $app.querySelector('#registerMsg');
    msg.textContent = '';
    try {
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: fd.get('username'),
          password: fd.get('password'),
          full_name: fd.get('full_name'),
          address: fd.get('address'),
          phone: fd.get('phone'),
        }),
      });
      msg.classList.add('success');
      msg.textContent = 'Đăng ký thành công! Vui lòng chờ quản trị viên duyệt tài khoản.';
      registerForm.reset();
    } catch (err) {
      msg.classList.remove('success');
      msg.textContent = err.message;
    }
  });
}

// ---------- SOW TABLE (dùng chung cho admin/staff/viewer) ----------
const SOW_COLUMNS = [
  { key: 'stt', label: 'STT' },
  { key: 'ma_so_nai', label: 'Mã số nái' },
  { key: 'dong_nai', label: 'Dòng nái' },
  { key: 'lua', label: 'Lứa' },
  { key: 'ngay_phoi', label: 'Ngày phối' },
  { key: 'duc_phoi', label: 'Đực phối' },
  { key: 'log_ky1', label: 'Log kỳ 1' },
  { key: 'log_ky2', label: 'Log kỳ 2' },
  { key: 'log_ky3', label: 'Log kỳ 3' },
  { key: 'ngay_du_kien_de', label: 'Ngày dự kiến đẻ' },
  { key: 'sieu_am', label: 'Siêu âm' },
  { key: 'ngay_de', label: 'Ngày đẻ' },
  { key: 'so_con_so_sinh', label: 'Số con sơ sinh' },
  { key: 'song', label: 'Sống' },
  { key: 'chet', label: 'Chết' },
  { key: 'so_con_cai_sua', label: 'Số con cai sữa' },
  { key: 'ngay_cai_sua', label: 'Ngày cai sữa' },
  { key: 'ngay_phoi_lai', label: 'Ngày phối lại' },
  { key: 'ghi_chu', label: 'Ghi chú' },
];

async function loadFarms() {
  state.farms = await api('/farms');
  return state.farms;
}

function farmOptions(selectedId) {
  return state.farms
    .map((f) => `<option value="${escapeHtml(f.id)}" ${String(f.id) === String(selectedId) ? 'selected' : ''}>${safeText(f.name)}</option>`)
    .join('');
}

const GESTATION_DAYS = 114;

function formatVNDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}

// Ngày dự kiến đẻ = ngày phối + 114 ngày
function computeDueDate(ngayPhoiStr) {
  const d = parseVNDate(ngayPhoiStr);
  if (!d) return '';
  d.setDate(d.getDate() + GESTATION_DAYS);
  return formatVNDate(d);
}

function sowModalHtml(sow = {}) {
  return `
    <div class="form-grid">
      ${SOW_COLUMNS.map(
        (c) => `
        <div>
          <label>${safeText(c.label)}</label>
          <input name="${safeText(c.key)}" value="${escapeHtml(sow[c.key])}" />
        </div>`
      ).join('')}
    </div>`;
}

function openSowModal({ sow, farmId, canEdit, onSaved }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>${sow ? 'Sửa thông tin heo nái' : 'Thêm heo nái mới'}</h3>
      <form id="sowForm">
        ${sowModalHtml(sow || {})}
        <p class="msg" id="sowMsg"></p>
        <div class="modal-actions">
          <button type="button" class="btn-sm" id="btnCancel">Huỷ</button>
          ${canEdit ? '<button type="submit" class="btn-sm primary">Lưu</button>' : ''}
        </div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  if (!canEdit) {
    backdrop.querySelectorAll('input').forEach((i) => (i.disabled = true));
  } else {
    // Tự động tính ngày dự kiến đẻ = ngày phối + 114 ngày, cho đến khi người dùng tự sửa
    const phoiInput = backdrop.querySelector('input[name="ngay_phoi"]');
    const dueInput = backdrop.querySelector('input[name="ngay_du_kien_de"]');
    dueInput.addEventListener('input', () => (dueInput.dataset.manual = '1'));
    phoiInput.addEventListener('change', () => {
      if (dueInput.dataset.manual === '1') return;
      const computed = computeDueDate(phoiInput.value);
      if (computed) dueInput.value = computed;
    });
    if (!sow || !sow.ngay_du_kien_de) {
      const computed = computeDueDate(phoiInput.value);
      if (computed) dueInput.value = computed;
    }
  }

  backdrop.querySelector('#btnCancel').addEventListener('click', () => backdrop.remove());
  backdrop.querySelector('#sowForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {};
    SOW_COLUMNS.forEach((c) => (payload[c.key] = fd.get(c.key) || null));
    payload.farm_id = farmId;
    const msg = backdrop.querySelector('#sowMsg');
    try {
      if (sow && sow.id) {
        await api(`/sows/${sow.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/sows', { method: 'POST', body: JSON.stringify(payload) });
      }
      backdrop.remove();
      onSaved();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

// Nhật ký chăm sóc hàng ngày - ghi nhận theo thời gian thực khi nhân viên đến chăm sóc
async function openCareLogModal(sow, canEdit) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="width:480px">
      <h3>Nhật ký chăm sóc - Mã số nái ${safeText(sow.ma_so_nai)}</h3>
      ${
        canEdit
          ? `<form id="careLogForm">
              <label>Trạng thái</label>
              <select name="status">
                <option value="Bình thường">Bình thường</option>
                <option value="Cần theo dõi">Cần theo dõi</option>
                <option value="Bất thường / cần xử lý">Bất thường / cần xử lý</option>
              </select>
              <label>Ghi chú chăm sóc</label>
              <input name="note" placeholder="VD: đã cho ăn, kiểm tra sức khoẻ..." />
              <p class="msg" id="careLogMsg"></p>
              <div class="modal-actions">
                <button type="submit" class="btn-sm primary">Ghi nhận ngay bây giờ</button>
              </div>
            </form>`
          : ''
      }
      <h4 style="margin-top:16px">Lịch sử ghi nhận</h4>
      <ul class="alert-list" id="careLogList"><li>Đang tải...</li></ul>
      <div class="modal-actions">
        <button type="button" class="btn-sm" id="btnCloseLog">Đóng</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#btnCloseLog').addEventListener('click', () => backdrop.remove());

  async function refreshLogs() {
    const logs = await api(`/sows/${sow.id}/logs`);
    const list = backdrop.querySelector('#careLogList');
    list.innerHTML = logs.length
      ? logs
          .map(
            (l) =>
              `<li>[${safeText(formatTimestamp(l.created_at))}] <strong>${safeText(l.status)}</strong> - ${safeText(l.note)} <em>(${safeText(l.created_by_name || 'N/A')})</em></li>`
          )
          .join('')
      : '<li>Chưa có ghi nhận nào.</li>';
  }

  if (canEdit) {
    backdrop.querySelector('#careLogForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const msg = backdrop.querySelector('#careLogMsg');
      try {
        await api(`/sows/${sow.id}/logs`, {
          method: 'POST',
          body: JSON.stringify({ status: fd.get('status'), note: fd.get('note') }),
        });
        e.target.reset();
        msg.textContent = '';
        refreshLogs();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  refreshLogs();
}

async function renderSowSection(container, { canEdit }) {
  await loadFarms();
  const isAdmin = state.user.role === 'admin';
  if (container._careTimer) clearInterval(container._careTimer);
  container.innerHTML = `
    <div class="dash-card" id="overdueAlertCard"></div>
    <div class="card">
      <div class="toolbar">
        <div>
          ${isAdmin ? `<label>Chọn trại: <select id="farmSelect">${farmOptions()}</select></label>` : `<strong>Trại: ${safeText(state.farms.find((f) => f.id === state.user.farm_id)?.name || 'Chưa gán trại')}</strong>`}
        </div>
        ${canEdit ? '<button class="btn-sm primary" id="btnAddSow">+ Thêm heo nái</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${SOW_COLUMNS.map((c) => `<th>${c.label}</th>`).join('')}<th>Hành động</th></tr></thead>
          <tbody id="sowTbody"><tr><td colspan="20">Đang tải...</td></tr></tbody>
        </table>
      </div>
    </div>`;
  container.insertAdjacentHTML(
    'beforeend',
    `<div class="care-panel">
      <div class="care-panel-header">
        <h3>Nhật ký chăm sóc</h3>
        <span class="live-indicator"><span></span> Thời gian thực</span>
      </div>
      <div class="care-form-grid">
        <label>Mã số nái<select id="careSowSelect"><option value="">Chọn heo nái</option></select></label>
        <label>Trạng thái<select id="careStatus">
          <option value="Bình thường">Bình thường</option>
          <option value="Cần theo dõi">Cần theo dõi</option>
          <option value="Bất thường / cần xử lý">Bất thường / cần xử lý</option>
        </select></label>
        <label class="care-note-field">Ghi chú chăm sóc<input id="careNote" placeholder="VD: đã cho ăn, kiểm tra sức khoẻ..." /></label>
        <button class="btn-sm primary care-submit" id="btnCareSubmit" ${canEdit ? '' : 'disabled'}>Ghi nhận</button>
      </div>
      <div class="care-history-header"><strong>Lịch sử ghi nhận</strong><span id="careLastUpdate">Chưa chọn heo nái</span></div>
      <button class="btn-sm export-btn" id="btnExportLogs">Xuất nhật ký ra Excel</button>
      <ul class="alert-list care-history" id="careHistory"><li>Chọn một heo nái để xem lịch sử chăm sóc.</li></ul>
    </div>`
  );

  async function currentFarmId() {
    if (isAdmin) {
      const sel = container.querySelector('#farmSelect');
      return sel ? sel.value : null;
    }
    return state.user.farm_id;
  }

  async function downloadCareLogs() {
    const params = new URLSearchParams();
    const farmId = await currentFarmId();
    const sowId = container.querySelector('#careSowSelect').value;
    if (farmId) params.set('farm_id', farmId);
    if (sowId) params.set('sow_id', sowId);
    const response = await fetch(`/api/care-logs/export?${params.toString()}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      let message = 'Không thể xuất nhật ký chăm sóc';
      try {
        const data = await response.json();
        message = data.error || message;
      } catch (error) {
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nhat-ky-cham-soc-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function renderOverdueAlert(sows) {
    const today = todayVN();
    const overdue = sows.filter((s) => s.ngay_du_kien_de && !s.ngay_de && parseVNDate(s.ngay_du_kien_de) && parseVNDate(s.ngay_du_kien_de) < today);
    const total = sows.length || 1;
    const pctOverdue = Math.round((overdue.length / total) * 100);
    const card = container.querySelector('#overdueAlertCard');
    card.innerHTML = `
      <h3>Cảnh báo quá ngày dự kiến đẻ</h3>
      <div class="overdue-bar-wrap">
        <div class="overdue-bar"><div class="overdue-bar-fill" style="width:${pctOverdue}%"></div></div>
        <span>${overdue.length}/${sows.length} nái quá ngày đẻ (${pctOverdue}%)</span>
      </div>
      ${
        overdue.length
          ? `<ul class="alert-list">${overdue
              .map((s) => `<li class="alert-danger">Mã số nái ${safeText(s.ma_so_nai)} đã quá ngày dự kiến đẻ (${safeText(s.ngay_du_kien_de)})</li>`)
              .join('')}</ul>`
          : '<p class="hint">Không có heo nái nào quá ngày dự kiến đẻ.</p>'
      }`;
  }

  async function loadSows() {
    const farmId = await currentFarmId();
    const tbody = container.querySelector('#sowTbody');
    if (!farmId) {
      tbody.innerHTML = `<tr><td colspan="20">Chưa có trại nào để hiển thị.</td></tr>`;
      container.querySelector('#overdueAlertCard').innerHTML = '';
      return;
    }
    const sows = await api(`/sows?farm_id=${farmId}`);
    if (!container.isConnected || !container.querySelector('#careSowSelect')) return;
    renderOverdueAlert(sows);
    const careSelect = container.querySelector('#careSowSelect');
    const selectedCareId = careSelect.value;
    careSelect.innerHTML = '<option value="">Chọn heo nái</option>' + sows.map((s) => `<option value="${escapeHtml(s.id)}">${safeText(s.ma_so_nai)} - ${safeText(s.dong_nai || 'Chưa rõ dòng')}</option>`).join('');
    if (selectedCareId && sows.some((s) => String(s.id) === selectedCareId)) careSelect.value = selectedCareId;
    if (sows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="20">Chưa có dữ liệu heo nái.</td></tr>`;
      return;
    }
    tbody.innerHTML = sows
      .map(
        (s) => `
      <tr>
        ${SOW_COLUMNS.map((c) => `<td>${safeText(s[c.key])}</td>`).join('')}
        <td>
          ${canEdit ? `<button class="btn-sm" data-edit="${s.id}">Sửa</button>` : ''}
          <button class="btn-sm" data-log="${s.id}">Nhật ký</button>
          ${canEdit ? `<button class="btn-sm danger" data-del="${s.id}">Xoá</button>` : ''}
        </td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('[data-log]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const sow = sows.find((s) => s.id === Number(btn.dataset.log));
        const careSelect = container.querySelector('#careSowSelect');
        careSelect.value = String(sow.id);
        refreshCareHistory();
        container.querySelector('.care-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
    );

    if (canEdit) {
      tbody.querySelectorAll('[data-edit]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const sow = sows.find((s) => s.id === Number(btn.dataset.edit));
          openSowModal({ sow, farmId, canEdit: true, onSaved: loadSows });
        })
      );
      tbody.querySelectorAll('[data-del]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (!confirm('Xác nhận xoá dữ liệu heo nái này? Dữ liệu sẽ được lưu vết lại cho quản trị viên.')) return;
          await api(`/sows/${btn.dataset.del}`, { method: 'DELETE' });
          loadSows();
        })
      );
    }
  }

  async function refreshCareHistory() {
    const sowId = container.querySelector('#careSowSelect').value;
    const history = container.querySelector('#careHistory');
    if (!sowId) {
      history.innerHTML = '<li>Chọn một heo nái để xem lịch sử chăm sóc.</li>';
      container.querySelector('#careLastUpdate').textContent = 'Chưa chọn heo nái';
      return;
    }
    const logs = await api(`/sows/${sowId}/logs`);
    if (!history.isConnected) return;
    history.innerHTML = logs.length
      ? logs.map((l) => `<li><strong>${safeText(l.status)}</strong> - ${safeText(l.note)}<br><small>${safeText(formatTimestamp(l.created_at))} · ${safeText(l.created_by_name || 'N/A')}</small></li>`).join('')
      : '<li>Chưa có ghi nhận nào.</li>';
    container.querySelector('#careLastUpdate').textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;
  }

  container.querySelector('#careSowSelect').addEventListener('change', refreshCareHistory);
  container.querySelector('#btnCareSubmit').addEventListener('click', async () => {
    const sowId = container.querySelector('#careSowSelect').value;
    if (!sowId) return alert('Vui lòng chọn mã số nái');
    if (!canEdit) return;
    await api(`/sows/${sowId}/logs`, {
      method: 'POST',
      body: JSON.stringify({
        status: container.querySelector('#careStatus').value,
        note: container.querySelector('#careNote').value,
      }),
    });
    container.querySelector('#careNote').value = '';
    await refreshCareHistory();
  });
  container.querySelector('#btnExportLogs').addEventListener('click', async () => {
    try {
      await downloadCareLogs();
    } catch (error) {
      alert(error.message);
    }
  });

  container._careTimer = setInterval(async () => {
    await loadSows();
    await refreshCareHistory();
  }, 15000);

  if (isAdmin) {
    container.querySelector('#farmSelect').addEventListener('change', loadSows);
  }
  if (canEdit) {
    container.querySelector('#btnAddSow').addEventListener('click', async () => {
      const farmId = await currentFarmId();
      if (!farmId) return alert('Vui lòng chọn trại trước');
      openSowModal({ farmId, canEdit: true, onSaved: loadSows });
    });
  }

  loadSows();
}

// ---------- ADMIN VIEW ----------
async function renderAdminUsersTab(container) {
  await loadFarms();
  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <h3 style="margin:0">Nhân viên chăm sóc</h3>
        <button class="btn-sm primary" id="btnAddStaff">+ Tạo tài khoản nhân viên</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Họ tên</th><th>Tên đăng nhập</th><th>Trại</th><th>Trạng thái</th><th>Hành động</th></tr></thead>
        <tbody id="staffTbody"><tr><td colspan="5">Đang tải...</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h3>Người xem (cần duyệt trước khi xem số liệu)</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Họ tên</th><th>Tên đăng nhập</th><th>Địa chỉ</th><th>Số điện thoại</th><th>Hành động</th></tr></thead>
        <tbody id="viewerTbody"><tr><td colspan="5">Đang tải...</td></tr></tbody>
      </table></div>
    </div>`;

  function farmName(id) {
    return state.farms.find((f) => f.id === id)?.name || '-';
  }

  async function refresh() {
    const all = await api('/users');
    const staff = all.filter((u) => u.role === 'staff' || u.role === 'admin');
    const viewers = all.filter((u) => u.role === 'viewer');

    container.querySelector('#staffTbody').innerHTML = staff
      .map(
        (u) => `
      <tr>
        <td>${safeText(u.full_name)}</td><td>${safeText(u.username)}</td>
        <td>${safeText(u.role === 'admin' ? 'Toàn bộ' : farmName(u.farm_id))}</td>
        <td><span class="badge approved">${u.role === 'admin' ? 'Quản trị' : 'Đã duyệt'}</span></td>
        <td>${u.role === 'admin' ? '-' : `<button class="btn-sm danger" data-del="${u.id}">Xoá</button>`}</td>
      </tr>`
      )
      .join('');

    container.querySelector('#viewerTbody').innerHTML =
      viewers.length === 0
        ? '<tr><td colspan="5">Chưa có người xem nào đăng ký.</td></tr>'
        : viewers
            .map(
              (u) => `
        <tr>
          <td>${safeText(u.full_name)}</td><td>${safeText(u.username)}</td>
          <td>${safeText(u.address)}</td><td>${safeText(u.phone)}</td>
          <td><span class="badge ${safeText(u.status)}">${({ pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Đã khóa' })[u.status] || '-'}</span>
            ${u.status !== 'approved' ? `<button class="btn-sm primary" data-approve="${u.id}">Duyệt</button>` : `<button class="btn-sm" data-reject="${u.id}">Khóa</button>`}
            <button class="btn-sm danger" data-del="${u.id}">Xoá</button></td>
        </tr>`
            )
            .join('');

    for (const [attribute, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
      container.querySelectorAll('[data-' + attribute + ']').forEach(button => button.addEventListener('click', async () => {
        await api('/users/' + button.dataset[attribute], { method: 'PATCH', body: JSON.stringify({ status }) });
        await refresh();
      }));
    }
    container.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Xác nhận xoá tài khoản này?')) return;
        await api(`/users/${btn.dataset.del}`, { method: 'DELETE' });
        refresh();
      })
    );
  }

  container.querySelector('#btnAddStaff').addEventListener('click', () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" style="width:420px">
        <h3>Tạo tài khoản nhân viên chăm sóc</h3>
        <form id="staffForm">
          <label>Họ và tên</label><input name="full_name" required />
          <label>Tên đăng nhập</label><input name="username" required />
          <label>Mật khẩu</label><input name="password" type="password" required minlength="8" />
          <label>Trại phụ trách</label>
          <select name="farm_id">${farmOptions()}</select>
          <p class="msg" id="staffMsg"></p>
          <div class="modal-actions">
            <button type="button" class="btn-sm" id="btnCancelStaff">Huỷ</button>
            <button type="submit" class="btn-sm primary">Tạo</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector('#btnCancelStaff').addEventListener('click', () => backdrop.remove());
    backdrop.querySelector('#staffForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/users', {
          method: 'POST',
          body: JSON.stringify({
            full_name: fd.get('full_name'),
            username: fd.get('username'),
            password: fd.get('password'),
            farm_id: fd.get('farm_id'),
            role: 'staff',
          }),
        });
        backdrop.remove();
        refresh();
      } catch (err) {
        backdrop.querySelector('#staffMsg').textContent = err.message;
      }
    });
  });

  refresh();
}

async function renderAdminFarmsTab(container) {
  state.farms = await api('/farms?include_archived=1');
  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <h3 style="margin:0">Danh sách trại heo</h3>
        <button class="btn-sm primary" id="btnAddFarm">+ Thêm trại</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Tên trại</th><th>Địa chỉ</th><th>Trạng thái</th><th>Hành động</th></tr></thead>
        <tbody id="farmTbody"></tbody>
      </table></div>
    </div>`;

  async function refresh() {
    state.farms = await api('/farms?include_archived=1');
    container.querySelector('#farmTbody').innerHTML = state.farms
      .map(
        (f) => `
      <tr>
        <td>${safeText(f.name)}</td><td>${safeText(f.address)}</td>
        <td><span class="badge ${f.status === 'archived' ? 'rejected' : 'approved'}">${f.status === 'archived' ? 'Đã lưu trữ' : 'Đang hoạt động'}</span></td>
        <td>${f.status === 'archived'
          ? `<button class="btn-sm primary" data-restore="${f.id}">Khôi phục</button>`
          : `<button class="btn-sm danger" data-archive="${f.id}">Ngừng sử dụng</button>`}</td>
      </tr>`
      )
      .join('');
    container.querySelectorAll('[data-archive]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Ngừng sử dụng trại này? Dữ liệu sẽ được giữ nguyên và có thể khôi phục.')) return;
        await api(`/farms/${btn.dataset.archive}/archive`, { method: 'POST' });
        refresh();
      })
    );
    container.querySelectorAll('[data-restore]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await api(`/farms/${btn.dataset.restore}/restore`, { method: 'POST' });
        refresh();
      })
    );
  }

  container.querySelector('#btnAddFarm').addEventListener('click', async () => {
    const name = prompt('Tên trại mới:');
    if (!name) return;
    const address = prompt('Địa chỉ (có thể để trống):') || '';
    await api('/farms', { method: 'POST', body: JSON.stringify({ name, address }) });
    refresh();
  });

  refresh();
}

function renderAdminDashboard() {
  $app.innerHTML = `
    <nav class="tabs-main">
      <button class="active" data-tab="sows">Số liệu heo nái</button>
      <button data-tab="farms">Trại heo</button>
      <button data-tab="users">Tài khoản</button>
      <button data-tab="deletions">Lịch sử xoá</button>
      <button data-tab="audit">Lịch sử thay đổi</button>
    </nav>
    <div id="tabContent"></div>`;
  const content = $app.querySelector('#tabContent');
  const buttons = $app.querySelectorAll('.tabs-main button');

  function show(tab) {
    stopCareTimer();
    stopVaccinationTimer();
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'sows') renderSowSection(content, { canEdit: true });
    if (tab === 'farms') renderAdminFarmsTab(content);
    if (tab === 'users') renderAdminUsersTab(content);
    if (tab === 'deletions') renderAdminDeletionsTab(content);
    if (tab === 'audit') renderAdminAuditTab(content);
  }
  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  show('sows');
}

async function renderAdminAuditTab(container) {
  container.innerHTML = `
    <div class="card">
      <h3>Lịch sử thay đổi</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Ngày giờ</th><th>Đối tượng</th><th>Hành động</th><th>Người thực hiện</th><th>Chi tiết</th></tr></thead>
        <tbody id="auditTbody"><tr><td colspan="5">Đang tải...</td></tr></tbody>
      </table></div>
    </div>`;
  const rows = await api('/audit-logs?limit=500');
  const entityLabels = { farm: 'Trại', user: 'Tài khoản', sow: 'Heo nái' };
  const actionLabels = { create: 'Tạo', update: 'Cập nhật', archive: 'Lưu trữ', restore: 'Khôi phục', delete: 'Xoá' };
  container.querySelector('#auditTbody').innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${safeText(formatTimestamp(row.created_at))}</td>
        <td>${safeText(entityLabels[row.entity_type] || row.entity_type)} #${safeText(row.entity_id)}</td>
        <td>${safeText(actionLabels[row.action] || row.action)}</td>
        <td>${safeText(row.actor_name)}</td>
        <td><button class="btn-sm" data-audit-detail="${row.id}">Xem chi tiết</button></td>
      </tr>`).join('')
    : '<tr><td colspan="5">Chưa có lịch sử thay đổi.</td></tr>';
  container.querySelectorAll('[data-audit-detail]').forEach((button) => {
    button.addEventListener('click', () => {
      const row = rows.find((item) => item.id === Number(button.dataset.auditDetail));
      alert(`Trước:\n${row.before_snapshot || '(trống)'}\n\nSau:\n${row.after_snapshot || '(trống)'}`);
    });
  });
}

async function renderAdminDeletionsTab(container) {
  container.innerHTML = `
    <div class="card">
      <h3>Lịch sử heo nái đã bị xoá</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Ngày giờ xoá</th><th>Người xoá</th><th>Trại</th><th>Mã số nái</th></tr></thead>
        <tbody id="delTbody"><tr><td colspan="4">Đang tải...</td></tr></tbody>
      </table></div>
    </div>`;
  const rows = await api('/sow-deletions');
  container.querySelector('#delTbody').innerHTML = rows.length
    ? rows
        .map(
          (r) => `
      <tr>
        <td>${safeText(formatTimestamp(r.deleted_at))}</td>
        <td>${safeText(r.deleted_by_name)}</td>
        <td>${safeText(r.farm_name)}</td>
        <td>${safeText(r.ma_so_nai)}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="4">Chưa có heo nái nào bị xoá.</td></tr>';
}

function renderStaffDashboard() {
  $app.innerHTML = `
    <nav class="tabs-main staff-tabs">
      <button class="active" data-staff-tab="sows">Số liệu heo nái</button>
      <button data-staff-tab="vaccinations">Theo dõi tiêm chủng</button>
    </nav>
    <div id="staffTabContent"></div>`;
  const content = $app.querySelector('#staffTabContent');
  const buttons = $app.querySelectorAll('[data-staff-tab]');
  function show(tab) {
    stopCareTimer();
    buttons.forEach((button) => button.classList.toggle('active', button.dataset.staffTab === tab));
    if (tab === 'sows') renderSowSection(content, { canEdit: true });
    if (tab === 'vaccinations') renderVaccinationDashboard(content);
  }
  buttons.forEach((button) => button.addEventListener('click', () => show(button.dataset.staffTab)));
  show('sows');
}

function vaccinationDateLabel(value) {
  if (!value) return '';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function vaccinationStatus(event) {
  if (event.administered_at) return { label: 'Đã tiêm', className: 'approved' };
  const today = todayVN();
  const scheduled = new Date(`${event.scheduled_date}T00:00:00Z`);
  const current = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (scheduled < current) return { label: 'Quá hạn', className: 'rejected' };
  if (scheduled.getTime() === current.getTime()) return { label: 'Đến lịch hôm nay', className: 'pending' };
  return { label: 'Sắp đến', className: 'approved' };
}

async function renderVaccinationDashboard(container) {
  if (container._vaccinationTimer) clearInterval(container._vaccinationTimer);
  const farmId = state.user.farm_id;
  if (!farmId) {
    container.innerHTML = '<div class="card">Tài khoản chưa được gán trại.</div>';
    return;
  }
  container.innerHTML = `
    <div class="vaccination-header">
      <div><h2>Theo dõi tiêm chủng</h2><p class="hint">Heo hậu bị 90-170 kg và lịch vaccine nái chửa theo ngày phối.</p></div>
      <span class="live-indicator"><span></span> Cập nhật thời gian thực</span>
    </div>
    <div class="stats-grid vaccination-stats">
      <div class="stat-card"><div class="stat-label">Hồ sơ đang theo dõi</div><div class="stat-value" id="vaccAnimalCount">0</div></div>
      <div class="stat-card"><div class="stat-label">Mũi đến lịch hôm nay</div><div class="stat-value" id="vaccTodayCount">0</div></div>
      <div class="stat-card"><div class="stat-label">Mũi quá hạn</div><div class="stat-value danger-value" id="vaccOverdueCount">0</div></div>
    </div>
    <div class="card vaccination-entry-card">
      <div class="toolbar"><h3 style="margin:0">Nhập heo hậu bị mới</h3><span class="hint">Ngày nhập là mốc ngày 0</span></div>
      <form id="vaccAnimalForm" class="vacc-form-grid">
        <label>Mã số nái<input name="ma_so_nai" required maxlength="40" placeholder="VD: H001" /></label>
        <label>Dòng nái<input name="dong_nai" maxlength="80" /></label>
        <label>Trọng lượng (kg)<input name="weight_kg" type="number" min="90" max="170" step="0.1" required /></label>
        <label>Nguồn nhập<input name="source" maxlength="200" placeholder="Trại/đơn vị cung cấp" /></label>
        <label>Ngày nhập<input name="arrival_date" type="date" required /></label>
        <button class="btn-sm primary" type="submit">Tạo hồ sơ &amp; lịch heo hậu bị</button>
        <p class="msg" id="vaccFormMsg"></p>
      </form>
    </div>
    <div class="card">
      <div class="toolbar"><h3 style="margin:0">Lịch tiêm và cảnh báo</h3><span id="vaccLastRefresh" class="hint"></span></div>
      <div class="table-wrap"><table class="vaccination-table">
        <thead><tr><th>Mã số nái</th><th>Dòng</th><th>Kg</th><th>Ngày nhập</th><th>Ngày phối</th><th>Giai đoạn</th><th>Mũi tiêm</th><th>Ngày dự kiến</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody id="vaccinationTbody"><tr><td colspan="10">Đang tải...</td></tr></tbody>
      </table></div>
    </div>`;

  async function loadVaccinations() {
    const animals = await api(`/vaccinations/animals?farm_id=${farmId}`);
    const events = animals.flatMap((animal) => animal.vaccination_events.map((event) => ({ ...event, animal })));
    const overdue = events.filter((event) => vaccinationStatus(event).label === 'Quá hạn').length;
    const todayCount = events.filter((event) => vaccinationStatus(event).label === 'Đến lịch hôm nay').length;
    container.querySelector('#vaccAnimalCount').textContent = animals.length;
    container.querySelector('#vaccTodayCount').textContent = todayCount;
    container.querySelector('#vaccOverdueCount').textContent = overdue;
    container.querySelector('#vaccLastRefresh').textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;
    const tbody = container.querySelector('#vaccinationTbody');
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="10">Chưa có hồ sơ hoặc lịch tiêm.</td></tr>';
      return;
    }
    tbody.innerHTML = events.map((event) => {
      const status = vaccinationStatus(event);
      const phase = event.phase === 'heifer' ? 'Hậu bị' : 'Nái chửa';
      return `<tr class="vacc-row-${status.className}">
        <td>${safeText(event.animal.ma_so_nai)}</td><td>${safeText(event.animal.dong_nai)}</td><td>${safeText(event.animal.weight_kg)}</td>
        <td>${safeText(vaccinationDateLabel(event.animal.arrival_date))}</td><td>${safeText(vaccinationDateLabel(event.animal.breeding_date))}</td>
        <td>${phase}</td><td>${safeText(event.vaccine_name)} <small>(+${event.day_offset} ngày)</small></td>
        <td>${safeText(vaccinationDateLabel(event.scheduled_date))}</td>
        <td><span class="badge ${status.className}">${status.label}</span>${event.administered_at ? `<small class="vacc-administered">${safeText(formatTimestamp(event.administered_at))}</small>` : ''}</td>
        <td>
          ${event.administered_at ? `<span class="hint">${safeText(event.administered_by_name || '')}</span>` : `<button class="btn-sm primary" data-administer-vacc="${event.id}">Đã tiêm</button>`}
          ${event.phase === 'heifer' && event.animal.breeding_date ? '' : event.phase === 'heifer' ? `<button class="btn-sm" data-breeding-animal="${event.animal.id}">Nhập ngày phối</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-administer-vacc]').forEach((button) => button.addEventListener('click', async () => {
      const note = prompt('Ghi chú mũi tiêm (có thể để trống):') || '';
      await api(`/vaccinations/events/${button.dataset.administerVacc}/administer`, { method: 'POST', body: JSON.stringify({ note }) });
      await loadVaccinations();
    }));
    tbody.querySelectorAll('[data-breeding-animal]').forEach((button) => button.addEventListener('click', async () => {
      const date = prompt('Nhập ngày phối của nái chửa theo dạng yyyy-mm-dd:');
      if (!date) return;
      await api(`/vaccinations/animals/${button.dataset.breedingAnimal}`, { method: 'PATCH', body: JSON.stringify({ breeding_date: date }) });
      await loadVaccinations();
    }));
  }

  container.querySelector('#vaccAnimalForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const message = container.querySelector('#vaccFormMsg');
    try {
      await api('/vaccinations/animals', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
      event.target.reset();
      message.textContent = 'Đã tạo hồ sơ và lịch vaccine heo hậu bị.';
      message.classList.add('success');
      await loadVaccinations();
    } catch (error) {
      message.textContent = error.message;
      message.classList.remove('success');
    }
  });
  container._vaccinationTimer = setInterval(loadVaccinations, 15000);
  loadVaccinations();
}

// ---------- VIEWER DASHBOARD (chỉ xem trại & đàn heo) ----------
const STATUS_META = {
  mang_thai: { label: 'Mang thai', color: '#1f3a63' },
  cho_bu: { label: 'Đang cho con bú', color: '#2e9e4c' },
  cho_phoi: { label: 'Chờ phối', color: '#e8622c' },
  loai_thai: { label: 'Loại thải', color: '#8a8a8a' },
};

function computeSowStatus(sow) {
  if (sow.ngay_de && !sow.ngay_cai_sua) return 'cho_bu';
  if (sow.ngay_de && sow.ngay_cai_sua && !sow.ngay_phoi_lai) return 'cho_phoi';
  if (sow.ngay_phoi && !sow.ngay_de) return 'mang_thai';
  return 'cho_phoi';
}

function computeDashboardStats(sows) {
  const total = sows.length;
  const statusCounts = { mang_thai: 0, cho_bu: 0, cho_phoi: 0, loai_thai: 0 };
  sows.forEach((s) => statusCounts[computeSowStatus(s)]++);

  const daPhoi = sows.filter((s) => s.ngay_phoi).length;
  const daDe = sows.filter((s) => s.ngay_phoi && s.ngay_de).length;
  const tyLeDaDe = daPhoi > 0 ? Math.round((daDe / daPhoi) * 100) : 0;

  const litters = sows.map((s) => Number(s.so_con_so_sinh)).filter((n) => !isNaN(n) && n > 0);
  const avgLitter = litters.length ? (litters.reduce((a, b) => a + b, 0) / litters.length).toFixed(1) : '0';

  return {
    total,
    mangThai: statusCounts.mang_thai,
    choPhoi: statusCounts.cho_phoi,
    tyLeDaDe,
    avgLitter,
    statusCounts,
  };
}

function renderDonutChart(statusCounts) {
  const entries = Object.entries(statusCounts).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  let acc = 0;
  const stops = entries.length
    ? entries
        .map(([key, v]) => {
          const from = (acc / (total || 1)) * 360;
          acc += v;
          const to = (acc / (total || 1)) * 360;
          return `${STATUS_META[key].color} ${from}deg ${to}deg`;
        })
        .join(', ')
    : '#e2e8e2 0deg 360deg';

  const legend = entries.length
    ? entries
        .map(
          ([key, v]) =>
            `<div class="legend-item"><span class="dot" style="background:${STATUS_META[key].color}"></span>${STATUS_META[key].label} (${v})</div>`
        )
        .join('')
    : '<div class="legend-item">Chưa có dữ liệu</div>';

  return `
    <div class="donut-wrap">
      <div class="donut" style="background: conic-gradient(${stops})">
        <div class="donut-hole">${total}<span>tổng</span></div>
      </div>
      <div class="legend">${legend}</div>
    </div>`;
}

function renderQuarterChart(sows) {
  const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  sows.forEach((s) => {
    if (!s.ngay_de || !s.so_con_so_sinh) return;
    const date = parseVNDate(s.ngay_de);
    if (!date || date.getFullYear() !== todayVN().getFullYear()) return;
    const month = date.getMonth() + 1;
    const q = Math.min(3, Math.floor((month - 1) / 3));
    sums[q] += Number(s.so_con_so_sinh) || 0;
    counts[q]++;
  });
  const avgs = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const hasData = counts.some((c) => c > 0);
  if (!hasData) return '<p class="hint">Chưa đủ dữ liệu để hiển thị biểu đồ theo quý.</p>';

  const max = Math.max(...avgs, 1);
  const w = 260;
  const h = 90;
  const stepX = w / (quarters.length - 1);
  const points = avgs.map((v, i) => `${i * stepX},${h - (v / max) * (h - 10) - 5}`).join(' ');

  return `
    <svg viewBox="0 0 ${w} ${h}" class="quarter-chart">
      <polyline points="${points}" fill="none" stroke="#2e9e4c" stroke-width="2.5" />
      ${avgs
        .map((v, i) => `<circle cx="${i * stepX}" cy="${h - (v / max) * (h - 10) - 5}" r="3.5" fill="#e8622c" />`)
        .join('')}
    </svg>
    <div class="quarter-labels">${quarters.map((q) => `<span>${q}</span>`).join('')}</div>`;
}

function buildAlerts(sows) {
  const alerts = [];
  const today = todayVN();
  sows.forEach((s) => {
    if (s.ngay_du_kien_de && !s.ngay_de) {
      const d = parseVNDate(s.ngay_du_kien_de);
      if (d && d < today) {
        alerts.push({ type: 'danger', text: `Cảnh báo heo nái quá ngày đẻ: ${safeText(s.ma_so_nai)}` });
      }
    }
  });
  if (alerts.length === 0) {
    alerts.push({ type: 'ok', text: 'Không có cảnh báo nào.' });
  }
  return alerts;
}

function parseVNDate(str) {
  if (typeof str !== 'string' || !/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(str)) return null;
  const [d, m, y] = str.split(/[/-]/).map(Number);
  const date = new Date(y, m - 1, d);
  return y >= 1900 && y <= 9999 && date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

async function renderViewerDashboard() {
  $app.innerHTML = `<div class="dash-card">Đang tải dữ liệu...</div>`;
  await loadFarms();

  async function loadAndRender(farmId) {
    const sows = await api(farmId ? `/sows?farm_id=${farmId}` : '/sows');
    const stats = computeDashboardStats(sows);
    const alerts = buildAlerts(sows);
    const farm = state.farms.find((f) => f.id === Number(farmId));

    $app.innerHTML = `
      <div class="dashboard-header">
        <h2>Quản lý Heo nái ${farm ? `- ${safeText(farm.name)}` : '- Tất cả các trại'}</h2>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <select id="farmFilter">
            <option value="">Tất cả các trại</option>
            ${farmOptions(farmId)}
          </select>
          <input type="text" id="sowSearch" class="search-input" placeholder="🔍 Tìm theo mã số nái..." />
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Tổng số Heo nái</div><div class="stat-value">${stats.total}</div></div>
        <div class="stat-card"><div class="stat-label">Số nái đang Mang thai</div><div class="stat-value">${stats.mangThai}</div></div>
        <div class="stat-card"><div class="stat-label">Số nái chờ Phối</div><div class="stat-value">${stats.choPhoi}</div></div>
        <div class="stat-card"><div class="stat-label">Tỷ lệ đã đẻ trong số đã phối</div><div class="stat-value">${stats.tyLeDaDe}%</div></div>
        <div class="stat-card"><div class="stat-label">Số con/ổ Trung bình</div><div class="stat-value">${stats.avgLitter}</div></div>
      </div>

      <div class="dashboard-grid">
        <div class="dash-card">
          <h3>Danh sách Heo nái Chi tiết</h3>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>Mã Số Nái</th><th>Dòng nái</th><th>Trạng thái</th><th>Lứa đẻ</th>
                <th>Ngày phối gần nhất</th><th>Ngày dự kiến đẻ</th><th>Ghi chú</th><th></th>
              </tr></thead>
              <tbody id="sowTbody"></tbody>
            </table>
          </div>
        </div>

        <div class="dash-side">
          <div class="dash-card">
            <h3>Phân bổ Trạng thái Heo nái</h3>
            ${renderDonutChart(stats.statusCounts)}
          </div>
          <div class="dash-card">
            <h3>Số con/ổ theo quý năm ${todayVN().getFullYear()}</h3>
            ${renderQuarterChart(sows)}
          </div>
          <div class="dash-card">
            <h3>Thông báo &amp; Cảnh báo</h3>
            <ul class="alert-list">
              ${alerts.map((a) => `<li class="alert-${a.type}">${a.text}</li>`).join('')}
            </ul>
          </div>
        </div>
      </div>`;

    function renderRows(filter) {
      const tbody = $app.querySelector('#sowTbody');
      const filtered = filter
        ? sows.filter((s) => String(s.ma_so_nai).toLowerCase().includes(filter.toLowerCase()))
        : sows;
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8">Không tìm thấy heo nái phù hợp.</td></tr>';
        return;
      }
      tbody.innerHTML = filtered
        .map((s) => {
          const status = STATUS_META[computeSowStatus(s)];
          return `
          <tr>
            <td>${safeText(s.ma_so_nai)}</td>
            <td>${safeText(s.dong_nai)}</td>
            <td><span class="status-pill" style="background:${status.color}22;color:${status.color}">${status.label}</span></td>
            <td>${safeText(s.lua)}</td>
            <td>${safeText(s.ngay_phoi_lai || s.ngay_phoi)}</td>
            <td>${safeText(s.ngay_du_kien_de)}</td>
            <td>${safeText(s.ghi_chu)}</td>
            <td>
              <button class="btn-sm" data-view="${s.id}">Xem chi tiết</button>
              <button class="btn-sm" data-log="${s.id}">Nhật ký</button>
            </td>
          </tr>`;
        })
        .join('');
      tbody.querySelectorAll('[data-view]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const sow = sows.find((s) => s.id === Number(btn.dataset.view));
          openSowModal({ sow, farmId: sow.farm_id, canEdit: false, onSaved: () => {} });
        })
      );
      tbody.querySelectorAll('[data-log]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const sow = sows.find((s) => s.id === Number(btn.dataset.log));
          openCareLogModal(sow, false);
        })
      );
    }

    renderRows('');
    $app.querySelector('#sowSearch').addEventListener('input', (e) => renderRows(e.target.value));
    $app.querySelector('#farmFilter').addEventListener('change', (e) => loadAndRender(e.target.value));
  }

  loadAndRender('');
}

// ---------- MAIN ----------
function renderApp() {
  stopCareTimer();
  renderTopbar();
  if (!state.user) {
    renderAuth();
    return;
  }
  if (state.user.role === 'admin') return renderAdminDashboard();
  if (state.user.role === 'staff') return renderStaffDashboard();
  return renderViewerDashboard();
}

window.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  alert(event.reason?.message || 'Không thể hoàn tất thao tác. Vui lòng thử lại.');
});
async function initialize() {
  if (state.token) {
    try { const user = await api('/auth/me'); saveSession(state.token, user); }
    catch { clearSession(); }
  }
  renderApp();
}
initialize();
