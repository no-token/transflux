'use strict';

const crypto = require('crypto');
const path = require('path');
const { toProviderLang, toDeepl } = require('../providers/lang');
const { ValidationError, NotFoundError } = require('../errors');
const { safeEqual } = require('../middleware/auth');

/**
 * 对外渠道（接口文档 + 兼容端点）：
 *  - azure  ：Azure Translator v3 兼容，POST /azure/translate（/translate 的带前缀别名），
 *             鉴权 Ocp-Apim-Subscription-Key，文档页 GET /azure
 *  - baidu  ：百度通用翻译兼容，POST|GET /baidu/api/trans/vip/translate，
 *             鉴权 appid+salt+sign（MD5），文档页 GET /baidu
 *             （注意：沉浸式翻译内置百度服务不支持自定义接口地址，此渠道面向通用百度 API 客户端）
 *  - imme   ：沉浸式翻译「自定义 API」协议（ImmersiveL），POST /imme，
 *             鉴权 ?token= 或 Bearer，文档页 GET /imme
 *  - deeplx ：DeepLX 兼容，POST /deeplx/translate，
 *             鉴权 ?token= 或 Bearer，文档页 GET /deeplx
 *  - google ：Google 网页翻译 translate_a/single 兼容，GET|POST /google/translate_a/single，
 *             鉴权 ?token= 或 Bearer，文档页 GET /google
 *  - openai ：OpenAI Chat Completions 兼容（沉浸式翻译「自定义 AI」），POST /v1/chat/completions，
 *             鉴权 Authorization: Bearer 或 ?token=，文档页 GET /openai
 *  - claude ：Anthropic Messages API 兼容（沉浸式翻译「Claude」等 Claude 协议客户端），POST /v1/messages，
 *             鉴权 x-api-key / Bearer / ?token=，文档页 GET /claude
 * 每个渠道的文档页可在后台独立启用/禁用（存 global_config，key = doc_<slug>，默认启用）。
 */

const CHANNELS = {
  azure: {
    slug: 'azure',
    label: 'Azure 渠道',
    key: 'doc_azure',
    docFile: 'doc-azure.html',
    docPath: '/azure',
    endpoint: '/azure/translate',
  },
  baidu: {
    slug: 'baidu',
    label: '百度翻译渠道',
    key: 'doc_baidu',
    docFile: 'doc-baidu.html',
    docPath: '/baidu',
    endpoint: '/baidu/api/trans/vip/translate',
  },
  imme: {
    slug: 'imme',
    label: '自定义 API 渠道',
    key: 'doc_imme',
    docFile: 'doc-imme.html',
    docPath: '/imme',
    endpoint: '/imme',
  },
  deeplx: {
    slug: 'deeplx',
    label: 'DeepLX 渠道',
    key: 'doc_deeplx',
    docFile: 'doc-deeplx.html',
    docPath: '/deeplx',
    endpoint: '/deeplx/translate',
  },
  google: {
    slug: 'google',
    label: 'Google 渠道',
    key: 'doc_google',
    docFile: 'doc-google.html',
    docPath: '/google',
    endpoint: '/google/translate_a/single',
  },
  openai: {
    slug: 'openai',
    label: 'OpenAI 渠道',
    key: 'doc_openai',
    docFile: 'doc-openai.html',
    docPath: '/openai',
    endpoint: '/v1/chat/completions',
  },
  claude: {
    slug: 'claude',
    label: 'Claude 渠道',
    key: 'doc_claude',
    docFile: 'doc-claude.html',
    docPath: '/claude',
    endpoint: '/v1/messages',
  },
};

function isChannel(slug) {
  return Object.prototype.hasOwnProperty.call(CHANNELS, slug);
}

/** 读取某渠道文档启停（未配置视为启用）。 */
function docEnabled(store, slug) {
  const ch = CHANNELS[slug];
  if (!ch) return false;
  const v = store.getGlobal(ch.key);
  return v == null ? true : String(v) === '1';
}

