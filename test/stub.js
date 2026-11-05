'use strict';
// 本地桩 DeepL 服务：仅用于自测，模拟 DeepL /v2/translate（表单编码）返回。
// 网关的 deepl 适配器会把 baseUrl 指向本桩，从而在“无真实密钥”下验证路由/统计/禁用全链路。
const http = require('http');
const qs = require('querystring');

const port = Number(process.argv[2] || 3999);
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const params = qs.parse(body);
      let texts = params.text;
      if (texts == null) texts = [];
      if (!Array.isArray(texts)) texts = [texts];
      const translations = texts.map((t) => ({
        text: '[stub]' + t,
        detected_source_language: 'EN',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ translations }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
});
server.listen(port, () => console.log('STUB_READY ' + port));
