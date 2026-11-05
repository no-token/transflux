'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { errorHandler } = require('./middleware/errorHandler');

/**
 * 组装 Express 应用：请求ID、安全头、CORS（显式来源）、路由、404 与全局错误处理。
 */
function createApp({ services, config }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // 百度通用翻译 SDK 以 form 表单提交，需要 urlencoded 解析
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // 请求ID（贯穿日志）
  app.use((req, res, next) => {
    const rid = req.headers['x-request-id'] || crypto.randomUUID();
    res.locals.requestId = rid;
    res.setHeader('X-Request-Id', rid);
    next();
  });

  // 安全头（CSP：站点全部资源同源 + 内联脚本/样式，Shoelace Web Components 需要内联样式）
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; " +
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    next();
  });

  // CORS：仅允许显式配置的源（生产禁用通配符）
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // Ocp-Apim-Subscription-Key 是网关推荐鉴权头，缺了它跨域浏览器端调用预检必失败
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Request-Id, Ocp-Apim-Subscription-Key, DeepL-Auth-Key'
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.locals.services = services;
  app.locals.config = config;

  // 静态资源：前端组件库（Shoelace / Open Props），内容不变可长缓存
  app.use(
    '/vendor',
    express.static(path.join(__dirname, '..', 'public', 'vendor'), {
      immutable: true,
      maxAge: '30d',
    })
  );

  require('./routes')(app);

  // 404
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  // 全局错误处理（必须放在最后）
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