/** 文档启停列表（后台用）。 */
function docsState(store) {
  return Object.values(CHANNELS).map((ch) => ({
    slug: ch.slug,
    label: ch.label,
    docPath: ch.docPath,
    endpoint: ch.endpoint,
    enabled: docEnabled(store, ch.slug),
  }));
}

/**
 * GET /admin/docs：列出渠道文档及启停状态。
 */
async function listDocs(req, res, next) {
  try {
    const store = req.app.locals.services.store;
    res.json({ channels: docsState(store) });
  } catch (e) {
    next(e);
  }
}

/**
 * PUT /admin/docs/:channel：启用/禁用某渠道的对外文档页。
 * body: { enabled: boolean }（禁用后 GET /<docPath> 对外返回 404，立即生效）
 */
async function updateDoc(req, res, next) {
  try {
    const slug = req.params.channel;
    if (!isChannel(slug)) throw new NotFoundError('channel not found');
    const body = req.body || {};
    if (body.enabled == null) throw new ValidationError('enabled is required');
    const store = req.app.locals.services.store;
    store.setGlobal(CHANNELS[slug].key, body.enabled ? '1' : '0');
    const audit = req.app.locals.services.audit;
    if (audit) {
      audit.info('settings', req.adminUser.username, 'docs.toggle',
        `${body.enabled ? '启用' : '禁用'}渠道文档：/${slug}`);
    }
    res.json({ channels: docsState(store) });
  } catch (e) {
    next(e);
  }
}

/**
 * GET /<docPath>：渠道对外文档页（公开）。
 * 渠道文档被禁用时对外返回 404（与未发布一致，避免暴露网关能力）。
 */
function serveDocPage(slug) {
  const ch = CHANNELS[slug];
  return (req, res, next) => {
    try {
      const store = req.app.locals.services.store;
      if (!docEnabled(store, slug)) {
        return res
          .status(404)
          .type('html')
          .send('<!doctype html><meta charset="utf-8"><title>404</title>' +
            '<div style="font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center;color:#667">' +
            '<div style="text-align:center"><div style="font-size:44px;font-weight:700;color:#99a">404</div>' +
            '<div style="margin-top:8px">文档不存在或已停用</div></div></div>');
      }
      res.sendFile(path.join(__dirname, '..', '..', 'public', ch.docFile));
    } catch (e) {
      next(e);
    }
  };
}

// ---------------------------------------------------------------------------
// 通用 Token 鉴权（沉浸式翻译自定义端点场景：URL 里带 ?token=，或 Bearer 头）
// ---------------------------------------------------------------------------

