'use strict';

const { toProviderLang } = require('../providers/lang');

/**
 * Azure Translator 兼容翻译端点：
 * 响应结构（Azure 风格，按输入文本顺序返回数组）：
 * [
 *   {
 *     "detectedLanguage": { "language": "en", "score": 1.0 },  // 仅 from 未指定时出现
 *     "translations": [ { "text": "...", "to": "zh-Hans" } ]    // 每个 to 一项
 *   },
 *   ...
 * ]
 */
async function translate(req, res, next) {
  try {
    const { texts, sourceLang, targets, forceProvider, isHtml } = res.locals.validated;
    const svc = req.app.locals.services.translate;
    const result = await svc.translate({
      texts,
      sourceLang,
      targets,
      forceProvider,
      isHtml,
      channel: 'azure', // Azure 兼容接口（/translate 与 /azure/translate 同源）
      requestId: res.locals.requestId,
    });

    // 暴露实际路由的服务商（后台试翻工作台等场景展示"本次由谁翻译"）
    res.setHeader('X-Provider', result.provider);
    // 缓存命中情况（HIT=全部命中未打上游 / PARTIAL=部分命中 / MISS=未命中或缓存关闭）
    res.setHeader('X-Cache', result.cacheHit ? 'HIT' : 'MISS');

    const items = texts.map((_, i) => {
      const item = {};
      // 源语言未指定时，取第一个目标的结果中的检测语言（所有目标检测一致）
      if (!sourceLang) {
        const det = result.perTarget[0].translations[i].detected_source_language;
        if (det) {
          item.detectedLanguage = {
            language: toProviderLang(det, 'azure'),
            score: 1.0,
          };
        }
      }
      item.translations = targets.map((t, j) => ({
        text: result.perTarget[j].translations[i].text,
        to: toProviderLang(t, 'azure'), // 回显 Azure 风格目标码
      }));
      return item;
    });

    res.json(items);
  } catch (e) {
    next(e);
  }
}

module.exports = { translate };
