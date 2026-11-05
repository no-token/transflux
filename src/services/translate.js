'use strict';

const {
  ValidationError,
  ServiceUnavailableError,
  NotFoundError,
} = require('../errors');
const { translateBatch } = require('./html');

/**
 * 翻译服务：负责路由编排（优先级 + 故障自动切换）、当月用量动态禁用、
 * 字符计数与用量落库、组装统一响应。
 */
class TranslateService {
  constructor({ providers, providersFactory, store, config, logger, audit, cache }) {
    this.providers = providers;
    this.providersFactory = providersFactory || null; // 多 Key 实例增删后重建实例列表用
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.audit = audit || null;
    this.cache = cache || null; // 翻译内存缓存（LRU），可选注入
  }

  _month() {
    // 本地时区月份（YYYY-MM）：不再用 UTC——避免每月 1 日早 8 点前的用量被算进上个月
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  _chars(texts) {
    return texts.reduce((s, t) => s + (t ? t.length : 0), 0);
  }

  // 读取服务商运行态（优先级/启停/override）并叠加当月用量与自动禁用判定。
  async _buildStatuses() {
    const month = this._month();
    // 多 Key 实例可能刚在后台增删过，重建实例列表（构造成本低，每次请求重建无妨）
    if (this.providersFactory) this.providers = this.providersFactory();
    // 刷新密钥（后台改密钥后，配置态 / 用量判定立即准确）
    for (const p of this.providers) p.setSecrets(this.store.getSecrets(p.name));
    const configs = this.store.getAllProviderConfigs();
    const cfgMap = {};
    configs.forEach((c) => (cfgMap[c.name] = c));
    // 阈值整表共用，取一次即可
    const g = this.store.getGlobal('threshold');
    const threshold = g != null && !Number.isNaN(parseFloat(g)) ? parseFloat(g) : this.config.threshold;

    return this.providers.map((p) => {
      // 多 Key 实例（如 baidu-2）的默认优先级/额度沿用其基础类型的配置
      const base = p.name.includes('-') ? p.name.split('-')[0] : p.name;
      const def = this.config.providerDefaults[p.name] || this.config.providerDefaults[base] || {
        priority: this.config.defaultPriority,
        quota: this.config.defaultQuota,
      };
      const cfg = cfgMap[p.name] || {
        priority: def.priority,
        enabled: 1,
        manual_override: 0,
        quota: def.quota,
      };
      const used = this.store.getMonthUsed(p.name, month);
      // 运行时额度/阈值优先取数据库（后台可配），缺失则回退 config 默认
      const quota = cfg.quota != null ? cfg.quota : def.quota;
      const autoDisabled = used >= quota * threshold && !cfg.manual_override;
      return {
        p,
        name: p.name,
        configured: p.isConfigured(),
        priority: cfg.priority,
        enabled: !!cfg.enabled,
        manualOverride: !!cfg.manual_override,
        used,
        quota,
        threshold,
        autoDisabled,
      };
    });
  }

  /**
   * 计算本次请求可用服务商列表（已按所选模式排序）。
   * forceProvider 时仅保留指定服务商，并绕过“自动禁用”（仍须手动启用）。
   * 模式（global_config.route_mode）：
   *   priority（默认）——按后台优先级升序，严格顺序 + 失败降级；
   *   balance —— 均衡消耗：按 已用/额度 比例升序。池子小的自动少吃流量，
   *              各池同速率下降、趋于同时耗尽，全程确定性无随机（利于译风一致）。
   */
  async getOrdered(forceProvider) {
    let list = await this._buildStatuses();
    if (forceProvider) {
      list = list.filter((x) => x.name === forceProvider);
      // 强制指定：绕过自动禁用，但要求已配置且手动启用
      list = list.filter((x) => x.configured && x.enabled);
    } else {
      list = list.filter((x) => x.configured && x.enabled && !x.autoDisabled);
    }
    const gm = this.store.getGlobal('route_mode');
    if (!forceProvider && gm === 'balance' && list.length > 0) {
      list = list
        .map((x) => ({ x, ratio: x.quota > 0 ? x.used / x.quota : 1 }))
        .sort((a, b) => a.ratio - b.ratio || a.x.priority - b.x.priority)
        .map((o) => o.x);
      return list;
    }
    list.sort((a, b) => a.priority - b.priority);
    return list;
  }

  async translate({ texts, sourceLang, targets, forceProvider, isHtml, requestId, channel }) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new ValidationError('texts required');
    }
    const targetList = Array.isArray(targets) ? targets : [targets];
    if (targetList.length === 0 || targetList.some((t) => !t)) {
      throw new ValidationError('target language(s) required');
    }
    // 热加载最新密钥（后台改密钥 / 网关配置无需重启立即生效）
    for (const p of this.providers) p.setSecrets(this.store.getSecrets(p.name));

