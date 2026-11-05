'use strict';

const BaiduProvider = require('./baidu');
const AlibabaProvider = require('./alibaba');
const VolcengineProvider = require('./volcengine');
const AzureProvider = require('./azure');
const DeepLProvider = require('./deepl');

/**
 * 构建全部服务商实例：内置单实例 + 多 Key 自定义实例（provider_instances 表，如 baidu-2）。
 * 初始密钥从数据库读取；运行时由服务层热更新（改密钥无需重启）。
 */
function buildProviders(store) {
  const Klasses = {
    volcengine: VolcengineProvider,
    azure: AzureProvider,
    alibaba: AlibabaProvider,
    baidu: BaiduProvider,
    deepl: DeepLProvider,
  };
  const builtinOrder = ['volcengine', 'azure', 'alibaba', 'baidu', 'deepl'];
  const providers = [];
  // 内置实例：name 与类型同名
  for (const name of builtinOrder) {
    providers.push(new Klasses[name](store.getSecrets(name), name));
  }
  // 多 Key 实例：name 形如 <type>-N，用对应类型适配器 + 实例名
  for (const inst of store.listInstances()) {
    const K = Klasses[inst.type];
    if (!K) continue; // 未知类型跳过，避免崩溃
    providers.push(new K(store.getSecrets(inst.name), inst.name));
  }
  return providers;
}

module.exports = { buildProviders };
