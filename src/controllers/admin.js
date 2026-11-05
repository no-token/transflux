'use strict';

const { ValidationError, NotFoundError, UnauthorizedError } = require('../errors');
const { verifyPassword } = require('../db');

/**
 * POST /admin/login：账号密码登录，成功后返回会话 token。
 * body: { username, password }
 */
async function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) throw new ValidationError('username and password required');
    const store = req.app.locals.services.store;
    const u = store.findUser(username);
    if (!u || !(await verifyPassword(password, u.password_hash))) {
      const audit = req.app.locals.services.audit;
      if (audit) audit.warn('auth', username, 'admin.login_failed', `登录失败：${username}`, { ip: req.ip });
      throw new UnauthorizedError('invalid username or password');
    }
    const token = store.createSession(u.id, 24 * 7); // 7 天有效
    const audit = req.app.locals.services.audit;
    if (audit) audit.info('auth', u.username, 'admin.login', `登录成功：${u.username}`, { ip: req.ip });
    res.json({ token, username: u.username, mustChange: !!u.must_change });
  } catch (e) {
    next(e);
  }
}

/** POST /admin/logout：注销当前会话。 */
async function logout(req, res, next) {
  try {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    if (token) req.app.locals.services.store.deleteSession(token);
    const audit = req.app.locals.services.audit;
    if (audit) audit.info('auth', req.adminUser ? req.adminUser.username : null, 'admin.logout', '退出登录');
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

/** GET /admin/me：返回当前登录账号信息。 */
async function me(req, res, next) {
  try {
    res.json({ username: req.adminUser.username, mustChange: !!req.adminUser.must_change });
  } catch (e) {
    next(e);
  }
}

/**
 * PUT /admin/password：修改密码。
 * body: { currentPassword?, newPassword } —— 若账号处于首次强制改密(mustChange)，无需 currentPassword。
 */
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      throw new ValidationError('new password must be >= 6 chars');
    }
    const store = req.app.locals.services.store;
    const u = store.findUser(req.adminUser.username);
    if (!u) throw new NotFoundError('user not found');
    if (u.must_change) {
      // 首次强制改密：不校验当前密码
    } else if (!currentPassword || !(await verifyPassword(currentPassword, u.password_hash))) {
      throw new UnauthorizedError('current password incorrect');
    }
    await store.updatePassword(u.id, newPassword);
    const audit = req.app.locals.services.audit;
    if (audit) audit.info('auth', u.username, 'admin.password_changed', `修改密码：${u.username}`);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

/** GET /admin/providers：列出各服务商状态（含优先级/启停/override/用量/额度）。 */
async function list(req, res, next) {
  try {
    const svc = req.app.locals.services.translate;
    const statuses = await svc.getStatuses();
    res.json({ providers: statuses });
  } catch (e) {
    next(e);
  }
}

/**
 * PUT /admin/providers/:name：设置优先级 / 启停 / 覆盖禁用 / 免费额度 / API 密钥。
 * body: { priority?, enabled?, manualOverride?, quota?, secret? }
 *   secret 形如 { appId, appKey } / { ak, sk } / { authKey, baseUrl }，仅更新提交的字段。
 */
async function update(req, res, next) {
  try {
    const name = req.params.name;
    const body = req.body || {};
    const patch = {};

    if (body.priority != null) {
      const p = Number(body.priority);
      if (!Number.isFinite(p) || p < 0) throw new ValidationError('priority must be a non-negative number');
      if (p > 9999) throw new ValidationError('priority must be <= 9999');
      patch.priority = Math.floor(p);
    }
    if (body.enabled != null) patch.enabled = body.enabled ? 1 : 0;
    if (body.manualOverride != null) patch.manual_override = body.manualOverride ? 1 : 0;
    if (body.quota != null) {
      const q = Number(body.quota);
      if (!Number.isFinite(q) || q <= 0) throw new ValidationError('quota must be a positive number');
      if (q > 1e12) throw new ValidationError('quota too large (max 1e12)');
      patch.quota = Math.floor(q);
    }

    const store = req.app.locals.services.store;
    // 接入名称：多 Key 实例存实例表；内置五家存 global_config（plabel_<type>）
    let newLabel;
    if (body.label != null) {
      newLabel = String(body.label).trim() || null;
      if (store.listInstances().some((i) => i.name === name)) store.setInstanceLabel(name, newLabel);
      else store.setProviderLabel(name, newLabel);
    }
    store.upsertProviderConfig(name, patch);
    if (body.secret && typeof body.secret === 'object') {
      store.setSecrets(name, body.secret);
    }

    const audit = req.app.locals.services.audit;
    if (audit) {
      const fields = Object.keys(patch);
      if (body.secret) fields.push('secret');
      if (newLabel !== undefined) fields.push('label');
      audit.info('provider', req.adminUser.username, 'provider.update',
        `更新服务商配置：${name}（${fields.join(', ') || '无变更'}）`, { fields });
    }

    const svc = req.app.locals.services.translate;
    const statuses = await svc.getStatuses();
    const updated = statuses.find((x) => x.name === name);
    if (!updated) throw new NotFoundError('provider not found');
    res.json({ provider: updated });
  } catch (e) {
    next(e);
  }
}

/**
 * POST /admin/providers/:name/test：连通性测试。
 * 用该服务商已保存的密钥发一次最小翻译请求（默认 "Hello, world!" → ZH），
 * 不计入用量统计；body 可选 { text, sourceLang, targetLang } 自定义测试参数。
 */
async function testProvider(req, res, next) {
  try {
    const svc = req.app.locals.services.translate;
    const body = req.body || {};
    const result = await svc.testProvider(req.params.name, {
      text: body.text || undefined,
      sourceLang: body.sourceLang || undefined,
      targetLang: body.targetLang || undefined,
    });
    const audit = req.app.locals.services.audit;
    if (audit) {
      const msg = result.ok
        ? `连通性测试成功：${req.params.name}（${result.latencyMs}ms）`
        : `连通性测试失败：${req.params.name}（${result.error}）`;
      audit[result.ok ? 'info' : 'warn']('provider', req.adminUser.username,
        'provider.test', msg, { latencyMs: result.latencyMs, error: result.error });
    }
    res.json(result);
  } catch (e) {
    next(e);
  }
}

/** GET /admin/settings：读取全局配置（当前为 80% 自动禁用阈值）。 */
async function getSettings(req, res, next) {
  try {
    const store = req.app.locals.services.store;
    const t = store.getGlobal('threshold');
    const threshold = t != null && !Number.isNaN(parseFloat(t)) ? parseFloat(t) : null;
    const rm = store.getGlobal('route_mode');
    const routeMode = rm === 'balance' ? 'balance' : 'priority';
    res.json({ threshold, routeMode });
  } catch (e) {
    next(e);
  }
}

/** PUT /admin/settings：设置全局配置（自动禁用阈值）。 */
async function updateSettings(req, res, next) {
  try {
    const body = req.body || {};
    if (body.threshold == null) throw new ValidationError('threshold is required');
    const t = Number(body.threshold);
    if (!Number.isFinite(t) || !(t > 0 && t <= 1)) throw new ValidationError('threshold must be in (0, 1]');
    const store = req.app.locals.services.store;
    store.setGlobal('threshold', t);
    let routeMode;
    if (body.routeMode != null) {
      if (body.routeMode !== 'priority' && body.routeMode !== 'balance') {
        throw new ValidationError('routeMode must be "priority" or "balance"');
      }
      store.setGlobal('route_mode', body.routeMode);
      routeMode = body.routeMode;
    }
    const audit = req.app.locals.services.audit;
    if (audit) audit.info('settings', req.adminUser.username, 'settings.update',
      `更新自动禁用阈值：${Math.round(t * 100)}%` + (routeMode ? `；路由模式：${routeMode === 'balance' ? '均衡消耗' : '优先级'}` : ''));
    res.json({ threshold: t, routeMode: routeMode || null });
  } catch (e) {
    next(e);
  }
}

/** GET /admin/gateway：读取网关对外 AUTH_KEY。 */
async function getGateway(req, res, next) {
  try {
    const store = req.app.locals.services.store;
    res.json({ gatewayKey: store.getGatewayKey() });
  } catch (e) {
    next(e);
  }
}

/** PUT /admin/gateway：设置网关对外 AUTH_KEY（立即生效，无需重启）。
 *  body: { gatewayKey, confirmKey } —— confirmKey 必须与 gatewayKey 一致，
 *  防止一次手误让所有客户端立刻 401 全局锁死。 */
async function updateGateway(req, res, next) {
  try {
    const { gatewayKey, confirmKey } = req.body || {};
    if (!gatewayKey || !gatewayKey.trim()) throw new ValidationError('gatewayKey is required');
    const v = gatewayKey.trim();
    if (confirmKey !== v) throw new ValidationError('两次输入的新密钥不一致');
    const store = req.app.locals.services.store;
    store.setGatewayKey(v);
    const audit = req.app.locals.services.audit;
    if (audit) audit.warn('settings', req.adminUser.username, 'gateway.key_rotated', '更换网关对外密钥（旧密钥立即失效）');
    res.json({ gatewayKey: v });
  } catch (e) {
    next(e);
  }
}

/**
 * GET /admin/usage/stats?days=30&months=6
 * 总览面板数据：近 N 天按 天×服务商 用量（补齐空天）、近 N 个月按月×服务商、
 * 今日用量、本月调用次数。仅统计成功记录(ok=1)。
 */
async function usageStats(req, res, next) {
  try {
    const store = req.app.locals.services.store;
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const months = Math.min(24, Math.max(2, Number(req.query.months) || 6));

    // 补齐每一天，无数据的天 total=0，前端无需补零（本地时区口径：与 recordUsage 的月/日一致）
    const dayKey = (d) => store.localDayKey(d);
    const dailyRows = store.getUsageDaily(days);
    const daily = [];
    const dailyIdx = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = dayKey(new Date(Date.now() - i * 86400000));
      const item = { day: d, byProvider: {}, total: 0 };
      daily.push(item);
      dailyIdx.set(d, item);
    }
    for (const r of dailyRows) {
      const item = dailyIdx.get(String(r.day).slice(0, 10));
      if (!item) continue;
      item.byProvider[r.provider] = r.chars;
      item.total += r.chars;
    }

    // 补齐每个月（本地时区口径，避免每月 1 日早 8 点前算进上月的时区错位）
    const monthRows = store.getUsageMonthly(months);
    const monthly = [];
    const monthIdx = new Map();
    const nowLocal = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(nowLocal.getFullYear(), nowLocal.getMonth() - i, 1);
      const key = store.localMonthKey(d);
      const item = { month: key, byProvider: {}, total: 0 };
      monthly.push(item);
      monthIdx.set(key, item);
    }
    for (const r of monthRows) {
      const item = monthIdx.get(String(r.month).slice(0, 7));
      if (!item) continue;
      item.byProvider[r.provider] = r.chars;
      item.total += r.chars;
    }

    const todayKey = store.localDayKey();
    const today = daily.find((d) => d.day === todayKey) || { total: 0, byProvider: {} };

    res.json({
      daily,
      monthly,
      today,
      monthRequests: store.getMonthRequests(store.localMonthKey()),
      testRequestsToday: store.getTodayTestCount(),
      // 本月按接口渠道汇总（azure/baidu/imme/deeplx/google/openai；chars 不含缓存命中，
      // requests 含命中流量）。旧数据（无 channel 列时期）显示为 (历史)。
      channels: store.getChannelStats(store.localMonthKey()),
    });
  } catch (e) {
    next(e);
  }
}

