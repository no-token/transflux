'use strict';

const path = require('path');
// 自动加载项目根目录的 .env（环境变量优先于 .env，便于部署覆盖）。
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

function num(env, key, def) {
  const v = parseInt(env[key], 10);
  return Number.isFinite(v) ? v : def;
}

function loadConfig() {
  const env = process.env;

  // 网关对外 AUTH_KEY：仅作为「首次建库默认值」写入数据库（gateway_auth 表），
  // 之后一律以数据库为准，后台「系统设置」里修改，无需重启。
  const AUTH_KEY = env.AUTH_KEY || 'dev-gateway-key';

  const PORT = num(env, 'PORT', 3000);
  // 相对路径统一锚定到项目根目录（src/config 的上两级），避免受启动时工作目录影响导致数据文件"漂移"。
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
  const DB_PATH = path.isAbsolute(env.DB_PATH || '')
    ? env.DB_PATH
    : path.resolve(PROJECT_ROOT, env.DB_PATH || 'data/usage.sqlite');
  const CORS_ORIGINS = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 自动禁用阈值默认 0.8；仅首次建库写入 global_config，之后后台修改为准。
  const threshold = 0.8;

  // 每家服务商的默认优先级与免费额度（字符/月）；优先级越小越优先被尝试。
  // 仅首次建库时作为默认值写入数据库（INSERT OR IGNORE），之后一律以后台修改为准。
  // 业务默认值固化在代码里，不通过 .env 配置。
  const providerDefaults = {
    baidu: { priority: 20, quota: 1000000 },
    alibaba: { priority: 30, quota: 1000000 },
    volcengine: { priority: 10, quota: 2000000 },
    azure: { priority: 15, quota: 2000000 },
    deepl: { priority: 40, quota: 500000 },
  };

  return {
    env,
    AUTH_KEY,
    PORT,
    DB_PATH,
    CORS_ORIGINS,
    threshold,
    providerDefaults,
    defaultPriority: 100,
    defaultQuota: 1000000,
  };
}

module.exports = { loadConfig };
