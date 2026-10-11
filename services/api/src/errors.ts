/** Typed API errors. Every route throws these rather than crafting replies,
 *  so the error envelope stays identical across the surface. */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, 'bad_request', msg, details);

export const unauthorized = (msg = 'Authentication required.') =>
  new ApiError(401, 'unauthorized', msg);

export const forbidden = (msg = 'You do not have permission to do that.') =>
  new ApiError(403, 'forbidden', msg);

export const notFound = (msg = 'Not found.') => new ApiError(404, 'not_found', msg);

export const conflict = (msg: string, details?: unknown) =>
  new ApiError(409, 'conflict', msg, details);

export const unprocessable = (msg: string, details?: unknown) =>
  new ApiError(422, 'unprocessable', msg, details);

export const tooManyRequests = (msg = 'Rate limit exceeded.') =>
  new ApiError(429, 'rate_limited', msg);
