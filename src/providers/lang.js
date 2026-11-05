'use strict';

/**
 * 语言码映射：网关对外采用 DeepL 风格（如 ZH / EN / JA），
 * 内部按各家服务商的代码规范转换。
 */
const DEEPL_TO_BASE = {
  EN: 'en', ZH: 'zh', JA: 'ja', KO: 'ko', FR: 'fr', ES: 'es', IT: 'it',
  DE: 'de', RU: 'ru', PT: 'pt', AR: 'ar', ID: 'id', TR: 'tr', VI: 'vi',
  TH: 'th', MS: 'ms', HI: 'hi',
};

// 百度特殊代码
const BAIDU_OVERRIDE = {
  ja: 'jp', ko: 'kor', fr: 'fra', es: 'spa', vi: 'vie', 'zh-tw': 'cht',
  da: 'dan', et: 'est', fi: 'fin', cs: 'ces', ro: 'rom', sk: 'slo', sv: 'sve', bg: 'bul',
};
const BAIDU_TO_DEEPL = {
  jp: 'JA', kor: 'KO', fra: 'FR', spa: 'ES', vie: 'VI', cht: 'ZH-TW', ara: 'AR',
  dan: 'DA', est: 'ET', fin: 'FI', ces: 'CS', rom: 'RO', slo: 'SK', sve: 'SV', bul: 'BG',
};

// 其余厂商方言码 → DeepL 风格（含地区码与下划线变体，如 Google 的 zh-CN、Azure 的 zh_Hans）
const TO_DEEPL_EXTRA = {
  'zh-cn': 'ZH', 'zh-sg': 'ZH', 'zh-hant': 'ZH-TW', 'zh-tw': 'ZH-TW',
  'zh-hk': 'ZH-TW', 'zh-mo': 'ZH-TW', cht: 'ZH-TW', chs: 'ZH',
  jp: 'JA', kor: 'KO', fra: 'FR', spa: 'ES', vie: 'VI', ara: 'AR',
  yue: 'YUE', wyw: 'WYW', lzh: 'WYW',
};

// Azure 特殊代码（中文用 zh-Hans / zh-Hant；文言文用 lzh；同时兼容常见小写/地区写法）
const AZURE_OVERRIDE = {
  zh: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-sg': 'zh-Hans',
  'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-mo': 'zh-Hant',
  wyw: 'lzh', // Azure 文言文代码
};
const AZURE_TO_DEEPL = {
  'zh-hans': 'ZH', 'zh-hant': 'ZH-TW', lzh: 'WYW', yue: 'YUE',
  'zh-cn': 'ZH', 'zh-sg': 'ZH', 'zh-tw': 'ZH-TW', 'zh-hk': 'ZH-TW', 'zh-mo': 'ZH-TW',
};

// 中文变体规整（兼容 Azure 风格 zh-Hans/zh-Hant 与常见地区码 → 内部规范 ZH / ZH-TW）
const CANON = {
  'ZH-HANS': 'ZH', 'ZH-CN': 'ZH', 'ZH-SG': 'ZH',
  'ZH-HANT': 'ZH-TW', 'ZH-TW': 'ZH-TW', 'ZH-HK': 'ZH-TW', 'ZH-MO': 'ZH-TW',
};

// 各厂商方言码 → 内部规范码（用户可传任意一家风格，网关统一规整后再按目标厂商转换）
const ALIAS = {
  JP: 'ja', KOR: 'ko', FRA: 'fr', SPA: 'es', ARA: 'ar', VIE: 'vi',
  DAN: 'da', EST: 'et', FIN: 'fi', CES: 'cs', ROM: 'ro', SLO: 'sk', SVE: 'sv', BUL: 'bg',
  CHS: 'zh', CHT: 'zh-tw', // 百度风格简繁
  YUE: 'yue', WYW: 'wyw', LZH: 'wyw', // 粤语 / 文言文（Azure 文言文代码 lzh 也归一到 wyw）
};

function norm(code) {
  return (code || '').trim().toUpperCase();
}

function base(code) {
  const u = norm(code);
  return DEEPL_TO_BASE[u] || ALIAS[u] || u.toLowerCase();
}

/**
 * 将 DeepL 风格代码转为目标服务商代码。
 * 返回 'auto' 表示“自动检测”（由适配器决定是否透传或省略）。
 */
function toProviderLang(code, provider) {
  const u0 = norm(code);
  if (!u0 || u0 === 'AUTO') return 'auto';
  const u = CANON[u0] || u0; // 先规整中文变体（zh-Hans → ZH 等）
  if (provider === 'baidu') {
    const b = base(u); // 基于规整后的代码映射（方言码先归一，如 jp→ja→jp）
    return BAIDU_OVERRIDE[b] || b;
  }
  if (provider === 'azure') {
    const b = base(u); // 基于规整后的代码映射
    return AZURE_OVERRIDE[b] || b; // zh -> zh-Hans
  }
  if (provider === 'deepl') return base(u).toUpperCase(); // 方言码归一后转大写（jp → JA）
  return base(code); // volcengine / alibaba 使用小写
}

/** 将服务商返回的语言代码规范回 DeepL 风格（大写）。 */
function toDeepl(code) {
  if (!code) return null;
  const lower = String(code).toLowerCase().replace(/_/g, '-'); // Azure 返回 zh_Hans 等下划线变体
  if (BAIDU_TO_DEEPL[lower]) return BAIDU_TO_DEEPL[lower];
  if (AZURE_TO_DEEPL[lower]) return AZURE_TO_DEEPL[lower];
  if (TO_DEEPL_EXTRA[lower]) return TO_DEEPL_EXTRA[lower];
  const rev = Object.fromEntries(Object.entries(DEEPL_TO_BASE).map(([k, v]) => [v, k]));
  return rev[lower] || code.toUpperCase();
}

module.exports = { toProviderLang, toDeepl, norm, base };
