'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const initSqlJs = require('sql.js');

const scryptAsync = promisify(crypto.scrypt);

// 密码哈希：scrypt + 随机盐，纯 Node 内置，无第三方原生依赖。
// 异步执行，避免登录验证时同步阻塞事件循环（并发登录造成 CPU DoS）。
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(pw, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const h = (await scryptAsync(pw, salt, 64)).toString('hex');
  const a = Buffer.from(h);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 基于 sql.js（纯 WASM，无原生编译依赖）的 SQLite 封装。内存库，每次写后整体落盘。
 * 持久化内容：
 *  - usage_records：按月按服务商累计字符用量
 *  - provider_config：优先级/启停/覆盖禁用/免费额度
 *  - global_config：全局配置（如 80% 自动禁用阈值）
 *  - admin_users / admin_sessions：后台账号密码登录与会话
 *  - provider_secrets：各家翻译 API 密钥（按你的选择明文存储；生产建议配合主密钥加密）
 *  - gateway_auth：网关对外 AUTH_KEY
 */
async function initDb(dbPath) {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });

  const resolved = path.resolve(dbPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  let db;
  if (fs.existsSync(resolved)) {
    db = new SQL.Database(fs.readFileSync(resolved));
  } else {
    db = new SQL.Database();
  }

  db.run(
    `CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      chars INTEGER NOT NULL,
      month TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1
    );`
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_pm ON usage_records(provider, month);`);
  db.run(
    `CREATE TABLE IF NOT EXISTS provider_config (
      name TEXT PRIMARY KEY,
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      manual_override INTEGER NOT NULL DEFAULT 0,
      quota INTEGER NOT NULL DEFAULT 0
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS global_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      must_change INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS provider_secrets (
      provider TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (provider, key_name)
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS gateway_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value TEXT NOT NULL
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT
    );`
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);`);
  // 多 Key 实例：同一服务商可挂多个实例（如 baidu-2），各自独立密钥/额度/优先级
  db.run(
    `CREATE TABLE IF NOT EXISTS provider_instances (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL
    );`
  );

  // 兼容旧库：provider_config 可能尚无 quota 列
  try {
    const ti = db.exec('PRAGMA table_info(provider_config)');
    const cols = ti[0] ? ti[0].values.map((r) => r[1]) : [];
    if (!cols.includes('quota')) {
      db.run('ALTER TABLE provider_config ADD COLUMN quota INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) { /* 全新库无需迁移 */ }

  // 兼容旧库：usage_records 增加 is_test 列（连通性测试打标，统计口径中与真实流量分离）
  try {
    const ti = db.exec('PRAGMA table_info(usage_records)');
    const cols = ti[0] ? ti[0].values.map((r) => r[1]) : [];
    if (!cols.includes('is_test')) {
      db.run('ALTER TABLE usage_records ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) { /* 全新库无需迁移 */ }

  // 兼容旧库：usage_records 增加 channel 列（请求来自哪个接口渠道：
  // azure/baidu/imme/deeplx/google/openai；旧数据为 NULL，面板显示为「历史」）
  try {
    const ti = db.exec('PRAGMA table_info(usage_records)');
    const cols = ti[0] ? ti[0].values.map((r) => r[1]) : [];
    if (!cols.includes('channel')) {
      db.run('ALTER TABLE usage_records ADD COLUMN channel TEXT');
    }
  } catch (e) { /* 全新库无需迁移 */ }

  // —— 静态加密：上游密钥/网关密钥 AES-256-GCM 加密落库 ————————————
  // 主密钥：MASTER_KEY 环境变量（64 位 hex）优先；否则持久化在 data/.master.key（0600）。
  // 拿到 sqlite 文件不再等于拿到所有渠道密钥（主密钥与库文件分离存放）。
  const ENC_PREFIX = 'enc:v1:';
  const masterKey = (() => {
    if (process.env.MASTER_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.MASTER_KEY)) {
      return Buffer.from(process.env.MASTER_KEY, 'hex');
    }
    const kp = path.join(dir, '.master.key');
    if (fs.existsSync(kp)) return Buffer.from(fs.readFileSync(kp, 'utf8').trim(), 'hex');
    const k = crypto.randomBytes(32);
    fs.writeFileSync(kp, k.toString('hex') + '\n', { mode: 0o600 });
    try { fs.chmodSync(kp, 0o600); } catch (e) { /* Windows 下忽略 */ }
    return k;
  })();

  function encSecret(plain) {
    if (plain == null || plain === '') return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ENC_PREFIX + iv.toString('base64') + ':' + cipher.getAuthTag().toString('base64') + ':' + ct.toString('base64');
  }

  function decSecret(stored) {
    if (stored == null || stored === '') return stored;
    const s = String(stored);
    if (!s.startsWith(ENC_PREFIX)) return s; // 历史明文，由 migrateSecrets 升级
    try {
      const [ivB, tagB, ctB] = s.slice(ENC_PREFIX.length).split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivB, 'base64'));
      d.setAuthTag(Buffer.from(tagB, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
    } catch (e) {
      return null; // 主密钥不匹配/数据被篡改：按未配置处理，不让整个网关崩掉
    }
  }

  // 启动迁移：历史明文密钥一次性升级为密文
  function migrateSecrets() {
    const rows = [];
    const s1 = db.prepare('SELECT provider, key_name, value FROM provider_secrets');
    while (s1.step()) rows.push({ t: 's', p: s1.getAsObject().provider, k: s1.getAsObject().key_name, v: s1.getAsObject().value });
    s1.free();
    const s2 = db.prepare('SELECT value FROM gateway_auth WHERE id = 1');
    if (s2.step()) rows.push({ t: 'g', v: s2.getAsObject().value });
    s2.free();
    let changed = false;
    for (const r of rows) {
      if (r.v == null || String(r.v).startsWith(ENC_PREFIX)) continue;
      if (r.t === 's') db.run('UPDATE provider_secrets SET value=? WHERE provider=? AND key_name=?', [encSecret(r.v), r.p, r.k]);
      else db.run('UPDATE gateway_auth SET value=? WHERE id=1', [encSecret(r.v)]);
      changed = true;
    }
    if (changed) saveNow();
  }

  // —— 落盘策略：两级 —————————————————————————————————————
  // 旧实现每次写库都 db.export() 全量序列化 + 同步 writeFileSync，每条翻译请求都阻塞
  // 事件循环一次，量级上来后是架构级瓶颈。改为两级：
  //   save()    高频写（用量记录/审计日志/会话）：只标脏，1.5s 防抖合并落盘
  //   saveNow() 低频配置写（密钥/额度/阈值/网关key/密码等）：立即同步落盘，
  //             保证配置变更即时持久（Windows 上进程被硬终止时无信号 flush 机会）
  // 代价：崩溃最多丢最近 1.5s 的高频写入（用量/日志可容忍），配置零丢失。
  let saveTimer = null;
  let dirty = false;
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;
    dirty = false;
    fs.writeFileSync(resolved, Buffer.from(db.export()));
  }
  function save() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { flush(); } catch (e) { /* 下次写入重试 */ } }, 1500);
  }
  function saveNow() { dirty = true; flush(); }

  function ensureConfigs(defaults, defaultThreshold) {
    db.run('BEGIN');
    const ins = db.prepare(
      'INSERT OR IGNORE INTO provider_config (name, priority, enabled, manual_override, quota) VALUES (?, ?, 1, 0, ?)'
    );
    const fix = db.prepare(
      'UPDATE provider_config SET quota = ? WHERE name = ? AND quota = 0'
    );
    for (const [name, def] of Object.entries(defaults)) {
      ins.run([name, def.priority, def.quota]);
      fix.run([def.quota, name]);
    }
    db.run('COMMIT');
    ins.free();
    fix.free();
    db.run(
      'INSERT OR IGNORE INTO global_config (key, value) VALUES (?, ?)',
      ['threshold', String(defaultThreshold)]
    );
    db.run(
      'INSERT OR IGNORE INTO global_config (key, value) VALUES (?, ?)',
      ['route_mode', 'priority'] // priority=优先级顺序；balance=均衡消耗（按 已用/额度 比例）
    );
    saveNow(); // 首次建库立即持久化
  }

  async function ensureAdmin(username = 'admin', password = 'admin123') {
    const c = db.prepare('SELECT COUNT(*) AS c FROM admin_users');
    c.step();
    const count = c.getAsObject().c;
    c.free();
    if (count === 0) {
      db.run(
        'INSERT INTO admin_users (username, password_hash, must_change, created_at) VALUES (?, ?, 1, ?)',
        [username, await hashPassword(password), new Date().toISOString()]
      );
      saveNow();
    }
  }

  function ensureGatewayKey(defaultKey) {
    const s = db.prepare('SELECT value FROM gateway_auth WHERE id = 1');
    const exists = s.step();
    s.free();
    if (!exists) {
      db.run('INSERT INTO gateway_auth (id, value) VALUES (1, ?)', [encSecret(defaultKey)]);
      saveNow();
    }
  }

  function findUser(username) {
    const s = db.prepare(
      'SELECT id, username, password_hash, must_change FROM admin_users WHERE username = ?'
    );
    s.bind([username]);
    let r = null;
    if (s.step()) r = s.getAsObject();
    s.free();
    return r;
  }

  // 会话有效期：自登录时刻起 7 天（固定，无滑动续期；到期后任意请求返回 403，前端自动登出）
  const SESSION_TTL_HOURS = 24 * 7;

  function createSession(userId, ttlHours = SESSION_TTL_HOURS) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.run(
      'INSERT OR REPLACE INTO admin_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [
        token,
        userId,
        new Date(now).toISOString(),
        new Date(now + ttlHours * 3600 * 1000).toISOString(),
      ]
    );
    save();
    return token;
  }

  function getSession(token) {
    const s = db.prepare(
      'SELECT s.user_id AS user_id, s.expires_at AS expires_at, u.username AS username, u.must_change AS must_change ' +
        'FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.token = ?'
    );
    s.bind([token]);
    let r = null;
    if (s.step()) r = s.getAsObject();
    s.free();
    if (!r) return null;
    if (new Date(r.expires_at).getTime() < Date.now()) {
      deleteSession(token);
      return null;
    }
    return r; // { user_id, expires_at, username, must_change }
  }

  function deleteSession(token) {
    db.run('DELETE FROM admin_sessions WHERE token = ?', [token]);
    save();
  }

  /** 启动时清理已过期的会话行（过期校验平时是惰性的，只有 token 被使用时才删）。 */
  function purgeExpiredSessions() {
    db.run('DELETE FROM admin_sessions WHERE expires_at < ?', [new Date().toISOString()]);
    save();
  }

  async function updatePassword(userId, newPassword) {
    db.run('UPDATE admin_users SET password_hash = ?, must_change = 0 WHERE id = ?', [
      await hashPassword(newPassword),
      userId,
    ]);
    saveNow();
  }

  function getSecrets(provider) {
    const s = db.prepare('SELECT key_name, value FROM provider_secrets WHERE provider = ?');
    s.bind([provider]);
    const out = {};
    while (s.step()) {
      const o = s.getAsObject();
      out[o.key_name] = decSecret(o.value);
    }
    s.free();
    return out;
  }

  function setSecrets(provider, obj) {
    if (!obj) return;
    const ins = db.prepare(
      'INSERT OR REPLACE INTO provider_secrets (provider, key_name, value) VALUES (?, ?, ?)'
    );
    db.run('BEGIN');
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue; // 不传的字段保持原值；要清空请传空字符串
      ins.run([provider, k, encSecret(String(v))]);
    }
    db.run('COMMIT');
    ins.free();
    saveNow();
  }

  // —— 服务商多 Key 实例 ——————————————————————————————
  function listInstances() {
    const stmt = db.prepare('SELECT name, type, label, created_at FROM provider_instances ORDER BY name');
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  /** 新增实例：name 形如 baidu-2（type 必须是内置五家之一）；同时建 provider_config 行（优先级排末尾、额度沿用该家默认）。 */
  function addInstance(name, type, label, defaultQuota) {
    db.run(
      'INSERT OR REPLACE INTO provider_instances (name, type, label, created_at) VALUES (?, ?, ?, ?)',
      [String(name), String(type), label ? String(label) : null, new Date().toISOString()]
    );
    const maxStmt = db.prepare('SELECT MAX(priority) AS m FROM provider_config');
    maxStmt.step();
    const maxPri = maxStmt.getAsObject().m || 0;
    maxStmt.free();
    db.run(
      'INSERT OR IGNORE INTO provider_config (name, priority, enabled, manual_override, quota) VALUES (?, ?, 1, 0, ?)',
      [String(name), maxPri + 10, Number(defaultQuota) > 0 ? Math.floor(Number(defaultQuota)) : 0]
    );
    saveNow();
  }

  /** 删除实例：连同其配置行与密钥（用量历史保留，图表仍可显示历史记录）。 */
  function removeInstance(name) {
    db.run('DELETE FROM provider_instances WHERE name = ?', [String(name)]);
    db.run('DELETE FROM provider_config WHERE name = ?', [String(name)]);
    db.run('DELETE FROM provider_secrets WHERE provider = ?', [String(name)]);
    saveNow();
  }

  /** 修改实例备注名（传空清除）。 */
  function setInstanceLabel(name, label) {
    db.run('UPDATE provider_instances SET label = ? WHERE name = ?', [label ? String(label) : null, String(name)]);
    saveNow();
  }

  // 内置服务商的自定义名称（存 global_config：plabel_<type>，传空清除）
  function setProviderLabel(type, label) {
    const key = 'plabel_' + String(type);
    if (label && String(label).trim()) setGlobal(key, String(label).trim());
    else db.run('DELETE FROM global_config WHERE key = ?', [key]), save();
  }
  function getProviderLabel(type) {
    return getGlobal('plabel_' + String(type));
  }

  function getGatewayKey() {    const s = db.prepare('SELECT value FROM gateway_auth WHERE id = 1');
    let v = null;
    if (s.step()) v = decSecret(s.getAsObject().value);
    s.free();
    return v;
  }

  function setGatewayKey(value) {
    db.run('INSERT OR REPLACE INTO gateway_auth (id, value) VALUES (1, ?)', [encSecret(value)]);
    saveNow();
  }

  // 本地时区「今日」键（YYYY-MM-DD）。统计口径一律本地化：早 8 点前的用量归当天，
  // 与中国用户的直觉一致（created_at 存 UTC ISO，查询时用 datetime(x,'localtime') 换算）。
  function localDayKey(d = new Date()) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function localMonthKey(d = new Date()) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function recordUsage(provider, chars, month, ok, isTest, channel) {
    db.run(
      'INSERT INTO usage_records (provider, chars, month, created_at, ok, is_test, channel) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [provider, chars, month, new Date().toISOString(), ok ? 1 : 0, isTest ? 1 : 0, channel || null]
    );
    save();
  }

  function getMonthUsed(provider, month) {
    const stmt = db.prepare(
      'SELECT COALESCE(SUM(chars),0) AS total FROM usage_records WHERE provider=? AND month=? AND ok=1 AND is_test=0'
    );
    stmt.bind([provider, month]);
    let total = 0;
    if (stmt.step()) total = stmt.getAsObject().total || 0;
    stmt.free();
    return total;
  }

  // 近 N 天按 本地日×服务商 聚合的成功用量（供总览趋势图；剔除连通性测试）
  function getUsageDaily(days) {
    const cutoff = localDayKey(new Date(Date.now() - (days - 1) * 86400000));
    const stmt = db.prepare(
      "SELECT substr(datetime(created_at,'localtime'),1,10) AS day, provider, SUM(chars) AS chars " +
      'FROM usage_records WHERE ok=1 AND is_test=0 AND substr(datetime(created_at,\'localtime\'),1,10)>=? ' +
      'GROUP BY day, provider ORDER BY day'
    );
    stmt.bind([cutoff]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // 近 N 个月按 本地月×服务商 聚合的成功用量
  function getUsageMonthly(months) {
    const base = new Date();
    base.setDate(1);
    base.setMonth(base.getMonth() - (months - 1));
    const stmt = db.prepare(
      'SELECT month, provider, SUM(chars) AS chars FROM usage_records ' +
      'WHERE ok=1 AND is_test=0 AND month>=? GROUP BY month, provider ORDER BY month'
    );
    stmt.bind([localMonthKey(base)]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // 本月成功调用次数（一条记录 = 一次路由调用；不含连通性测试）
  function getMonthRequests(month) {
    const stmt = db.prepare(
      'SELECT COUNT(*) AS n FROM usage_records WHERE month=? AND ok=1 AND is_test=0'
    );
    stmt.bind([month]);
    let n = 0;
    if (stmt.step()) n = stmt.getAsObject().n || 0;
    stmt.free();
    return n;
  }

  // 今日连通性测试次数（单独口径，不混入真实流量 KPI）
  function getTodayTestCount() {
    const stmt = db.prepare(
      "SELECT COUNT(*) AS n FROM usage_records WHERE is_test=1 AND substr(datetime(created_at,'localtime'),1,10)=?"
    );
    stmt.bind([localDayKey()]);
    let n = 0;
    if (stmt.step()) n = stmt.getAsObject().n || 0;
    stmt.free();
    return n;
  }

  // 用量明细保留策略：365 天滚动 + 总行数上限 10 万（防无限膨胀拖慢全量落盘）
  const USAGE_KEEP_DAYS = 365;
  const USAGE_KEEP_ROWS = 100000;
  function purgeUsage() {
    const cutoff = new Date(Date.now() - USAGE_KEEP_DAYS * 86400000).toISOString();
    db.run('DELETE FROM usage_records WHERE created_at < ?', [cutoff]);
    db.run('DELETE FROM usage_records WHERE id <= (SELECT MAX(id) FROM usage_records) - ' + USAGE_KEEP_ROWS);
    saveNow();
  }

  // 本月按接口渠道聚合（仅成功真实流量；requests 含缓存命中的 0 字符调用，
  // chars 只算真实打到上游的字符）。旧数据 channel 为空显示为 (历史)。
  function getChannelStats(month) {
    const stmt = db.prepare(
      "SELECT IFNULL(NULLIF(channel, ''), '(历史)') AS channel, SUM(chars) AS chars, COUNT(*) AS requests " +
        'FROM usage_records WHERE month = ? AND ok = 1 AND is_test = 0 ' +
        'GROUP BY IFNULL(NULLIF(channel, ""), "(历史)") ORDER BY chars DESC, requests DESC'
    );
    stmt.bind([month]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function getAllProviderConfigs() {
    const stmt = db.prepare(
      'SELECT name, priority, enabled, manual_override, quota FROM provider_config'
    );
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function upsertProviderConfig(name, patch) {
    const cur = db.prepare(
      'SELECT name, priority, enabled, manual_override, quota FROM provider_config WHERE name=?'
    );
    cur.bind([name]);
    let row = cur.step() ? cur.getAsObject() : null;
    cur.free();
    if (!row) {
      db.run(
        'INSERT INTO provider_config (name, priority, enabled, manual_override, quota) VALUES (?, ?, 1, 0, 0)',
        [name, 100]
      );
      row = { name, priority: 100, enabled: 1, manual_override: 0, quota: 0 };
    }
    const priority = patch.priority != null ? patch.priority : row.priority;
    const enabled = patch.enabled != null ? patch.enabled : row.enabled;
    const manual_override = patch.manual_override != null ? patch.manual_override : row.manual_override;
    const quota = patch.quota != null ? patch.quota : row.quota;
    db.run(
      'UPDATE provider_config SET priority=?, enabled=?, manual_override=?, quota=? WHERE name=?',
      [priority, enabled, manual_override, quota, name]
    );
    saveNow();
  }

  function getGlobal(key) {
    const stmt = db.prepare('SELECT value FROM global_config WHERE key=?');
    stmt.bind([key]);
    let v = null;
    if (stmt.step()) v = stmt.getAsObject().value;
    stmt.free();
    return v;
  }

  function setGlobal(key, value) {
    db.run('INSERT OR REPLACE INTO global_config (key, value) VALUES (?, ?)', [key, String(value)]);
    saveNow();
  }

  // —— 日志审计 ——————————————————————————————————————
  const AUDIT_KEEP = 5000; // 只保留最近 N 条，防止无限膨胀

  function addLog({ level, category, actor, action, message, detail }) {
    db.run(
      'INSERT INTO audit_logs (ts, level, category, actor, action, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        Date.now(),
        String(level || 'info'),
        String(category || 'system'),
        actor == null ? null : String(actor),
        String(action || ''),
        String(message || ''),
        detail == null ? null : JSON.stringify(detail),
      ]
    );
    // 简单的滚动清理：超过保留条数时删除最旧的
    db.run(
      `DELETE FROM audit_logs WHERE id <= (SELECT MAX(id) FROM audit_logs) - ${AUDIT_KEEP}`
    );
    save();
  }

  function getLogs({ level, q, limit = 50, offset = 0 } = {}) {
    const where = [], params = [];
    if (level && level !== 'all') { where.push('level = ?'); params.push(String(level)); }
    if (q) {
      where.push("(message LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR IFNULL(detail, \"\") LIKE ? ESCAPE '\\')");
      const like = '%' + String(q).replace(/[\\%_]/g, '\\$&') + '%';
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);

    const totalStmt = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`);
    totalStmt.bind(params);
    const total = totalStmt.step() ? totalStmt.getAsObject().c : 0;
    totalStmt.free();

    const stmt = db.prepare(
      `SELECT id, ts, level, category, actor, action, message, detail
       FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`
    );
    stmt.bind(params);
    const items = [];
    while (stmt.step()) {
      const r = stmt.getAsObject();
      if (r.detail) { try { r.detail = JSON.parse(r.detail); } catch (e) { /* 保留原始字符串 */ } }
      items.push(r);
    }
    stmt.free();
    return { items, total, limit: lim, offset: off };
  }

  function getLogStats() {
    const stmt = db.prepare(
      `SELECT level, COUNT(*) AS c FROM audit_logs
       WHERE ts >= ? GROUP BY level`
    );
    stmt.bind([Date.now() - 86400000]); // 近 24 小时
    const stats = { error: 0, warn: 0, info: 0 };
    while (stmt.step()) {
      const r = stmt.getAsObject();
      if (stats[r.level] != null) stats[r.level] = r.c;
    }
    stmt.free();
    return stats;
  }

  function clearLogs() {
    db.run('DELETE FROM audit_logs');
    saveNow();
  }

  return {
    ensureConfigs,
    ensureAdmin,
    ensureGatewayKey,
    migrateSecrets,
    purgeExpiredSessions,
    purgeUsage,
    flush,
    localDayKey,
    localMonthKey,
    findUser,
    createSession,
    getSession,
    deleteSession,
    updatePassword,
    getSecrets,
    setSecrets,
    getGatewayKey,
    setGatewayKey,
    recordUsage,
    getChannelStats,
    getMonthUsed,
    getUsageDaily,
    getUsageMonthly,
    getMonthRequests,
    getTodayTestCount,
    getAllProviderConfigs,
    upsertProviderConfig,
    listInstances,
    addInstance,
    removeInstance,
    setInstanceLabel,
    setProviderLabel,
    getProviderLabel,
    getGlobal,
    setGlobal,
    addLog,
    getLogs,
    getLogStats,
    clearLogs,
  };
}

module.exports = { initDb, hashPassword, verifyPassword };
