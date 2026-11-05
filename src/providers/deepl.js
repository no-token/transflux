'use strict';

const { BaseProvider } = require('./base');
const { norm } = require('./lang');

/**
 * DeepL —— 作为可选后端之一（超免费额度后的付费兜底通道）。
 * 直接透传 DeepL 官方 API（form 表单 + DeepL-Auth-Key）。
 * 密钥：authKey / baseUrl（来自数据库 provider_secrets，可后台热更新）。
 */
class DeepLProvider extends BaseProvider {
  constructor(secrets, name) {
    super({ name: name || 'deepl', requiredKeys: ['authKey'] });
    this.supportsHtml = true; // tag_handling=html 原生支持
    this.setSecrets(secrets);
  }

  isConfigured() {
    return !!this.secrets.authKey;
  }

  // DeepL 原生支持 tag_handling=html（网页翻译片段直通）
  async translate({ texts, sourceLang, targetLang, isHtml }) {
    const authKey = this.secrets.authKey;
    const baseUrl = (this.secrets.baseUrl || 'https://api-free.deepl.com').replace(/\/$/, '');
    const to = norm(targetLang);
    const from = norm(sourceLang) === 'AUTO' ? null : norm(sourceLang);

    const params = new URLSearchParams();
    texts.forEach((t) => params.append('text', t));
    params.set('target_lang', to);
    if (from) params.set('source_lang', from);
    if (isHtml) params.set('tag_handling', 'html');

    // try 只包住 fetch 本身，避免把业务错误（401/403 等）包成 network error。
    let resp;
    try {
      resp = await this._fetch(`${baseUrl}/v2/translate`, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${authKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw this.upstream('timeout');
      const cause = e && (e.cause || e);
      const detail = cause && cause.code ? cause.code : (e && e.message) || 'unknown';
      throw this.upstream(`network error: ${detail}`, e);
    }

    let data;
    try {
      data = await resp.json();
    } catch (_) {
      throw this.upstream(`HTTP ${resp.status} 非JSON响应`);
    }
    // DeepL 错误体形如 {"message":"Wrong key"}（非 2xx），必须先查 HTTP 状态再查业务字段，
    // 否则密钥错误会被误判为翻译成功（空译文）。
    if (!resp.ok) {
      throw this.upstream(`HTTP ${resp.status}: ${(data && data.message) || 'request failed'}`);
    }
    if (data.error) {
      throw this.upstream(`error ${data.error.message || ''}`);
    }
    if (!Array.isArray(data.translations) || !data.translations.length) {
      throw this.upstream('empty result');
    }
    const translations = data.translations.map((t) => ({
      text: t.text,
      detected_source_language: t.detected_source_language,
    }));
    return { translations };
  }
}

module.exports = DeepLProvider;
