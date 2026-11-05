'use strict';

const { BaseProvider } = require('./base');
const { toProviderLang, toDeepl, norm } = require('./lang');

/**
 * Microsoft Azure Translator（文本翻译）。
 * 鉴权：Ocp-Apim-Subscription-Key + Ocp-Apim-Subscription-Region 请求头。
 * 接口：POST /translate?api-version=3.0&to=<目标>&from=<源>
 * 请求体：JSON 数组 [{ text }]，支持批量。
 * 密钥：key / region（来自数据库 provider_secrets，可后台热更新）；endpoint 可选（自定义域名）。
 */
class AzureProvider extends BaseProvider {
  constructor(secrets, name) {
    super({ name: name || 'azure', requiredKeys: ['key', 'region'] });
    this.supportsHtml = true; // textType=html 原生透传
    this.setSecrets(secrets);
  }

  isConfigured() {
    return !!(this.secrets.key && this.secrets.region);
  }

  // Azure Translator 原生支持 textType=html（网页翻译片段直通）
  async translate({ texts, sourceLang, targetLang, isHtml }) {
    const key = this.secrets.key;
    const region = this.secrets.region;
    const endpoint =
      (this.secrets.endpoint || 'https://api.cognitive.microsofttranslator.com').replace(/\/$/, '');
    const to = toProviderLang(targetLang, 'azure');
    const fromRaw = toProviderLang(sourceLang, 'azure'); // 'auto' 或 映射码
    const from = fromRaw === 'auto' ? null : fromRaw;

    const url = new URL(`${endpoint}/translate`);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', to);
    if (from) url.searchParams.set('from', from);
    if (isHtml) url.searchParams.set('textType', 'html');

    const body = JSON.stringify(texts.map((t) => ({ text: t })));
    let data;

    // 注意：try 只包住 fetch 本身——业务错误（401/403 等）绝不能再被 catch 包成 "network error"。
    let resp;
    try {
      resp = await this._fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Ocp-Apim-Subscription-Region': region,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw this.upstream('timeout');
      const cause = e && (e.cause || e);
      const detail = cause && cause.code ? cause.code : (e && e.message) || 'unknown';
      throw this.upstream(`network error: ${detail}`, e);
    }
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try {
        const err = await resp.json();
        if (err && err.error) msg = `${err.error.code || resp.status}: ${err.error.message || ''}`;
      } catch (_) {
        /* 非 JSON 错误体，使用状态码信息 */
      }
      throw this.upstream(msg);
    }
    try {
      data = await resp.json();
    } catch (_) {
      throw this.upstream(`HTTP ${resp.status} 非JSON响应`);
    }

    if (!Array.isArray(data) || !data[0]) {
      throw this.upstream('unexpected response');
    }

    const translations = data.map((item) => {
      const tr = (item.translations && item.translations[0]) || {};
      const detected = item.detectedLanguage ? item.detectedLanguage.language : null;
      return {
        text: tr.text,
        detected_source_language:
          toDeepl(detected) || (from ? toDeepl(from) : null) || 'AUTO',
      };
    });
    return { translations };
  }
}

module.exports = AzureProvider;