/** 从 query（token/key/app_key/apikey）或 Authorization: Bearer 或 x-api-key（Anthropic）提取凭据。 */
function extractToken(req) {
  const q = req.query || {};
  for (const k of ['token', 'key', 'app_key', 'apikey', 'api_key']) {
    const v = q[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  const ak = req.headers['x-api-key'];
  if (ak && String(ak).trim()) return String(ak).trim();
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

/**
 * Token 鉴权中间件工厂。style 决定鉴权失败的错误格式：
 *   json     → 401 { error: { code, message } }
 *   deeplx   → 401 { code: 401, message }
 *   openai   → 401 { error: { message, type, code } }（OpenAI 风格）
 *   anthropic→ 401 { type: 'error', error: { type, message } }（Anthropic 风格）
 */
function tokenAuth(store, style) {
  return (req, res, next) => {
    const token = extractToken(req);
    const key = store.getGatewayKey();
    if (!token || !key || !safeEqual(token, key)) {
      if (style === 'deeplx') {
        return res.status(401).json({ code: 401, message: 'Invalid access token' });
      }
      if (style === 'openai') {
        return res.status(401).json({
          error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' },
        });
      }
      if (style === 'anthropic') {
        return res.status(401).json({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        });
      }
      return res.status(401).json({ error: { code: 'unauthorized', message: 'invalid or missing token' } });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// 语言码辅助
// ---------------------------------------------------------------------------

// 中文变体规整（与 providers/lang.js 的 CANON 一致）
const CANON = {
  'ZH-HANS': 'ZH', 'ZH-CN': 'ZH', 'ZH-SG': 'ZH',
  'ZH-HANT': 'ZH-TW', 'ZH-TW': 'ZH-TW', 'ZH-HK': 'ZH-TW', 'ZH-MO': 'ZH-TW',
};

/**
 * 任意风格语言码 → 网关内部基础码（小写，如 zh / zh-tw / ja）。
 * null/空/auto → null（自动检测）。
 */
function toInternal(code) {
  if (!code) return null;
  let u = String(code).trim().toUpperCase();
  if (!u || u === 'AUTO' || u === 'AUTO_DETECT' || u === 'SOURCE') return null;
  u = CANON[u] || u;
  return u.toLowerCase();
}

/** 服务商检测语言 → ISO 小写（沉浸式翻译语言码风格），ZH-TW 保留大小写惯例。 */
function isoLang(det) {
  if (!det) return null;
  const d = toDeepl(det);
  return d === 'ZH-TW' ? 'zh-TW' : d.toLowerCase();
}

/** 服务商检测语言 → Google 语言码风格（中文 → zh-CN / zh-TW）。 */
function googleLang(det) {
  if (!det) return null;
  const d = toDeepl(det);
  if (d === 'ZH') return 'zh-CN';
  if (d === 'ZH-TW') return 'zh-TW';
  return d.toLowerCase();
}

// ---------------------------------------------------------------------------
// 百度通用翻译兼容端点
// ---------------------------------------------------------------------------

// 百度特殊代码 → 网关内部代码（与 providers/lang.js 的 BAIDU_OVERRIDE 反向一致）
const BAIDU_TO_INTERNAL = {
  jp: 'ja', kor: 'ko', fra: 'fr', spa: 'es', vie: 'vi', cht: 'zh-tw',
  dan: 'da', fin: 'fi', cs: 'cs', el: 'el', nl: 'nl', pl: 'pl',
  bul: 'bg', est: 'et', hu: 'hu', rom: 'ro', slo: 'sk', swe: 'sv',
  th: 'th', ara: 'ar', de: 'de', it: 'it', pt: 'pt', ru: 'ru',
};

/** 百度风错误响应（百度官方风格：HTTP 200 + error_code/error_msg）。 */
function baiduError(res, code, msg) {
  res.status(200).json({ error_code: String(code), error_msg: msg });
}

/**
 * 百度兼容鉴权：sign = MD5(appid + q + salt + 网关密钥)，小写 hex，UTF-8。
 * 参数缺失 → 54000；签名错误 → 54001；q 超长 → 58003。
 * 鉴权通过后把 { q, from, to, lines, texts } 挂到 res.locals.baidu。
 */
function baiduAuth(store) {
  return (req, res, next) => {
    // 兼容 GET（query）与 POST（urlencoded / JSON）
    const p = Object.assign({}, req.query, req.body && typeof req.body === 'object' ? req.body : {});
    let q = p.q;
    if (Array.isArray(q)) q = q.join('\n'); // 多个 q 参数按行合并（贴近百度多 query 行为）
    const { from, to, appid, salt, sign } = p;

    if (!q || !to || !appid || !salt || !sign) {
      return baiduError(res, 54000, '必填参数为空（q / to / appid / salt / sign）');
    }
    if (q.length > 6000) {
      return baiduError(res, 58003, '长度限制：q 不能超过 6000 字符');
    }

    const key = store.getGatewayKey() || '';
    const expect = crypto
      .createHash('md5')
      .update(String(appid) + q + String(salt) + key, 'utf8')
      .digest('hex');
    if (String(sign).toLowerCase() !== expect) {
      return baiduError(res, 54001, '签名错误（Invalid Sign），请检查签名生成方法与密钥');
    }

    const lines = String(q).split('\n');
    const idx = [];
    const texts = [];
    lines.forEach((l, i) => {
      if (l && l.trim()) { idx.push(i); texts.push(l); }
    });
    if (texts.length === 0) {
      return baiduError(res, 54000, '必填参数为空（q 为空文本）');
    }

    res.locals.baidu = { q: String(q), from: from ? String(from).trim() : null, to: String(to).trim(), lines, idx, texts };
    next();
  };
}

/**
 * 百度兼容翻译控制器：
 * 响应（成功）：{ from, to, trans_result: [{ src, dst }, ...] }（q 内多个 \n 行逐行返回）
 */
async function baiduTranslate(req, res, next) {
  try {
    const { from, to, lines, idx, texts } = res.locals.baidu;
    const svc = req.app.locals.services.translate;

    // 百度代码 → 内部代码（如 jp → ja）；auto → 自动检测
    const internalTo = BAIDU_TO_INTERNAL[to.toLowerCase()] || to.toLowerCase();
    const sourceLang = !from || from.toLowerCase() === 'auto' ? null : (BAIDU_TO_INTERNAL[from.toLowerCase()] || from.toLowerCase());

    const result = await svc.translate({
      texts,
      sourceLang,
      targets: [internalTo],
      forceProvider: null,
      channel: 'baidu',
      requestId: res.locals.requestId,
    });

    const perLine = {};
    texts.forEach((_, i) => {
      perLine[idx[i]] = result.perTarget[0].translations[i].text || '';
    });

    // from 字段：请求带 from 则原样回显；否则用首个非空行的检测语言（转百度代码）
    let fromEcho = from;
    if (!fromEcho) {
      const det = result.perTarget[0].translations[0].detected_source_language;
      if (det) fromEcho = toProviderLang(det, 'baidu');
    }

    res.status(200).json({
      from: fromEcho || 'auto',
      to,
      trans_result: lines.map((src, i) => ({ src, dst: perLine[i] != null ? perLine[i] : src })),
    });
  } catch (e) {
    // 上游全部失败等业务错误：按百度风格返回系统错误（HTTP 200 + 52002）
    console.warn('[baidu-channel] translate failed:', e.message);
    return baiduError(res, 52002, '系统错误，请重试');
  }
}

// ---------------------------------------------------------------------------
// 沉浸式翻译「自定义 API」渠道（ImmersiveL 协议，官方文档 /docs/services/custom）
// ---------------------------------------------------------------------------

/**
 * POST /imme
 * 请求：{ source_lang, target_lang, text_list: ["...", ...] }
 * 响应：{ translations: [{ detected_source_lang, text }, ...] }（与 text_list 等长同序）
 */
async function immeTranslate(req, res, next) {
  try {
    const body = req.body || {};
    const textList = body.text_list;
    if (!Array.isArray(textList) || textList.length === 0) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'text_list must be a non-empty array' } });
    }
    if (textList.length > 100) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'text_list supports up to 100 texts' } });
    }
    if (!body.target_lang) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'target_lang is required' } });
    }
    const texts = textList.map((t) => String(t == null ? '' : t));
    if (texts.some((t) => !t.trim())) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'text_list contains empty text' } });
    }
    const total = texts.reduce((s, t) => s + t.length, 0);
    if (total > 50000) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'total text length exceeds 50000' } });
    }

    const svc = req.app.locals.services.translate;
    const result = await svc.translate({
      texts,
      sourceLang: toInternal(body.source_lang),
      targets: [toInternal(body.target_lang) || 'zh'],
      forceProvider: null,
      channel: 'imme',
      requestId: res.locals.requestId,
    });

    const trs = result.perTarget[0].translations;
    res.status(200).json({
      translations: texts.map((_, i) => ({
        detected_source_lang: isoLang(trs[i] && trs[i].detected_source_language),
        text: (trs[i] && trs[i].text) || '',
      })),
    });
  } catch (e) {
    console.warn('[imme-channel] translate failed:', e.message);
    return res.status(503).json({ error: { code: 'service_unavailable', message: 'translation failed, please retry' } });
  }
}

