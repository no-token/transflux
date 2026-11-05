'use strict';

const crypto = require('crypto');
const { BaseProvider } = require('./base');
const { toProviderLang, toDeepl } = require('./lang');

/**
 * 阿里云机器翻译 —— TranslateGeneral
 * 鉴权：RPC 请求签名（HMAC-SHA1 + 规范查询串）。
 * 密钥：ak / sk（来自数据库 provider_secrets，可后台热更新）。
 */
class AlibabaProvider extends BaseProvider {
  constructor(secrets, name) {
    super({ name: name || 'alibaba', requiredKeys: ['ak', 'sk'] });
    this.setSecrets(secrets);
  }

  isConfigured() {
    return !!(this.secrets.ak && this.secrets.sk);
  }

  // 阿里云 percentEncode：除 A-Za-z0-9-_.~ 外全部按 UTF-8 字节编码为大写十六进制。
  _percentEncode(str) {
    const buf = Buffer.from(String(str), 'utf8');
    let out = '';
    for (const b of buf) {
      if (
        (b >= 0x41 && b <= 0x5a) || // A-Z
        (b >= 0x61 && b <= 0x7a) || // a-z
        (b >= 0x30 && b <= 0x39) || // 0-9
        b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e // - . _ ~
      ) {
        out += String.fromCharCode(b);
      } else {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
    return out;
  }

  _sign(params) {
    const ak = this.secrets.ak;
    const sk = this.secrets.sk;
    const keys = Object.keys(params).sort();
    const canonical = keys
      .map((k) => `${this._percentEncode(k)}=${this._percentEncode(params[k])}`)
      .join('&');
    const stringToSign =
      'GET&' + this._percentEncode('/') + '&' + this._percentEncode(canonical);
    const sig = crypto
      .createHmac('sha1', sk + '&')
      .update(stringToSign, 'utf8')
      .digest('base64');
    return sig;
  }

  async _translateOne(text, from, to) {
    const ak = this.secrets.ak;
    const sk = this.secrets.sk;
    const params = {
      Action: 'TranslateGeneral',
      Format: 'JSON',
      Version: '2018-10-12',
      AccessKeyId: ak,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      FormatType: 'text',
      Scene: 'general',
      SourceLanguage: from,
      SourceText: text,
      TargetLanguage: to,
    };
    params.Signature = this._sign(params);
    const query = Object.entries(params)
      .map(([k, v]) => `${this._percentEncode(k)}=${this._percentEncode(v)}`)
      .join('&');
    const url = `https://mt.cn-hangzhou.aliyuncs.com/?${query}`;

    let data;
    try {
      const resp = await this._fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      data = await resp.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw this.upstream('timeout');
      const cause = e && (e.cause || e);
      const detail = cause && cause.code ? cause.code : (e && e.message) || 'unknown';
      throw this.upstream(`network error: ${detail}`, e);
    }
    // 成功判定以"返回了译文"为准：阿里云的 Code 在成功时是字符串 "200"（部分响应可能缺省），
    // 用数字严格比较会把成功误判为失败（error 200: undefined）。
    if (!data || !data.Data || data.Data.Translated == null) {
      const code = data && data.Code != null ? data.Code : 'unknown';
      const msg = (data && data.Message) || (data ? JSON.stringify(data).slice(0, 200) : 'empty response');
      throw this.upstream(`error ${code}: ${msg}`);
    }
    return {
      text: data.Data.Translated,
      detectedSourceLanguage: toDeepl(data.Data.DetectedLanguage) || toDeepl(from) || 'AUTO',
    };
  }

  async translate({ texts, sourceLang, targetLang }) {
    const from = toProviderLang(sourceLang, 'alibaba'); // 'auto' 或 映射码
    const to = toProviderLang(targetLang, 'alibaba');
    const results = await Promise.all(
      texts.map((t) => this._translateOne(t, from, to))
    );
    return { translations: results };
  }
}

module.exports = AlibabaProvider;
