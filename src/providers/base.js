'use strict';

const { UpstreamError } = require('../errors');

/**
 * 所有翻译服务商的基类：统一接口 translate({ texts, sourceLang, targetLang })
 * 返回 { translations: [{ text, detectedSourceLanguage }] }（DeepL 风格大写代码）。
 *
 * 密钥通过 setSecrets() 注入，支持后台热更新（在后台改密钥/网关配置无需重启）。
 */
class BaseProvider {
  constructor({ name, requiredKeys = [] }) {
    this.name = name;
    this.requiredKeys = requiredKeys;
    this.secrets = {};
    // 上游是否原生支持 HTML（textType=html 直通）；纯文本上游由网关的
    // 标签保留适配器兜底（services/html.js），因此所有上游都能服务网页翻译。
    this.supportsHtml = false;
  }

  // 注入/更新密钥（来自数据库 provider_secrets）
  setSecrets(secrets) {
    this.secrets = secrets || {};
  }

  isConfigured() {
    return this.requiredKeys.every((k) => !!(this.secrets && this.secrets[k]));
  }

  async translate() {
    throw new Error('translate() not implemented');
  }

  // 统一构造上游业务错误（由服务层捕获并触发故障切换）。
  upstream(msg, cause) {
    const e = new UpstreamError(`[${this.name}] ${msg}`);
    if (cause) e.cause = cause;
    return e;
  }

  // 统一带超时的 fetch：避免上游网络挂起拖垮网关（超时抛 AbortError，由调用方捕获并切换到下一家）。
  async _fetch(url, options = {}, timeoutMs = 8000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { BaseProvider, UpstreamError };
