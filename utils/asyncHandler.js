// Bọc route handler bất đồng bộ để lỗi/rejection tự động chuyển tới middleware xử lý lỗi.
// Express 4 không tự bắt promise bị reject trong route handler như Express 5.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
