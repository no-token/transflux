'use strict';

/**
 * HTML 片段翻译适配器 —— 让「只支持纯文本」的上游也能服务网页翻译客户端
 * （沉浸式翻译的网页模式以 textType=html 发送带标签的 HTML 片段）。
 *
 * 原理：把片段切分为 标签/文本 两类节点，仅收集非空白文本节点批量翻译，
 *       标签（含属性）原样保留，译文按原位置拼回。实体（&amp; 等）随所在
 *       文本节点一起送翻，不做解码——与各纯文本上游的行为一致，避免二次转义。
 */

const TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

function splitFragment(s) {
  const tokens = [];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(s)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: s.slice(last, m.index) });
    tokens.push({ type: 'tag', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) tokens.push({ type: 'text', value: s.slice(last) });
  return tokens;
}

function looksLikeHtml(s) {
  return /<\/?[a-zA-Z][^>]*>/.test(s);
}

/**
 * 统一翻译入口：isHtml 时按上游能力分流。
 *   原生支持 HTML（azure/deepl）→ 直接透传；
 *   纯文本上游 → 标签保留适配。
 * 返回 { translations: [{ text, detected_source_language }] }，与 provider.translate 同构。
 */
async function translateBatch(provider, texts, sourceLang, targetLang, isHtml) {
  if (!isHtml) return provider.translate({ texts, sourceLang, targetLang });
  if (provider.supportsHtml) {
    return provider.translate({ texts, sourceLang, targetLang, isHtml });
  }
  return translateHtmlBatch(provider, texts, sourceLang, targetLang);
}

/**
 * 批量翻译 HTML 片段（仅文本节点，标签保留）。
 */
async function translateHtmlBatch(provider, texts, sourceLang, targetLang) {
  const anyHtml = texts.some(looksLikeHtml);
  if (!anyHtml) return provider.translate({ texts, sourceLang, targetLang });

  const perFragment = texts.map(splitFragment);
  const refs = []; // { fi, tok }
  const segments = [];
  perFragment.forEach((tokens, fi) => {
    tokens.forEach((tok) => {
      if (tok.type === 'text' && tok.value.trim()) {
        refs.push({ fi, tok });
        segments.push(tok.value);
      }
    });
  });

  // 只有标签没有文本（如 <br/>）：原样返回，不打扰上游
  if (segments.length === 0) {
    return {
      translations: texts.map((t) => ({
        text: t,
        detected_source_language: sourceLang || 'AUTO',
      })),
    };
  }

  const res = await provider.translate({ texts: segments, sourceLang, targetLang });
  if (!res.translations || res.translations.length !== segments.length) {
    const got = res.translations ? res.translations.length : 0;
    throw provider.upstream(`html adapter: expected ${segments.length} segments, got ${got}`);
  }
  refs.forEach((ref, i) => {
    ref.tok.value = res.translations[i].text;
  });
  return {
    translations: texts.map((_, i) => ({
      text: perFragment[i].map((tok) => tok.value).join(''),
      detected_source_language: res.translations[0].detected_source_language,
    })),
  };
}

module.exports = { translateBatch, translateHtmlBatch, splitFragment, looksLikeHtml };
