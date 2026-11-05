'use strict';

const { ValidationError } = require('../errors');

/**
 * 校验 Azure Translator 风格翻译请求：
 *   Query:  api-version=3.0（必填）、to=<目标语言>（必填，可多个）、from=<源语言>（可选）
 *           textType=plain|html（默认 plain；html 服务于沉浸式翻译等网页翻译客户端，
 *           原生支持的上游透传，纯文本上游走标签保留适配器）、provider=?（网关扩展，强制指定服务商）
 *   Body:   JSON 数组 [{ "Text": "..." }, ...]（Text/text 均可，1..100 条）
 * 校验后将规整结果放入 res.locals.validated = { texts, sourceLang, targets, forceProvider, isHtml }。
 */
function validateTranslate(req, res, next) {
  try {
    const q = req.query || {};

    // api-version：Azure 风格必填且必须为 3.0
    if (!q['api-version']) throw new ValidationError('api-version query parameter is required');
    if (q['api-version'] !== '3.0') {
      throw new ValidationError("unsupported api-version, expected '3.0'");
    }

    // to：必填，可多个（Azure 支持多目标语言）
    let to = q.to;
    if (to == null) throw new ValidationError("'to' query parameter is required");
    if (!Array.isArray(to)) to = [to];
    to = to.map((s) => String(s).trim()).filter(Boolean);
    if (to.length === 0) throw new ValidationError("'to' query parameter is required");
    if (to.length > 10) throw new ValidationError("too many 'to' languages (max 10)");

    // from：可选（缺省自动检测）
    const from = q.from ? String(q.from).trim() : null;

    // textType：plain（默认）| html；其余值明确拒绝（与 Azure 行为一致）
    let isHtml = false;
    if (q.textType) {
      const tt = String(q.textType).toLowerCase();
      if (tt === 'html') isHtml = true;
      else if (tt !== 'plain') {
        throw new ValidationError("unsupported textType, expected 'plain' or 'html'");
      }
    }

    // Body：Azure 风格 JSON 数组 [{Text}]
    const body = req.body;
    if (!Array.isArray(body)) {
      throw new ValidationError('request body must be a JSON array of { Text } objects');
    }
    if (body.length === 0) throw new ValidationError('request body must not be empty');
    if (body.length > 100) throw new ValidationError('too many input texts (max 100)');

    const texts = body.map((item, i) => {
      if (item == null || typeof item !== 'object') {
        throw new ValidationError(`body[${i}] must be an object with a Text field`);
      }
      const t = item.Text != null ? item.Text : item.text;
      if (typeof t !== 'string' || t.trim().length === 0) {
        throw new ValidationError(`body[${i}].Text is required and must be a non-empty string`);
      }
      return t;
    });

    const forceProvider = req.query.provider || null;

    res.locals.validated = { texts, sourceLang: from, targets: to, forceProvider, isHtml };
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { validateTranslate };