// ---------------------------------------------------------------------------
// DeepLX 兼容渠道
// ---------------------------------------------------------------------------

/**
 * POST /deeplx/translate（别名 /deeplx）
 * 请求：{ text, source_lang, target_lang }（语言码大小写不敏感，如 ZH / en / auto）
 * 响应：{ code: 200, id, data, alternatives, sourceLang, targetLang }
 */
async function deeplxTranslate(req, res, next) {
  try {
    const body = req.body || {};
    const text = String(body.text == null ? '' : body.text);
    if (!text.trim()) {
      return res.status(400).json({ code: 400, message: 'text is required' });
    }
    if (text.length > 5000) {
      return res.status(400).json({ code: 400, message: 'text length exceeds 5000' });
    }
    const target = toInternal(body.target_lang);
    if (!target) {
      return res.status(400).json({ code: 400, message: 'target_lang is required' });
    }

    const svc = req.app.locals.services.translate;
    const result = await svc.translate({
      texts: [text],
      sourceLang: toInternal(body.source_lang),
      targets: [target],
      forceProvider: null,
      channel: 'deeplx',
      requestId: res.locals.requestId,
    });

    const tr = result.perTarget[0].translations[0] || {};
    res.status(200).json({
      code: 200,
      id: Date.now(),
      data: tr.text || '',
      alternatives: [],
      sourceLang: toDeepl(tr.detected_source_language) || (body.source_lang || 'auto').toUpperCase(),
      targetLang: String(body.target_lang || target).toUpperCase(),
    });
  } catch (e) {
    console.warn('[deeplx-channel] translate failed:', e.message);
    return res.status(500).json({ code: 500, message: 'Translation failed, please retry' });
  }
}

