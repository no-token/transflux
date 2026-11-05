'use strict';

/**
 * 结构化 JSON 日志。每条日志均带时间戳与等级，跨请求通过 requestId 串联。
 * 注意：调用方务必不要向 meta 中写入密钥、令牌等敏感字段。
 */
function createLogger() {
  function emit(level, msg, meta) {
    const entry = { ts: new Date().toISOString(), level, msg };
    if (meta && typeof meta === 'object') {
      for (const k of Object.keys(meta)) {
        // 防止意外打印敏感信息
        if (/key|secret|token|password|sign/i.test(k)) continue;
        entry[k] = meta[k];
      }
    }
    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  return {
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

module.exports = { createLogger };
