'use strict';

const { loadConfig } = require('./config');
const { initDb } = require('./db');
const { buildProviders } = require('./providers');
const { TranslateService } = require('./services/translate');
const { TranslationCache } = require('./services/cache');
const { createAudit } = require('./services/audit');
const { createApp } = require('./app');
const { createLogger } = require('./logger');

async function main() {
  const config = loadConfig();
  const logger = createLogger();

  const store = await initDb(config.DB_PATH);
  store.ensureConfigs(config.providerDefaults, config.threshold);
  store.ensureAdmin();                     // 默认 admin / admin123，首次登录强制改密
  store.ensureGatewayKey(config.AUTH_KEY);  // 默认网关对外 key（可后台改，无需重启）
  store.migrateSecrets();                  // 历史明文密钥一次性升级为 AES-GCM 密文
  store.purgeExpiredSessions();            // 清掉库里已过期的后台会话
  store.purgeUsage();                      // 用量明细滚动清理（365 天 + 10 万行上限）
  setInterval(() => store.purgeUsage(), 24 * 3600 * 1000).unref();
  // 各家密钥不经过 .env：全部在后台「服务商」页新增/配置，存数据库即时生效。

  const providers = buildProviders(store);
  const audit = createAudit(store, logger);
  const path = require('path');
  const cache = new TranslationCache({
    store, logger,
    // 统计持久化文件：与数据库同目录（缓存内容不落盘，仅统计几行 JSON）
    statsFile: path.join(path.dirname(config.DB_PATH), 'cache-stats.json'),
  });
  const services = {
    translate: new TranslateService({
      providers,
      providersFactory: () => buildProviders(store), // 实例增删后动态重建
      store, config, logger, audit, cache,
    }),
    store,
    cache,
    audit,
  };

  const app = createApp({ services, config });
  const server = app.listen(config.PORT, () => {
    logger.info('transflux started', { port: config.PORT, db: config.DB_PATH });
  });

  const shutdown = (sig) => {
    logger.info('shutting down', { sig });
    try { store.flush(); } catch (e) { logger.error('flush on shutdown failed', { error: e.message }); }
    try { services.cache.flushStatsSync(); } catch (e) { /* 尽力而为 */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => {
    try { store.flush(); } catch (e) { /* 尽力而为 */ }
    try { services.cache.flushStatsSync(); } catch (e) { /* 尽力而为 */ }
  });
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
