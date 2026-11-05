'use strict';

const crypto = require('crypto');
const { BaseProvider } = require('./base');
const { toProviderLang, toDeepl } = require('./lang');

// 百度翻译开放平台 2024+ 改版：新版账号只能走 ait 新接口；老账号走经典接口。
const DEFAULT_ENDPOINT = 'https://fanyi-api.baidu.com/ait/api/aiTextTranslate'; // 新版（JSON 体，sign/Bearer 均可）
const CLASSIC_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate'; // 经典通用翻译（表单体）

// 百度常见错误码 → 排查提示
const BAIDU_HINTS = {
  '52003': '未授权：App ID 不正确，或该账号未开通对应的翻译服务（通用翻译 / 大模型翻译）',
  '54001': 'App Key（密钥）不正确或签名错误，检查复制是否完整',
  '54003': '请求频率超限（标准版 QPS=1），请隔几秒再试',
  '58002': '服务已关闭，请到控制台开启',
  '58003': '当前 IP 已被风控封禁（当日多 APPID 混用触发），次日自动解封',
  '13001': '该接口对当前账号不存在（新版/老版账号接口差异），网关会自动尝试另一套接口',
};

/**
 * 百度翻译开放平台适配器。
 * 密钥（来自数据库 provider_secrets，后台可配）：
 *   appId  —— APPID（必填）
 *   appKey —— 密钥（必填，用于 sign = MD5(appid+q+salt+密钥)）
 *   apiKey —— 可选，新版控制台的 API Key；填了则优先用 Bearer 鉴权
 *   modelType —— 可选，'nmt'（机器翻译，默认，对应通用翻译额度）| 'llm'（大模型翻译）
 *   endpoint —— 可选，自定义接口地址（不填自动在新版/经典接口间兼容）
 */
class BaiduProvider extends BaseProvider {
  constructor(secrets, name) {
    super({ name: name || 'baidu', requiredKeys: ['appId', 'appKey'] });
    this.setSecrets(secrets);
  }

  isConfigured() {
    return !!(this.secrets.appId && this.secrets.appKey);
  }

  _sign(text, salt) {
    return crypto
      .createHash('md5')
      .update(this.secrets.appId + text + salt + this.secrets.appKey)
      .digest('hex');
  }

  // 统一请求 + 响应解析。body 由调用方序列化（新版 JSON / 经典表单）。
  async _call(url, body, headers) {
    let resp;
    try {
      resp = await this._fetch(url, { method: 'POST', headers, body });
    } catch (e) {
      if (e && e.name === 'AbortError') throw this.upstream('timeout');
      const cause = e && (e.cause || e);
      const detail = cause && cause.code ? cause.code : (e && e.message) || 'unknown';
      throw this.upstream(`network error: ${detail}`, e);
    }
    const raw = await resp.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      throw this.upstream(`HTTP ${resp.status} 非JSON响应: ${String(raw).slice(0, 150)}`);
    }
    if (data.error_code) {
      const hint = BAIDU_HINTS[String(data.error_code)] ? `（${BAIDU_HINTS[String(data.error_code)]}）` : '';
      const err = this.upstream(`error ${data.error_code}: ${data.error_msg}${hint}`);
      err.baiduCode = String(data.error_code);
      err.baiduMsg = String(data.error_msg || '');
      throw err;
    }
    const tr = data.trans_result && data.trans_result[0];
    if (!tr) throw this.upstream('empty result');
    return {
      text: tr.dst,
      detectedSourceLanguage: toDeepl(data.from) || 'AUTO',
    };
  }

  // 新版接口：JSON 体 + sign（可选 Bearer）。注意 salt 必须是 JSON 数字（百度新接口要求 uint64，
  // 传字符串会报 53001 parse json body error），故限制在 12 位以内保证 JS 安全整数。
  async _translateNew(text, from, to) {
    const salt = String(Math.floor(Math.random() * 9e11) + 1e11);
    const payload = {
      appid: this.secrets.appId,
      q: text,
      from,
      to,
      salt: Number(salt),
      sign: this._sign(text, salt),
      model_type: this.secrets.modelType || 'nmt', // 默认机器翻译（对应通用翻译免费额度）
    };
    const headers = { 'Content-Type': 'application/json' };
    if (this.secrets.apiKey) headers.Authorization = `Bearer ${this.secrets.apiKey}`;
    return this._call(this.secrets.endpoint || DEFAULT_ENDPOINT, JSON.stringify(payload), headers);
  }

  // 经典接口：表单体 + sign（老账号兜底）
  async _translateClassic(text, from, to) {
    const salt = Math.random().toString().slice(2);
    const form = new URLSearchParams();
    form.set('q', text);
    form.set('from', from);
    form.set('to', to);
    form.set('appid', this.secrets.appId);
    form.set('salt', salt);
    form.set('sign', this._sign(text, salt));
    return this._call(
      CLASSIC_ENDPOINT,
      form.toString(),
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );
  }

  async _translateOne(text, from, to) {
    try {
      return await this._translateNew(text, from, to);
    } catch (e) {
      // 两套接口互斥的典型表现：
      //   13001 / "Not found" —— 新版账号调不到经典接口，或老账号在新接口上"资源不存在"
      //   52003 —— 老版（通用翻译）账号调新接口，返回"大模型文本翻译服务未开通"
      // 自动回退经典接口，两头兼容（用户自定义 endpoint 时不回退）。
      const code = e.baiduCode || '';
      const msg = (e.baiduMsg || '').toLowerCase();
      const notFound =
        code === '13001' || code === '52003' || msg.includes('not found');
      if (notFound && !this.secrets.endpoint) {
        return this._translateClassic(text, from, to);
      }
      throw e;
    }
  }

  async translate({ texts, sourceLang, targetLang }) {
    const from = toProviderLang(sourceLang, 'baidu'); // 'auto' 或 映射码
    const to = toProviderLang(targetLang, 'baidu');
    // 百度标准版 QPS=1：串行 + 请求间隔，避免 Promise.all 并发触发 54003 限流。
    // 密钥可配 qps（如高级版填 10）自适应缩短间隔；默认按 1 QPS 留 10% 余量。
    const qps = Number(this.secrets.qps);
    const gap = qps > 0 ? 1000 / qps : 1100;
    const results = [];
    for (let i = 0; i < texts.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, gap));
      results.push(await this._translateOne(texts[i], from, to));
    }
    return { translations: results };
  }
}

module.exports = BaiduProvider;
