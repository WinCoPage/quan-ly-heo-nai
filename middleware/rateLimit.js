function rateLimit(limit, windowMs) {
  const attempts = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
  }, Math.min(windowMs, 60000));
  cleanup.unref();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let record = attempts.get(key);
    if (!record || record.until <= now) {
      // Giới hạn bộ nhớ khi có nhiều IP khác nhau.
      if (attempts.size >= 10000 && !attempts.has(key)) {
        return res.status(429).json({ error: 'Hệ thống đang nhận nhiều yêu cầu. Vui lòng thử lại sau.' });
      }
      record = { count: 0, until: now + windowMs };
      attempts.set(key, record);
    }
    if (++record.count > limit) {
      res.setHeader('Retry-After', Math.ceil((record.until - now) / 1000));
      return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' });
    }
    next();
  };
}
module.exports = rateLimit;
