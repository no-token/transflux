'use strict';

/**
 * 审计服务：把关键动作（登录、配置变更、上游故障、未捕获错误）写入 audit_logs 表，
 * 供后台「日志审计」查询；同时透传到结构化 stdout 日志。
 * detail 中不要放密钥/令牌等敏感字段。
 */
function createAudit(store, logger) {
  function write(level, category, actor, action, message, detail) {
    try {
      store.addLog({ level, category, actor, action, message, detail });
    } catch (e) { /* 审计失败不能影响主流程 */ }
    if (logger) {
      const meta = { category, actor, action };
      if (detail && typeof detail === 'object') {
        for (const k of Object.keys(detail)) {
          if (/key|secret|token|password|sign/i.test(k)) continue;
          meta[k] = detail[k];
        }
      }
      logger[level] ? logger[level](message, meta) : logger.info(message, meta);
    }
  }

  return {
    info: (category, actor, action, message, detail) => write('info', category, actor, action, message, detail),
    warn: (category, actor, action, message, detail) => write('warn', category, actor, action, message, detail),
    error: (category, actor, action, message, detail) => write('error', category, actor, action, message, detail),
  };
}

module.exports = { createAudit };