// ---------------------------------------------------------------------------
// Google 网页翻译 translate_a/single 兼容渠道
// ---------------------------------------------------------------------------

/**
 * GET|POST /google/translate_a/single?client=gtx&sl=auto&tl=zh-CN&q=...
 *  - q 可重复（多段）或多行（\n 分隔）；响应 data[0] 与输入行一一对应
 *  - dt 等其余参数忽略（兼容 URL 直接替换域名接入）
 * 响应：[ [[trans, orig, null, null], ...], null, "detectedLang" ]
 */
async function googleTranslate(req, res, next) {
  try {
    // 兼容 GET（query）与 POST（query / JSON body / form）
    const p = Object.assign({}, req.query, req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
    const tl = p.tl;
    let qs = p.q;
    if (qs == null || !tl) {
      return res.status(400).json({ error: 'Missing required params: tl and q' });
    }
    if (!Array.isArray(qs)) qs = [qs];
    // 多个 q 参数按行合并（贴近 Google 多 q 行为）
    const allLines = qs.map((x) => String(x)).join('\n').split('\n');
    const idx = [];
    const texts = [];
    allLines.forEach((l, i) => {
      if (l && l.trim()) { idx.push(i); texts.push(l); }
    });
    if (texts.length === 0) {
      return res.status(400).json({ error: 'Missing required params: q is empty' });
    }
    const total = texts.reduce((s, t) => s + t.length, 0);
    if (total > 10000) {
      return res.status(400).json({ error: 'Text too long (max 10000 chars per request)' });
    }

    const svc = req.app.locals.services.translate;
    const result = await svc.translate({
      texts,
      sourceLang: toInternal(p.sl),
      targets: [toInternal(tl) || 'zh'],
      forceProvider: null,
      channel: 'google',
      requestId: res.locals.requestId,
    });

    const trs = result.perTarget[0].translations;
    const perLine = {};
    texts.forEach((_, i) => {
      perLine[idx[i]] = (trs[i] && trs[i].text) || '';
    });
    const detected = googleLang(trs[0] && trs[0].detected_source_language);

    res.status(200).json([
      allLines.map((src, i) => [perLine[i] != null ? perLine[i] : src, src, null, null]),
      null,
      detected || toInternal(p.sl) || 'auto',
    ]);
  } catch (e) {
    console.warn('[google-channel] translate failed:', e.message);
    return res.status(503).json({ error: 'Translation failed, please retry' });
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions 兼容渠道（沉浸式翻译「自定义 AI」等 OpenAI 兼容客户端）
// ---------------------------------------------------------------------------

/** 从 messages 中取最后一条 user 消息文本（content 为字符串；数组取拼接文本）。 */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      const c = messages[i].content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (x && x.text) || '').join('\n');
      return null;
    }
  }
  return null;
}

