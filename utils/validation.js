function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function positiveId(value, label = 'Mã định danh') {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value)) ||
      !Number.isSafeInteger(Number(value)) || Number(value) <= 0) invalid(`${label} không hợp lệ`);
  return Number(value);
}

function validPassword(value, min = 8) {
  return typeof value === 'string' && value.length >= min && Buffer.byteLength(value, 'utf8') <= 72;
}

function optionalText(value, max, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max) invalid(`${label} không hợp lệ`);
  return value.trim() || null;
}

function parseVNDate(value) {
  if (typeof value !== 'string' || !/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(value)) return null;
  const [d, m, y] = value.split(/[/-]/).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 9999 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

function formatVNDate(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

const DATE_FIELDS = ['ngay_phoi', 'ngay_du_kien_de', 'ngay_de', 'ngay_cai_sua', 'ngay_phoi_lai'];
const NUMBER_FIELDS = ['stt', 'lua', 'so_con_so_sinh', 'song', 'chet', 'so_con_cai_sua'];
function validateSow(body, fields, existing = null) {
  const result = {};
  for (const field of fields) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (NUMBER_FIELDS.includes(field)) {
      if (value === null || value === '') result[field] = null;
      else if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) invalid(`${field} phải là số nguyên không âm`);
      else result[field] = Number(value);
    } else if (DATE_FIELDS.includes(field)) {
      if (value === null || value === '') result[field] = null;
      else {
        const date = parseVNDate(value);
        if (!date) invalid(`${field}: nhập ngày có thật theo dạng dd/mm/yyyy`);
        result[field] = formatVNDate(date);
      }
    } else result[field] = optionalText(value, field === 'ma_so_nai' ? 40 : field === 'ghi_chu' ? 2000 : 250, field);
  }
  if ((!existing || body.ma_so_nai !== undefined) && !result.ma_so_nai) invalid('Mã số nái không được để trống');
  if (result.ngay_phoi && !result.ngay_du_kien_de) {
    const date = parseVNDate(result.ngay_phoi);
    date.setUTCDate(date.getUTCDate() + 114);
    result.ngay_du_kien_de = formatVNDate(date);
  }
  if (body.ngay_phoi === null || body.ngay_phoi === '') {
    if (body.ngay_du_kien_de === undefined) result.ngay_du_kien_de = null;
  }
  return result;
}
module.exports = { invalid, positiveId, validPassword, optionalText, parseVNDate, formatVNDate, validateSow };
