'use strict';

/**
 * 类型化错误体系：客户端只应看到规范化结构 { error: { code, message } }，
 * 绝不返回堆栈或内部细节（由全局错误处理器统一处理）。
 */
class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code || this.name;
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message || 'Invalid request', 400, 'validation_error');
  }
}

class UnauthorizedError extends AppError {
  constructor(message) {
    super(message || 'Unauthorized', 401, 'unauthorized');
  }
}

class ForbiddenError extends AppError {
  constructor(message) {
    super(message || 'Forbidden', 403, 'forbidden');
  }
}

class NotFoundError extends AppError {
  constructor(message) {
    super(message || 'Not found', 404, 'not_found');
  }
}

// 上游翻译服务返回了业务错误（如限流、参数错误、鉴权失败）。
class UpstreamError extends AppError {
  constructor(message) {
    super(message, 502, 'upstream_error');
  }
}

// 所有可用服务商都失败（未配置 / 被禁用 / 全部报错）。
class ServiceUnavailableError extends AppError {
  constructor(message) {
    super(message || 'No available translation provider', 503, 'service_unavailable');
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  UpstreamError,
  ServiceUnavailableError,
};
