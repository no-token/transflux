'use strict';

/**
 * 全局错误处理器：将 AppError 映射为规范化 JSON；
 * 5xx 不向客户端泄露堆栈/内部细节。
 */
function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  // 已知业务错误（带 code）透传友好 message；未知崩溃才兜底，避免泄露内部细节
  const message = err.code
    ? err.message || 'error'
    : status >= 500 ? 'Internal server error' : err.message || 'error';

  if (status >= 500) {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        ts: new Date().toISOString(),
        msg: 'unhandled error',
        error: err.message,
        requestId: res.locals.requestId,
      }) + '\n'
    );
    // 未捕获错误写入审计（带堆栈，供后台「日志审计」详细追踪）
    const audit = req.app && req.app.locals && req.app.locals.services && req.app.locals.services.audit;
    if (audit) {
      audit.error('system', null, 'system.error',
        `未捕获错误：${req.method} ${req.originalUrl || req.url}`,
        { error: err.message, stack: err.stack, requestId: res.locals.requestId });
    }
  }
  // Azure 风格错误体：{ "error": { "code": <数字码>, "message": "..." } }
  res.status(status).json({
    error: { code: status * 1000, message },
  });
}

module.exports = { errorHandler };
