'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { base } = require('../providers/lang');

/**
 * 翻译内存缓存（LRU，按字节预算淘汰）。
 *
 * 设计约定（与用户确认的方案）：
 *  - 缓存内容仅内存，不落盘、无 TTL：翻译结果对同一上游是确定性的，不会"过期变质"，
 *    LRU 淘汰最久未命中的即可；重启清零，冷启动后自然重建。
 *  - 统计（命中/未命中/节省字符/淘汰数）持久化：启动时读一次 cache-stats.json，
 *    运行期间绝不重读；变更后 3 秒防抖异步落盘（fire-and-forget，不阻塞翻译），
 *    优雅停机时同步补写一次。只写几行 JSON，不涉及缓存内容本身。
 *  - 容量按 MB 预算（后台 global_config: cache_max_mb，默认 16，即时生效），
 *    比按条数更公平——8 字符的按钮和 500 字符的段落开销差几十倍。
 *  - 单条估算字节 = (原文字符数 + 译文字符数) × 2（JS 字符串 UTF-16）+ 固定开销，
 *    超过预算一半的单条不缓存，防止一篇长文把整个缓存挤爆。
 *  - 键 = sha256(原文 \x1f 源语言 \x1f 目标语言)，跨渠道共享：
 *    无论这次路由到哪家上游，命中就不再打上游，省的就是那个渠道的额度。
 *    源/目标语言先经 base() 归一（EN/en、JP/ja 等方言写法共享同一键）。
 *  - single-flight：相同键的并发未命中请求只放一个打上游，其余等待同一结果，
 *    防止"并发重复"穿透缓存（如多个标签页同时翻译同一网站）。
 */
const PER_ENTRY_OVERHEAD = 200;
const SAVE_DEBOUNCE_MS = 3000;

class TranslationCache {
  constructor({ store, logger, statsFile }) {
    this.store = store;
    this.logger = logger || null;
    this.statsFile = statsFile || null; // 统计持久化文件（缓存内容不落盘）
    this.map = new Map(); // key -> { text, det, bytes }；Map 键序即 LRU 序（最旧在前）
    this.bytes = 0;
    this.stats = { hits: 0, misses: 0, savedChars: 0, evictions: 0 };
    this.inflight = new Map(); // key -> Promise<译文对象>；settle 后自动清除
    this._dirty = false;
    this._saveTimer = null;
    this._loadStats(); // 启动加载一次，其他时候不加载
    this._startAutoSave();
  }

  // ---------------- 统计持久化（启动读一次 + 防抖异步写） ----------------

