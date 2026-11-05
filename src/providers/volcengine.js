'use strict';

const crypto = require('crypto');
const { BaseProvider } = require('./base');
const { toProviderLang, toDeepl } = require('./lang');

/**
 * 火山引擎机器翻译 —— TranslateText
 * 鉴权：SigV4（HMAC-SHA256）。Host=translate.volcengineapi.com，
 * Region=cn-north-1，Service=translate。签名头：content-type;host;x-content-sha256;x-date。
 * 密钥：ak / sk（来自数据库 provider_secrets，可后台热更新）。
 */
// 火山网关层错误码 → 排查提示（官方业务错误表仅 -400/-415/-429/-500）
const VOLC_HINTS = {
  InvalidCredential: 'AK/SK 无效或签名不匹配，请检查 Access Key ID 与 Secret Access Key 是否复制完整',
  SignatureDoesNotMatch: 'Secret Access Key（sk）不正确',
  NotFound: '多为火山控制台未开通「机器翻译」服务（console.volcengine.com/translate 需实名认证后开通），或 AK/SK 属于子用户且未授予 TranslateFullAccess 权限',
  AccessDenied: '该 AK/SK 无翻译权限：子用户需在「访问控制」授予 TranslateFullAccess 策略',
};

class VolcengineProvider extends BaseProvider {
  constructor(secrets, name) {
    super({ name: name || 'volcengine', requiredKeys: ['ak', 'sk'] });
    this.setSecrets(secrets);
  }

  isConfigured() {
    return !!(this.secrets.ak && this.secrets.sk);
  }

  _hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  }

  _sha256hex(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  }

  _sign(method, query, bodyStr, xDate) {
    const ak = this.secrets.ak;
    const sk = this.secrets.sk;
    const host = 'translate.volcengineapi.com';
    const region = 'cn-north-1';
    const service = 'translate';
    const payloadHash = this._sha256hex(bodyStr);
    const headers = {
      'content-type': 'application/json',
      host,
      'x-content-sha256': payloadHash,
      'x-date': xDate,
    };
    const sortedKeys = Object.keys(headers).sort(); // content-type, host, x-content-sha256, x-date
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = [
      method,
      '/',
      query,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const shortDate = xDate.slice(0, 8);
    const scope = `${shortDate}/${region}/${service}/request`;
    const stringToSign = [
      'HMAC-SHA256',
      xDate,
      scope,
      this._sha256hex(canonicalRequest),
    ].join('\n');

    const kDate = this._hmac(sk, shortDate);
    const kRegion = this._hmac(kDate, region);
    const kService = this._hmac(kRegion, service);
    const kSigning = this._hmac(kService, 'request');
    const signature = crypto
      .createHmac('sha256', kSigning)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorization = `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { authorization, headers, payloadHash };
  }

  async translate({ texts, sourceLang, targetLang }) {
    const ak = this.secrets.ak;
    const sk = this.secrets.sk;
    const to = toProviderLang(targetLang, 'volcengine');
    const fromRaw = toProviderLang(sourceLang, 'volcengine');
    const from = fromRaw === 'auto' ? null : fromRaw; // 火山省略 SourceLanguage 即自动检测

    const body = { TargetLanguage: to, TextList: texts };
    if (from) body.SourceLanguage = from;
    const bodyStr = JSON.stringify(body);

    const xDate = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z'); // 20261102T034632Z
    const query = 'Action=TranslateText&Version=2020-06-01';
    const { authorization, headers } = this._sign('POST', query, bodyStr, xDate);

    let resp;
    try {
      resp = await this._fetch('https://translate.volcengineapi.com/?' + query, {
        method: 'POST',
        headers: { ...headers, Authorization: authorization },
        body: bodyStr,
      });
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
      // 非 JSON（HTML 404 页、网关错误页等）：透出状态码与片段，便于定位
      throw this.upstream(`HTTP ${resp.status} 非JSON响应: ${String(raw).slice(0, 150)}`);
    }
    if (data.ResponseMetadata && data.ResponseMetadata.Error) {
      const err = data.ResponseMetadata.Error;
      const code = err.Code || (err.CodeN != null ? String(err.CodeN) : 'unknown');
      const hint = VOLC_HINTS[err.Code] ? `（${VOLC_HINTS[err.Code]}）` : '';
      throw this.upstream(`error ${code}: ${err.Message || 'no message'}${hint}`);
    }
    if (!data.TranslationList) throw this.upstream('empty result');
    const translations = data.TranslationList.map((t) => ({
      text: t.Translation,
      detectedSourceLanguage: toDeepl(t.DetectedSourceLanguage) || toDeepl(from) || 'AUTO',
    }));
    return { translations };
  }
}

module.exports = VolcengineProvider;
