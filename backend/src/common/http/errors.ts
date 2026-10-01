import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * Uniform error envelope: { error: { code, message, details?, requestId } }.
 * Throw AppError (or its helpers) from services; never leak stack traces or SQL to clients.
 */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details),
  validation: (message: string, details?: unknown) => new AppError(422, 'validation_failed', message, details),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'unauthorized', message),
  forbidden: (message = 'You do not have permission to do that') => new AppError(403, 'forbidden', message),
  notFound: (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (message: string, details?: unknown) => new AppError(409, 'conflict', message, details),
  gone: (message: string) => new AppError(410, 'gone', message),
  tooMany: (message = 'Too many requests', details?: unknown) => new AppError(429, 'rate_limited', message, details),
  quota: (message: string, details?: unknown) => new AppError(402, 'quota_exceeded', message, details),
  unavailable: (message: string, details?: unknown) => new AppError(503, 'provider_unavailable', message, details),
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') return;
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();
    const requestId = String(req?.id ?? '');

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { code: string; message: string; details?: unknown } = {
      code: 'internal_error',
      message: 'Something went wrong',
    };

    if (exception instanceof AppError) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof ZodError) {
      status = 422;
      body = {
        code: 'validation_failed',
        message: 'Request validation failed',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      body = {
        code: typeof r === 'object' && r?.code ? r.code : httpCode(status),
        message: typeof r === 'string' ? r : Array.isArray(r?.message) ? r.message.join(', ') : r?.message ?? exception.message,
      };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') {
        status = 404;
        body = { code: 'not_found', message: 'Resource not found' };
      } else if (exception.code === 'P2002') {
        status = 409;
        body = { code: 'conflict', message: 'A resource with these values already exists' };
      } else {
        this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }

    if (status >= 500 && !(exception instanceof AppError)) {
      this.logger.error(`[${requestId}] ${req?.method} ${req?.url} → ${status}`);
    }
    reply.status(status).send({ error: { ...body, requestId } });
  }
}

function httpCode(status: number) {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}
