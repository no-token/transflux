'use strict';

const { ForbiddenError } = require('../errors');

/**
 * 极简内存滑动窗口限流（单实例部署够用，无需引入外部依赖）。
 * 登录限流：按 IP+用户名 维度，60 秒窗口内最多 5 次尝试——
 * 既防密码爆破，也防并发登录把 scrypt 的 CPU 成本变成 DoS 放大器。
 */
function loginRateLimit({ windowMs = 60000, max = 5 } = {}) {
  const hits = new Map(); // key -> [timestamp, ...]
  // 定期清理过期桶，防 Map 无限膨胀
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const alive = arr.filter((t) => now - t < windowMs);
      if (alive.length === 0) hits.delete(k);
      else hits.set(k, alive);
    }
  }, windowMs);
  gc.unref();

  return function loginRateLimitMiddleware(req, res, next) {
    const key = (req.ip || '?') + '|' + String((req.body && req.body.username) || '');
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      return next(new ForbiddenError('尝试过于频繁，请 1 分钟后再试'));
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

module.exports = { loginRateLimit };