/**
 * GET /admin/logs?level=all|error|warn|info&q=&limit=50&offset=0
 * 日志审计查询：按级别/关键字过滤，返回条目、总数与近 24h 各级别统计。
 */
async function listLogs(req, res, next) {
  try {
    const store = req.app.locals.services.store;
    const { level, q } = req.query;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { items, total } = store.getLogs({ level, q, limit, offset });
    res.json({ items, total, limit, offset, stats: store.getLogStats() });
  } catch (e) {
    next(e);
  }
}

/** DELETE /admin/logs：清空全部审计日志。 */
async function clearLogs(req, res, next) {
  try {
    const store = req.app.locals.services.store;
    store.clearLogs();
    const audit = req.app.locals.services.audit;
    if (audit) audit.warn('system', req.adminUser.username, 'audit.cleared', '清空了全部审计日志');
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

/**
 * POST /admin/providers/:type/instances —— 为同一家服务商添加一个多 Key 实例。
 * :type 必须是内置五家之一；实例名自动分配为 <type>-N（从 -2 起）。
 * body: { label? } —— 可选备注名，如「百度备用号」。
 */
const INSTANCE_TYPES = ['baidu', 'alibaba', 'volcengine', 'azure', 'deepl'];

async function addInstance(req, res, next) {
  try {
    const type = req.params.type;
    if (!INSTANCE_TYPES.includes(type)) throw new NotFoundError('unknown provider type');
    const store = req.app.locals.services.store;
    // 计算下一个可用实例名：<type>-2、<type>-3 …（内置名与现有实例都不冲突）
    let n = 2;
    while (store.listInstances().some((i) => i.name === `${type}-${n}`)) n++;
    const name = `${type}-${n}`;
    const label = (req.body && req.body.label ? String(req.body.label).trim() : '') || null;
    const defQuota = (req.app.locals.config.providerDefaults[type] || {}).quota;
    store.addInstance(name, type, label, defQuota);
    const audit = req.app.locals.services.audit;
    if (audit) {
      audit.info('provider', req.adminUser.username, 'instance.add',
        `添加多 Key 实例：${name}${label ? '（' + label + '）' : ''}`);
    }
    const svc = req.app.locals.services.translate;
    res.json({ name, providers: await svc.getStatuses() });
  } catch (e) {
    next(e);
  }
}

/** DELETE /admin/instances/:name —— 删除多 Key 实例（内置单实例不可删）。 */
async function removeInstance(req, res, next) {
  try {
    const name = req.params.name;
    const m = /^(baidu|alibaba|volcengine|azure|deepl)-(\d+)$/.exec(name);
    if (!m || Number(m[2]) < 2) throw new ValidationError('can only remove instances like baidu-2');
    const store = req.app.locals.services.store;
    if (!store.listInstances().some((i) => i.name === name)) throw new NotFoundError('instance not found');
    store.removeInstance(name);
    const audit = req.app.locals.services.audit;
    if (audit) {
      audit.warn('provider', req.adminUser.username, 'instance.remove',
        `删除多 Key 实例：${name}（其密钥与配置一并清除）`);
    }
    const svc = req.app.locals.services.translate;
    res.json({ ok: true, providers: await svc.getStatuses() });
  } catch (e) {
    next(e);
  }
}

/** GET /admin/cache：读取翻译缓存配置与运行统计（开关/大小/命中率/节省字符/当前占用）。 */
async function getCache(req, res, next) {
  try {
    const cache = req.app.locals.services.cache;
    res.json(cache ? cache.info() : { enabled: false, maxMb: 0, entries: 0, approxBytes: 0, stats: { hits: 0, misses: 0, hitRate: 0, savedChars: 0, evictions: 0 } });
  } catch (e) {
    next(e);
  }
}

/**
 * PUT /admin/cache：更新缓存配置（即时生效，无需重启）。
 * body: { enabled?, maxMb? } —— enabled 开关；maxMb 缓存字节预算（1~512，调整后立即按新预算淘汰）。
 */
async function updateCache(req, res, next) {
  try {
    const cache = req.app.locals.services.cache;
    if (!cache) throw new NotFoundError('cache not available');
    const body = req.body || {};
    if (body.enabled == null && body.maxMb == null) {
      throw new ValidationError('enabled or maxMb is required');
    }
    if (body.enabled != null) cache.applyEnabled(!!body.enabled);
    if (body.maxMb != null) {
      const mb = Number(body.maxMb);
      if (!Number.isFinite(mb) || mb < 1 || mb > 512) {
        throw new ValidationError('maxMb must be a number in [1, 512]');
      }
      cache.applyMaxMb(Math.round(mb * 10) / 10);
    }
    const audit = req.app.locals.services.audit;
    if (audit) {
      const parts = [];
      if (body.enabled != null) parts.push(`开关：${body.enabled ? '开' : '关'}`);
      if (body.maxMb != null) parts.push(`大小：${body.maxMb} MB`);
      audit.info('settings', req.adminUser.username, 'cache.update', `更新翻译缓存（${parts.join('；')}）`);
    }
    res.json(cache.info());
  } catch (e) {
    next(e);
  }
}

/** DELETE /admin/cache：清空缓存内容与统计（LRU 全清，下次请求重新回填）。 */
async function clearCache(req, res, next) {
  try {
    const cache = req.app.locals.services.cache;
    if (!cache) throw new NotFoundError('cache not available');
    cache.clear();
    const audit = req.app.locals.services.audit;
    if (audit) audit.warn('settings', req.adminUser.username, 'cache.cleared', '清空了翻译缓存');
    res.json(cache.info());
  } catch (e) {
    next(e);
  }
}

module.exports = {
  login, logout, me, changePassword, list, update, testProvider,
  getSettings, updateSettings, getGateway, updateGateway, usageStats,
  listLogs, clearLogs, addInstance, removeInstance,
  getCache, updateCache, clearCache,
};