    const order = await this.getOrdered(forceProvider);
    if (order.length === 0) {
      if (this.audit) {
        this.audit.error('translate', 'gateway', 'translate.no_provider',
          forceProvider ? `强制路由 ${forceProvider} 不可用（未配置或已禁用）` : '无可用服务商（全部未配置或已禁用）',
          { requestId, forceProvider: forceProvider || null });
      }
      throw new ServiceUnavailableError(
        forceProvider
          ? `provider "${forceProvider}" unavailable (not configured / disabled)`
          : 'no available provider (all unconfigured or disabled)'
      );
    }

    const chars = this._chars(texts) * targetList.length; // 多目标按 字符×目标数 计费（与 Azure 口径一致）
    const cache = this.cache || null;
    const cacheOn = !!(cache && cache.enabled());
    const srcKey = sourceLang || 'AUTO';
    let lastErr = null;
    for (const x of order) {
      try {
        // 逐目标调用；任一目标失败则整体切换下一家，避免半成品响应。
        // isHtml（网页翻译）：原生支持的上游透传 HTML，纯文本上游走标签保留适配
        // 缓存：逐段查（批量网页翻译只把未命中的段落发上游，命中段省额度）
        const perTarget = [];
        let upstreamChars = 0; // 本次请求真正打到上游的字符数（缓存命中的部分不计用量）
        let hitAll = true;
        for (const t of targetList) {
          const hits = cacheOn ? cache.lookup(texts, srcKey, t) : null;
          if (hits && hits.every((h) => h != null)) {
            // 整批全命中：不打上游（检测语言一并复用）
            perTarget.push({
              translations: hits.map((h) =>
                h.det != null ? { text: h.text, detected_source_language: h.det } : { text: h.text }
              ),
            });
            continue;
          }
          hitAll = false;
          if (hits) {
            // 部分命中：只把未命中的段落发上游，译完按原序拼回。
            // single-flight：未命中段里若有同键的进行中翻译（并发请求），等待同一结果，不重复打上游。
            const missIdx = [];
            const missTexts = [];
            hits.forEach((h, i) => {
              if (h == null) {
                missIdx.push(i);
                missTexts.push(texts[i]);
              }
            });
            const missKeys = missTexts.map((tx) => cache.keyFor(tx, srcKey, t));
            const waitSlots = []; // { slot, promise }：等待进行中任务的段
            const realIdx = [];   // missIdx 下标：真正要发上游的段
            const realTexts = [];
            missKeys.forEach((k, j) => {
              const p = cache.inflightGet(k);
              if (p) waitSlots.push({ slot: j, promise: p });
              else { realIdx.push(j); realTexts.push(missTexts[j]); }
            });

            // 无真实上游调用（全部等待进行中任务）视同整批命中
            if (realTexts.length === 0) hitAll = true;

            let r = null;
            if (realTexts.length) {
              const upstreamPromise = translateBatch(x.p, realTexts, sourceLang, t, isHtml);
              // 逐段注册 inflight：selector 从共享结果里取本段译文；
              // settle 标记直接挂在 upstreamPromise 上（见 cache.inflightSet 注释）
              realIdx.forEach((j, jj) => {
                cache.inflightSet(missKeys[j], upstreamPromise, (res) => res.translations[jj]);
              });
              r = await upstreamPromise;
              cache.put(realTexts, srcKey, t, r.translations);
              upstreamChars += this._chars(realTexts);
            }

            const merged = hits.slice();
            // 上游结果按原序拼回
            if (r) {
              r.translations.forEach((tr, j) => {
                merged[missIdx[realIdx[j]]] = tr;
              });
            }
            // 等待进行中任务的段（任一失败则整体抛出，跟随 fallback；重试时会命中已写入的缓存或新 inflight）
            if (waitSlots.length) {
              const ws = await Promise.all(waitSlots.map((w) => w.promise));
              ws.forEach((tr, k) => {
                merged[missIdx[waitSlots[k].slot]] = tr;
              });
            }
            perTarget.push({
              translations: merged.map((m) => {
                if (m == null) return { text: '' };
                if (m.det != null) return { text: m.text, detected_source_language: m.det }; // 缓存条目
                return m; // 上游原对象（自带 detected_source_language）
              }),
            });
          } else {
            const r = await translateBatch(x.p, texts, sourceLang, t, isHtml);
            perTarget.push(r);
            upstreamChars += this._chars(texts);
          }
        }
        // 每次成功调用都记一笔：缓存全命中记 0 字符（按接口的调用次数才含命中流量），
        // chars 只算真实打到上游的部分；channel 标记请求来自哪个接口渠道
        this.store.recordUsage(x.name, upstreamChars, this._month(), 1, 0, channel);
        if (cacheOn) {
          cache.recordSaved(chars - upstreamChars);
        }
        this.logger.info('translate ok', {
          provider: x.name,
          chars: upstreamChars,
          savedChars: chars - upstreamChars,
          cacheHit: cacheOn && hitAll,
          targets: targetList.length,
          requestId,
        });
        return { provider: x.name, perTarget, cacheHit: cacheOn && hitAll };
      } catch (err) {
        lastErr = err;
        if (this.audit) {
          this.audit.warn('translate', x.name, 'translate.fallback',
            `上游 ${x.name} 失败，切换下一家`, { error: err.message, requestId });
        }
        this.logger.warn('provider failed, fallback', {
          provider: x.name,
          error: err.message,
          requestId,
        });
      }
    }
    if (this.audit) {
      this.audit.error('translate', 'gateway', 'translate.all_failed',
        '全部上游失败', { error: lastErr ? lastErr.message : '', requestId, forceProvider: forceProvider || null });
    }
    throw new ServiceUnavailableError(
      `all providers failed: ${lastErr ? lastErr.message : ''}`
    );
  }

  /**
   * 连通性测试：用该服务商当前已保存的密钥发一次最小真实翻译请求。
   * 计入用量但打 is_test 标：总览统计（KPI/趋势/占比）剔除测试流量，只单独展示测试次数；
   * 上游侧仍按其计费口径消耗少量额度。
   * 返回 { ok, latencyMs?, sample?, error? }，永不抛业务异常（错误归一为 ok:false）。
   */
  async testProvider(name, { text, sourceLang, targetLang } = {}) {
    const p = this.providers.find((x) => x.name === name);
    if (!p) throw new NotFoundError('provider not found');
    // 热加载最新密钥，确保测试用的就是后台刚保存的值
    p.setSecrets(this.store.getSecrets(name));
    if (!p.isConfigured()) {
      return { ok: false, error: '密钥未配置完整（缺少必填项）' };
    }
    const started = Date.now();
    const testText = text || 'Hello, world!';
    // 测试同样消耗上游真实配额，必须计入用量（成功计入，失败留痕不计额度）
    try {
      const res = await p.translate({
        texts: [testText],
        sourceLang: sourceLang || 'AUTO',
        targetLang: targetLang || 'ZH',
      });
      const sample = res.translations.map((t) => t.text).join(' / ');
      if (!sample) {
        // 上游 2xx 但没给译文（如密钥被误判成功），一律视为测试失败
        this.store.recordUsage(name, testText.length, this._month(), 0, 1);
        return { ok: false, latencyMs: Date.now() - started, error: '上游返回空译文' };
      }
      // is_test=1：测试流量单独打标，总览统计（KPI/趋势/占比）剔除，只显示测试次数
      this.store.recordUsage(name, testText.length, this._month(), 1, 1);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        sample,
        chars: testText.length,
      };
    } catch (err) {
      this.store.recordUsage(name, testText.length, this._month(), 0, 1);
      return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
  }

  // 供 /usage 与 /admin/providers 复用的状态列表（按优先级排序）。
  async getStatuses() {
    const list = await this._buildStatuses();
    list.sort((a, b) => a.priority - b.priority);
    const instMap = {};
    this.store.listInstances().forEach((i) => (instMap[i.name] = i));
    return list.map((x) => {
      const inst = instMap[x.name];
      return {
        name: x.name,
        type: inst ? inst.type : x.name, // 多 Key 实例返回基础类型，前端用于图标/配色
        label: inst ? inst.label || null : (this.store.getProviderLabel(x.name) || null),
        configured: x.configured,
        priority: x.priority,
        enabled: x.enabled,
        manualOverride: x.manualOverride,
        monthUsed: x.used,
        quota: x.quota,
        threshold: x.threshold,
        remaining: Math.max(0, x.quota - x.used),
        pct: x.quota > 0 ? Math.round((x.used / x.quota) * 1000) / 10 : 0,
        autoDisabled: x.autoDisabled,
      };
    });
  }
}

module.exports = { TranslateService };