/**
 * 从提示词中提取待翻译原文（兼容沉浸式翻译等客户端的常见包裹格式）：
 *   1. <text>/<source>/<原文> XML 包裹
 *   2. "## Original Text" ... "## Translation Result" 区段
 *   3. "Source Text: ..." ... "Translated:" 区段
 *   4. 兜底：整段内容
 */
function extractSourceText(content) {
  let m = content.match(/<(?:text|source|原文)>([\s\S]*?)<\/(?:text|source|原文)>/i);
  if (m) return m[1].trim();
  m = content.match(/##\s*Original\s*Text\s*:?([\s\S]*?)(?:\n##\s*Translation|\n##\s*译文|$)/i);
  if (m) return m[1].trim();
  m = content.match(/Source\s*Text\s*[:：]([\s\S]*?)(?:\n\s*Translated|$)/i);
  if (m) return m[1].trim();
  return content.trim();
}

// 目标语言识别词表（按长词优先，命中即返回内部基础码）
const LANG_HINTS = [
  ['simplified chinese', 'zh'], ['traditional chinese', 'zh-tw'],
  ['简体中文', 'zh'], ['繁體中文', 'zh-tw'], ['繁体中文', 'zh-tw'],
  ['chinese', 'zh'], ['中文', 'zh'], ['汉语', 'zh'],
  ['english', 'en'], ['英语', 'en'], ['英文', 'en'],
  ['japanese', 'ja'], ['日语', 'ja'], ['日文', 'ja'],
  ['korean', 'ko'], ['韩语', 'ko'], ['韩文', 'ko'],
  ['french', 'fr'], ['法语', 'fr'], ['german', 'de'], ['德语', 'de'],
  ['spanish', 'es'], ['西班牙语', 'es'], ['russian', 'ru'], ['俄语', 'ru'],
  ['portuguese', 'pt'], ['葡萄牙语', 'pt'], ['italian', 'it'], ['意大利语', 'it'],
  ['thai', 'th'], ['泰语', 'th'], ['vietnamese', 'vi'], ['越南语', 'vi'],
  ['arabic', 'ar'], ['阿拉伯语', 'ar'], ['indonesian', 'id'], ['印尼语', 'id'],
  ['hindi', 'hi'], ['印地语', 'hi'],
];

/** 从提示词文本里猜目标语言（ Immersive 翻译提示词内含 "into Chinese" 等）。 */
function detectTargetLang(text) {
  const t = (text || '').toLowerCase();
  for (const [k, v] of LANG_HINTS) {
    if (t.includes(k)) return v;
  }
  const m = t.match(/\b(?:to|into)\s+([a-z]{2}(?:-[a-z]{2})?)\b/);
  if (m) return toInternal(m[1]) || 'zh';
  return 'zh';
}

/** 估算 token 数（经验近似：字符数 / 3，向上取整）。 */
function estTokens(s) {
  return Math.max(1, Math.ceil((s || '').length / 3));
}

/**
 * POST /v1/chat/completions
 * OpenAI Chat Completions 兼容：提取最后一条 user 消息中的原文 → 网关路由翻译 →
 * 以 assistant 消息返回译文。支持 stream（SSE）。目标语言：?to= 强制 > 提示词识别 > 默认 zh。
 */
async function openaiTranslate(req, res, next) {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({
        error: { message: "'messages' is a required property", type: 'invalid_request_error', code: null },
      });
    }
    const raw = lastUserText(body.messages);
    if (!raw || !raw.trim()) {
      return res.status(400).json({
        error: { message: 'no user message text found', type: 'invalid_request_error', code: null },
      });
    }
    const sourceText = extractSourceText(raw);
    if (!sourceText) {
      return res.status(400).json({
        error: { message: 'empty source text', type: 'invalid_request_error', code: null },
      });
    }
    if (sourceText.length > 10000) {
      return res.status(400).json({
        error: { message: 'source text too long (max 10000 chars)', type: 'invalid_request_error', code: null },
      });
    }
    // 目标语言：URL ?to= 强制指定 > 从提示词识别（含 system + user 全部文本） > 默认中文
    const promptAll = body.messages.map((m) => (m && typeof m.content === 'string' ? m.content : '')).join('\n');
    const target = toInternal(req.query.to) || detectTargetLang(promptAll);

    const svc = req.app.locals.services.translate;
    const result = await svc.translate({
      texts: [sourceText],
      sourceLang: null, // 自动检测
      targets: [target],
      forceProvider: null,
      channel: 'openai',
      requestId: res.locals.requestId,
    });
    const tr = result.perTarget[0].translations[0] || {};
    const translation = tr.text || '';

    const model = body.model || 'gateway';
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-' + crypto.randomUUID();

    if (body.stream) {
      // SSE 流式响应（沉浸式翻译 OpenAI 客户端默认流式）
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders && res.flushHeaders();
      const chunk = (delta, finish) => JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      res.write('data: ' + chunk({ role: 'assistant' }, null) + '\n\n');
      res.write('data: ' + chunk({ content: translation }, null) + '\n\n');
      res.write('data: ' + chunk({}, 'stop') + '\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.status(200).json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: translation },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: estTokens(raw),
        completion_tokens: estTokens(translation),
        total_tokens: estTokens(raw) + estTokens(translation),
      },
    });
  } catch (e) {
    console.warn('[openai-channel] translate failed:', e.message);
    return res.status(503).json({
      error: { message: 'translation failed, please retry', type: 'server_error', code: null },
    });
  }
}