  _loadStats() {
    if (!this.statsFile) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
      if (d && typeof d === 'object') {
        for (const k of ['hits', 'misses', 'savedChars', 'evictions']) {
          const v = parseInt(d[k], 10);
          if (Number.isFinite(v) && v >= 0) this.stats[k] = v;
        }
      }
    } catch (e) { /* 无文件或损坏：从零开始 */ }
  }

  _startAutoSave() {
    if (!this.statsFile) return;
    // 退出钩子：同步尽力写一次（async 回调在 exit 时不执行）
    process.on('exit', () => { try { this.flushStatsSync(); } catch (e) { /* 尽力而为 */ } });
  }

  /** 统计变更标记：3 秒防抖，定时器不重置（持续流量下也保证周期落盘）。 */
  _markDirty() {
    if (!this.statsFile) return;
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushStats().catch(() => { this._dirty = true; });
    }, SAVE_DEBOUNCE_MS);
    this._saveTimer.unref(); // 不阻止进程退出
  }

  /** 异步落盘（fire-and-forget 语义，失败恢复 dirty 下次再写）。 */
  async flushStats() {
    if (!this.statsFile || !this._dirty) return;
    const payload = JSON.stringify({
      hits: this.stats.hits,
      misses: this.stats.misses,
      savedChars: this.stats.savedChars,
      evictions: this.stats.evictions,
      savedAt: new Date().toISOString(),
    });
    this._dirty = false;
    try {
      await fs.promises.writeFile(this.statsFile, payload, 'utf8');
    } catch (e) {
      this._dirty = true;
    }
  }

  /** 同步落盘（优雅停机时调用）。 */
  flushStatsSync() {
    if (!this.statsFile || !this._dirty) return;
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify({
        hits: this.stats.hits,
        misses: this.stats.misses,
        savedChars: this.stats.savedChars,
        evictions: this.stats.evictions,
        savedAt: new Date().toISOString(),
      }), 'utf8');
      this._dirty = false;
    } catch (e) { /* 尽力而为 */ }
  }

  // ---------------- 缓存本体 ----------------

  /** 预算字节数（后台可动态调整，读 global_config，无需重启）。 */
  maxBytes() {
    const mb = parseFloat(this.store.getGlobal('cache_max_mb'));
    const v = Number.isFinite(mb) && mb > 0 ? mb : 16;
    return v * 1024 * 1024;
  }

  maxMb() {
    return Math.round((this.maxBytes() / (1024 * 1024)) * 10) / 10;
  }

  enabled() {
    const v = this.store.getGlobal('cache_enabled');
    return v == null ? true : v === '1' || v === 'true';
  }

  /** 对外暴露键计算（single-flight 注册用）；语言经 base() 归一。 */
  keyFor(text, from, to) {
    return this._key(text, from, to);
  }

  _key(text, from, to) {
    const f = from ? String(base(from)) : 'auto';
    const t = String(base(to));
    return crypto
      .createHash('sha256')
      .update(text + '\x1f' + f + '\x1f' + t)
      .digest('hex');
  }

  // ---------------- single-flight（并发未命中去重） ----------------

  /** 取同键进行中的翻译 promise；无则 undefined。 */
  inflightGet(key) {
    const e = this.inflight.get(key);
    if (!e) return undefined;
    if (e.settled) {
      // 已结束但清理回调尚未执行（微任务竞态窗口）：视同不存在，
      // 避免 fallback 下一家时继承上一家的 rejected promise
      this.inflight.delete(key);
      return undefined;
    }
    return e.promise;
  }

  /**
   * 注册进行中的翻译。promise 为共享的上游 promise，selector 从其结果中取本键对应的段；
   * onRejected 直接注册在 promise 本体上（与调用方的 await 同一微任务层级、且先注册先执行），
   * 确保 settle 标记先于调用方的 fallback 循环生效——若经中间 .then 派生，
   * 标记会晚一拍，fallback 下一家时会拿到上一家的 rejected promise 继承失败。
   */
  inflightSet(key, promise, selector) {
    const entry = { promise: null, settled: false };
    entry.promise = promise.then(
      (v) => { entry.settled = true; this.inflight.delete(key); return selector ? selector(v) : v; },
      (e) => { entry.settled = true; this.inflight.delete(key); throw e; }
    );
    entry.promise.catch(() => { /* 等待方各自处理错误；兜底避免无消费者时 unhandledRejection */ });
    this.inflight.set(key, entry);
  }

  /** 淘汰到能容纳 extraBytes 为止（从最旧开始）。 */
  _evictIfNeeded(extraBytes) {
    const max = this.maxBytes();
    while (this.map.size > 0 && this.bytes + extraBytes > max) {
      const oldest = this.map.keys().next().value;
      const e = this.map.get(oldest);
      this.bytes -= e.bytes;
      this.map.delete(oldest);
      this.stats.evictions++;
      this._markDirty();
    }
  }

  /**
   * 批量查缓存：返回与 texts 等长的数组，命中项为 { text, det }、未命中项为 null。
   * 命中项同时做 LRU 触摸（移到最新）。
   */
  lookup(texts, from, to) {
    const out = new Array(texts.length).fill(null);
    if (!this.enabled()) return out;
    let touched = false;
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i]) continue;
      const k = this._key(texts[i], from, to);
      const e = this.map.get(k);
      if (e === undefined) {
        this.stats.misses++;
        touched = true;
        continue;
      }
      this.map.delete(k);
      this.map.set(k, e); // LRU 触摸
      out[i] = { text: e.text, det: e.det };
      this.stats.hits++;
      touched = true;
    }
    if (touched) this._markDirty();
    return out;
  }

  /**
   * 批量回写缓存（只写有效译文）。
   * translations 为上游/适配器返回的译文对象数组（{ text, detected_source_language? }），
   * 检测语言一并缓存——AUTO 源语言时命中响应仍带 detectedLanguage。
   */
  put(texts, from, to, translations) {
    if (!this.enabled() || !Array.isArray(translations)) return;
    for (let i = 0; i < texts.length; i++) {
      const src = texts[i];
      const tr = translations[i];
      if (!src || !tr || typeof tr.text !== 'string' || !tr.text) continue;
      const det = tr.detected_source_language != null ? String(tr.detected_source_language) : null;
      const k = this._key(src, from, to);
      const old = this.map.get(k);
      const bytes = PER_ENTRY_OVERHEAD + (src.length + tr.text.length + (det ? det.length : 0)) * 2;
      if (old) {
        this.bytes -= old.bytes;
        this.map.delete(k);
      }
      // 单条超预算一半：不缓存，防长文冲刷
      if (bytes > this.maxBytes() / 2) continue;
      this._evictIfNeeded(bytes);
      this.map.set(k, { text: tr.text, det, bytes });
      this.bytes += bytes;
    }
  }

  /** 记录本次请求因命中而省下的上游字符数。 */
  recordSaved(chars) {
    if (chars > 0) {
      this.stats.savedChars += chars;
      this._markDirty();
    }
  }

  /** 清空缓存（后台按钮）；统计一并归零（归零结果同样持久化）。 */
  clear() {
    this.map.clear();
    this.bytes = 0;
    this.inflight.clear();
    this.stats = { hits: 0, misses: 0, savedChars: 0, evictions: 0 };
    this._markDirty();
  }

  /** 后台改大小：落 global_config 并立即按新预算淘汰。 */
  applyMaxMb(v) {
    this.store.setGlobal('cache_max_mb', String(v));
    this._evictIfNeeded(0);
  }

  /** 后台改开关：落 global_config，立即生效。 */
  applyEnabled(on) {
    this.store.setGlobal('cache_enabled', on ? '1' : '0');
  }

  info() {
    const total = this.stats.hits + this.stats.misses;
    return {
      enabled: this.enabled(),
      maxMb: this.maxMb(),
      entries: this.map.size,
      approxBytes: this.bytes,
      inflight: this.inflight.size,
      stats: {
        hits: this.stats.hits,
        misses: this.stats.misses,
        hitRate: total > 0 ? Math.round((this.stats.hits / total) * 1000) / 10 : 0,
        savedChars: this.stats.savedChars,
        evictions: this.stats.evictions,
      },
    };
  }
}

module.exports = { TranslationCache };
