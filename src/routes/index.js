'use strict';

const path = require('path');
const { gatewayAuth, adminAuth } = require('../middleware/auth');
const { loginRateLimit } = require('../middleware/rateLimit');
const { validateTranslate } = require('../middleware/validate');
const translateCtrl = require('../controllers/translate');
const usageCtrl = require('../controllers/usage');
const adminCtrl = require('../controllers/admin');
const channelsCtrl = require('../controllers/channels');

module.exports = function (app) {
  const config = app.locals.config;
  const store = app.locals.services.store;

  // 健康检查（公开）
  app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
  app.get('/ready', (req, res) => res.json({ status: 'ok' }));

  // 后台登录（公开；限流防爆破 + 防 scrypt 并发 CPU DoS）
  app.post('/admin/login', loginRateLimit(), adminCtrl.login);
  app.post('/admin/logout', adminAuth(store), adminCtrl.logout);
  app.put('/admin/password', adminAuth(store), adminCtrl.changePassword);
  app.get('/admin/me', adminAuth(store), adminCtrl.me);

  // Azure 兼容翻译接口（需网关鉴权：Ocp-Apim-Subscription-Key）
  app.post(
    '/translate',
    gatewayAuth(store),
    validateTranslate,
    translateCtrl.translate
  );

  // —— 渠道化对外接口 ————————————————————————————————

  // Azure 渠道：/translate 的带渠道前缀别名（入参/鉴权完全一致，便于按渠道分发）
  app.post(
    '/azure/translate',
    gatewayAuth(store),
    validateTranslate,
    translateCtrl.translate
  );

  // 百度渠道：通用翻译兼容端点（appid + salt + sign MD5 鉴权，百度风格入参/响应）
  const baiduGuard = channelsCtrl.baiduAuth(store);
  app.post('/baidu/api/trans/vip/translate', baiduGuard, channelsCtrl.baiduTranslate);
  app.get('/baidu/api/trans/vip/translate', baiduGuard, channelsCtrl.baiduTranslate);

  // 沉浸式翻译「自定义 API」渠道（ImmersiveL 协议；?token= 或 Bearer 鉴权）
  app.post('/imme', channelsCtrl.tokenAuth(store, 'json'), channelsCtrl.immeTranslate);

  // DeepLX 渠道（?token= / Bearer 鉴权，DeepLX 风格入参与响应）
  const deeplxGuard = channelsCtrl.tokenAuth(store, 'deeplx');
  app.post('/deeplx/translate', deeplxGuard, channelsCtrl.deeplxTranslate);
  app.post('/deeplx', deeplxGuard, channelsCtrl.deeplxTranslate);

  // Google 网页翻译渠道（translate_a/single 兼容；?token= 或 Bearer 鉴权）
  const googleGuard = channelsCtrl.tokenAuth(store, 'json');
  app.get('/google/translate_a/single', googleGuard, channelsCtrl.googleTranslate);
  app.post('/google/translate_a/single', googleGuard, channelsCtrl.googleTranslate);

  // OpenAI 渠道（Chat Completions 兼容，沉浸式翻译「自定义 AI」；Bearer 或 ?token= 鉴权）
  const openaiGuard = channelsCtrl.tokenAuth(store, 'openai');
  app.post('/v1/chat/completions', openaiGuard, channelsCtrl.openaiTranslate);
  app.post('/openai/v1/chat/completions', openaiGuard, channelsCtrl.openaiTranslate);

  // Claude 渠道（Anthropic Messages API 兼容，沉浸式翻译「Claude」；x-api-key/Bearer/?token= 鉴权）
  const claudeGuard = channelsCtrl.tokenAuth(store, 'anthropic');
  app.post('/v1/messages', claudeGuard, channelsCtrl.anthropicTranslate);
  app.post('/anthropic/v1/messages', claudeGuard, channelsCtrl.anthropicTranslate);

  // 渠道对外文档页（公开访问；后台可按渠道启用/禁用，禁用后对外 404）
  app.get('/azure', channelsCtrl.serveDocPage('azure'));
  app.get('/baidu', channelsCtrl.serveDocPage('baidu'));
  app.get('/imme', channelsCtrl.serveDocPage('imme'));
  app.get('/deeplx', channelsCtrl.serveDocPage('deeplx'));
  app.get('/google', channelsCtrl.serveDocPage('google'));
  app.get('/openai', channelsCtrl.serveDocPage('openai'));
  app.get('/claude', channelsCtrl.serveDocPage('claude'));

  // 用量统计（需网关鉴权）
  app.get('/usage', gatewayAuth(store), usageCtrl.usage);

  // 后台管理页面（静态；管理控制台禁止缓存，避免浏览器拿旧版页面导致功能"失效"假象）
  app.get('/admin', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin.html'));
  });
  // 后台管理接口（需登录会话）
  app.get('/admin/providers', adminAuth(store), adminCtrl.list);
  app.put('/admin/providers/:name', adminAuth(store), adminCtrl.update);
  app.post('/admin/providers/:name/test', adminAuth(store), adminCtrl.testProvider);
  // 同一服务商多 Key 实例（如 baidu-2）
  app.post('/admin/providers/:type/instances', adminAuth(store), adminCtrl.addInstance);
  app.delete('/admin/instances/:name', adminAuth(store), adminCtrl.removeInstance);
  app.get('/admin/settings', adminAuth(store), adminCtrl.getSettings);
  app.put('/admin/settings', adminAuth(store), adminCtrl.updateSettings);
  app.get('/admin/gateway', adminAuth(store), adminCtrl.getGateway);
  app.put('/admin/gateway', adminAuth(store), adminCtrl.updateGateway);
  app.get('/admin/usage/stats', adminAuth(store), adminCtrl.usageStats);
  // 翻译缓存（后台管理：开关/大小即时生效，统计与清空）
  app.get('/admin/cache', adminAuth(store), adminCtrl.getCache);
  app.put('/admin/cache', adminAuth(store), adminCtrl.updateCache);
  app.delete('/admin/cache', adminAuth(store), adminCtrl.clearCache);
  // 日志审计（后台管理）
  app.get('/admin/logs', adminAuth(store), adminCtrl.listLogs);
  app.delete('/admin/logs', adminAuth(store), adminCtrl.clearLogs);
  // 渠道文档启停（后台管理）
  app.get('/admin/docs', adminAuth(store), channelsCtrl.listDocs);
  app.put('/admin/docs/:channel', adminAuth(store), channelsCtrl.updateDoc);
};