/**
 * POST /v1/messages
 * Anthropic Messages API 兼容：沉浸式翻译「Claude」服务等 Claude 协议客户端接入点。
 * 提取最后一条 user 消息中的原文（兼容 <text> 包裹等提示词格式；system 提示词参与
 * 目标语言识别）→ 网关路由翻译 → 以 Anthropic message 结构返回。支持 stream（SSE，
 * message_start / content_block_delta / message_stop 事件序列）。
 */
async function anthropicTranslate(req, res, next) {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages: field is required' },
      });
    }
    const raw = lastUserText(body.messages);
    if (!raw || !raw.trim()) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'no user message text found' },
      });
    }
    const sourceText = extractSourceText(raw);
    if (!sourceText) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'empty source text' },
      });
    }
    if (sourceText.length > 10000) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'source text too long (max 10000 chars)' },
      });
    }
    // system 提示词（string 或 content block 数组）参与目标语言识别
    const sys = typeof body.system === 'string' ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => (b && b.text) || '').join('\n') : '';
    const promptAll = (sys + '\n' + raw);
    const target = toInternal(req.query.to) || detectTargetLang(promptAll);

    const svc = req.app.locals.services.translate;
    const result = await svc.translate({
      texts: [sourceText],
      sourceLang: null, // 自动检测
      targets: [target],
      forceProvider: null,
      channel: 'claude',
      requestId: res.locals.requestId,
    });
    const tr = result.perTarget[0].translations[0] || {};
    const translation = tr.text || '';

    const model = body.model || 'gateway';
    const id = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

    if (body.stream) {
      // Anthropic SSE：message_start → content_block_start → content_block_delta →
      // content_block_stop → message_delta → message_stop
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders && res.flushHeaders();
      const ev = (event, data) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
      const inTok = estTokens(raw);
      const outTok = estTokens(translation);
      res.write(ev('message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: inTok, output_tokens: 0 },
        },
      }));
      res.write(ev('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
      }));
      res.write(ev('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: translation },
      }));
      res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outTok },
      }));
      res.write(ev('message_stop', { type: 'message_stop' }));
      return res.end();
    }

    res.status(200).json({
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: translation }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: estTokens(raw),
        output_tokens: estTokens(translation),
      },
    });
  } catch (e) {
    console.warn('[claude-channel] translate failed:', e.message);
    return res.status(503).json({
      type: 'error',
      error: { type: 'api_error', message: 'translation failed, please retry' },
    });
  }
}

module.exports = {
  CHANNELS,
  listDocs,
  updateDoc,
  serveDocPage,
  tokenAuth,
  extractToken,
  baiduAuth,
  baiduTranslate,
  immeTranslate,
  deeplxTranslate,
  googleTranslate,
  openaiTranslate,
  anthropicTranslate,
  extractSourceText,
  detectTargetLang,
  toInternal,
  isoLang,
  googleLang,
};
