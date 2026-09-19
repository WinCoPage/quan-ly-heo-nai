const db = require('../db');

// Đánh dấu nội bộ: handler đã phản hồi lỗi (status >= 400) và cần hoàn tác giao dịch
// nhưng vẫn trả về đúng nội dung đó cho client (không phải lỗi hệ thống).
class RollbackWithResponse extends Error {}

// Route ghi chạy trong 1 giao dịch PostgreSQL; phản hồi lỗi (status >= 400) phải hoàn tác toàn bộ.
module.exports = function transactional(handler) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    let response;
    res.json = function (body) { response = body; return this; };
    try {
      await db.withTransaction(async () => {
        await handler(req, res);
        if (res.statusCode >= 400) throw new RollbackWithResponse();
      });
    } catch (error) {
      res.json = originalJson;
      if (error instanceof RollbackWithResponse) {
        if (response !== undefined) return res.json(response);
        return next();
      }
      return next(error);
    }
    res.json = originalJson;
    if (response !== undefined) return res.json(response);
    next();
  };
};
