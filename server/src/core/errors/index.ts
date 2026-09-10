/**
 * @file server/src/core/errors/index.ts
 * @description 异常体系统一出口
 * @module core/errors
 * @author 软件开发团队
 * @created 2026-09-03
 */

export { AppError, isAppError } from './AppError';
export type { AppErrorOptions } from './AppError';

export { BusinessError } from './BusinessError';
export type { BusinessErrorOptions } from './BusinessError';

export { ValidationError } from './ValidationError';
export type { FieldError, ValidationErrorOptions } from './ValidationError';

export { AuthError } from './AuthError';
export type { AuthErrorOptions } from './AuthError';

export { NotFoundError } from './NotFoundError';
export type { NotFoundErrorOptions } from './NotFoundError';

export { ConflictError } from './ConflictError';
export type { ConflictErrorOptions } from './ConflictError';

export { RateLimitError } from './RateLimitError';
export type { RateLimitErrorOptions } from './RateLimitError';

export { ExternalServiceError } from './ExternalServiceError';
export type { AdapterType, ExternalServiceErrorOptions } from './ExternalServiceError';

export {
  ErrorCode,
  ERROR_META,
  getErrorMeta,
  isKnownErrorCode,
} from './errorCodes';
export type { ErrorCodeValue, ErrorMeta } from './errorCodes';
