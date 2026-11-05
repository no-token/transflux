'use strict';

const crypto = require('crypto');
const { UnauthorizedError, ForbiddenError } = require('../errors');

/**
 * 常量时间比较：与后台密码的 timingSafeEqual 标准对齐，
 * 避免网关密钥校验被逐字节计时侧信道逐个猜出。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) {
    // 长度不同时也执行一次比较再返回 false，避免「长度相同才计时」的旁路
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 网关鉴权：Azure 风格优先
 *   Ocp-Apim-Subscription-Key: <key>   （与 Azure Translator 一致）
 * 兼容旧方式（便于过渡）：
 *   Authorization: Bearer <key>
 *   Authorization: DeepL-Auth-Key <key>
 * 密钥来自数据库 gateway_auth（可后台热更新，无需重启）。
 */
function gatewayAuth(store) {
  return (req, res, next) => {
    let token = req.headers['ocp-apim-subscription-key'] || null;
    if (!token) {
      const h = req.headers['authorization'] || '';
      if (h.startsWith('Bearer ')) token = h.slice(7).trim();
      else if (h.startsWith('DeepL-Auth-Key ')) token = h.slice('DeepL-Auth-Key '.length).trim();
    }
    const key = store.getGatewayKey();
    if (!token || !safeEqual(token, key)) {
      return next(new UnauthorizedError('invalid or missing gateway auth key'));
    }
    next();
  };
}

/**
 * 后台管理鉴权：校验登录会话 token（Authorization: Bearer <token>）。
 * 登录前请调用 POST /admin/login 获取 token。
 * 账号处于首次强制改密（must_change）时，只放行 查看自身信息 / 改密 / 登出，
 * 防止持初始密码的 token 继续调用其他后台接口。
 */
function adminAuth(store) {
  return (req, res, next) => {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token) return next(new ForbiddenError('missing admin session token'));
    const sess = store.getSession(token);
    if (!sess) return next(new ForbiddenError('invalid or expired admin session'));
    if (sess.must_change) {
      const allowed = ['/admin/me', '/admin/password', '/admin/logout'];
      if (!allowed.includes(req.path)) {
        return next(new ForbiddenError('password change required before using admin api'));
      }
    }
    req.adminUser = sess; // { user_id, username, must_change, expires_at }
    next();
  };
}

module.exports = { gatewayAuth, adminAuth, safeEqual };
