import { NextFunction, Request, RequestHandler, Response } from 'express';
import createError, { HttpError, isHttpError } from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import pino, { Logger } from 'pino';

export interface CustomError extends Error {
  statusCode?: number;
  status?: number;
  errStatus?: string;
  path?: string;
  value?: string;
  code?: number;
  errors?: Record<string, { message: string }>;
  reason?: unknown;
  headers?: Record<string, string>;
}

type ErrorTransformer = (err: CustomError) => HttpError;
type Environment = 'development' | 'staging' | 'production' | 'test';

const ENV = (process.env.NODE_ENV ?? 'production') as Environment;
const IS_DEV = ENV === 'development';
const IS_STAGING = ENV === 'staging';

const transport = process.stdout.isTTY
  ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
  : {};

const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.SERVICE_NAME ?? 'api',
    env: ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...transport,
});

const sanitizeStatusCode = (code: unknown): number => {
  const num = Number(code);
  return Number.isInteger(num) && num >= 100 && num <= 599
    ? num
    : StatusCodes.INTERNAL_SERVER_ERROR;
};

const normalizeError = (err: unknown): CustomError => {
  if (err instanceof Error) return err as CustomError;
  if (typeof err === 'string') return new Error(err) as CustomError;
  if (err !== null && typeof err === 'object') {
    const e = new Error(
      String((err as Record<string, unknown>).message ?? 'Unknown error'),
    ) as CustomError;
    Object.assign(e, err);
    return e;
  }
  return new Error('Unknown error occurred') as CustomError;
};

const getClientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown';
};

const getRequestId = (req: Request): string =>
  (req.headers['x-request-id'] as string) ??
  (req.headers['x-correlation-id'] as string) ??
  crypto.randomUUID();

const handleInvalidFieldError: ErrorTransformer = (err) =>
  createError(
    StatusCodes.BAD_REQUEST,
    `Invalid input for "${err.path}": "${err.value}". Provide valid data.`,
  );

const handleDuplicateValueError: ErrorTransformer = () =>
  createError(
    StatusCodes.CONFLICT,
    'Duplicate entry detected. Provide a unique value.',
  );

const handleInputValidationError: ErrorTransformer = (err) => {
  const messages = Object.values(err.errors ?? {})
    .map((e) => e.message)
    .join('. ');
  return createError(
    StatusCodes.UNPROCESSABLE_ENTITY,
    `Validation errors: ${messages}`,
  );
};

const handleDocumentNotFoundError: ErrorTransformer = () =>
  createError(StatusCodes.NOT_FOUND, 'Requested resource not found.');

const handleStrictModeError: ErrorTransformer = (err) =>
  createError(
    StatusCodes.BAD_REQUEST,
    `Field "${err.path}" is not allowed by strict schema.`,
  );

const handleMissingSchemaError: ErrorTransformer = (err) =>
  createError(
    StatusCodes.INTERNAL_SERVER_ERROR,
    `Schema missing: ${err.message}`,
  );

const handleDisconnectedError: ErrorTransformer = () =>
  createError(
    StatusCodes.SERVICE_UNAVAILABLE,
    'Database connection lost. Try again later.',
  );

const handleInvalidTokenError: ErrorTransformer = () =>
  createError(StatusCodes.UNAUTHORIZED, 'Invalid session token.');

const handleExpiredTokenError: ErrorTransformer = () =>
  createError(StatusCodes.UNAUTHORIZED, 'Session token expired.');

const handleInactiveTokenError: ErrorTransformer = () =>
  createError(StatusCodes.UNAUTHORIZED, 'Token not yet active.');

const handleMongoServerError: ErrorTransformer = (err) =>
  err.code === 11000
    ? handleDuplicateValueError(err)
    : createError(StatusCodes.INTERNAL_SERVER_ERROR, 'Database server error.');

const handleNodeError: ErrorTransformer = (err) => {
  switch (err.name) {
    case 'SyntaxError':
      return createError(
        StatusCodes.BAD_REQUEST,
        `Syntax error: ${err.message}`,
      );
    case 'TypeError':
      return createError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        `Type error: ${err.message}`,
      );
    case 'ReferenceError':
      return createError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        `Reference error: ${err.message}`,
      );
    case 'RangeError':
      return createError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        `Range error: ${err.message}`,
      );
    case 'EvalError':
      return createError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        `Eval error: ${err.message}`,
      );
    case 'URIError':
      return createError(StatusCodes.BAD_REQUEST, `URI error: ${err.message}`);
    default:
      return isHttpError(err)
        ? err
        : createError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            'Internal server error.',
          );
  }
};

const errorTransformers: Readonly<Record<string, ErrorTransformer>> =
  Object.freeze({
    CastError: handleInvalidFieldError,
    ValidationError: handleInputValidationError,
    DocumentNotFoundError: handleDocumentNotFoundError,
    StrictModeError: handleStrictModeError,
    MissingSchemaError: handleMissingSchemaError,
    DisconnectedError: handleDisconnectedError,
    JsonWebTokenError: handleInvalidTokenError,
    TokenExpiredError: handleExpiredTokenError,
    NotBeforeError: handleInactiveTokenError,
  });

const resolveError = (err: CustomError): HttpError => {
  const transform = errorTransformers[err.name];
  if (transform) return transform(err);
  if (err.code === 11000 || err.name === 'MongoServerError') {
    return handleMongoServerError(err);
  }
  return handleNodeError(err);
};

const sendError = (
  err: HttpError & CustomError,
  res: Response,
  requestId: string,
): void => {
  const statusCode = sanitizeStatusCode(err.status ?? err.statusCode);
  const status = err.errStatus ?? (statusCode >= 500 ? 'error' : 'fail');

  res.setHeader('X-Request-Id', requestId);

  if (err.headers) {
    Object.entries(err.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
  }

  if (IS_DEV) {
    res
      .status(statusCode)
      .json({ status, message: err.message, stack: err.stack, requestId });
    return;
  }

  if (IS_STAGING && err.expose) {
    res.status(statusCode).json({ status, message: err.message, requestId });
    return;
  }

  if (err.expose) {
    res.status(statusCode).json({ status, message: err.message, requestId });
    return;
  }

  res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
    status: 'error',
    message: 'Something went wrong. Try again later.',
    requestId,
  });
};

export const catchAsync =
  (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  ): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const globalErrorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = getRequestId(req);
  const incoming = normalizeError(err);
  const resolved = resolveError(incoming);
  const statusCode = sanitizeStatusCode(resolved.status ?? resolved.statusCode);

  const logData = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    ip: getClientIp(req),
    userId: (req as Request & { user?: { id?: string } }).user?.id,
    statusCode,
    message: incoming.message,
    stack: incoming.stack,
  };

  if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
    logger.error(logData, 'Internal server error');
  } else if (statusCode >= StatusCodes.BAD_REQUEST) {
    logger.warn(logData, 'Client error');
  }

  sendError(resolved, res, requestId);
};

export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(
    createError(
      StatusCodes.NOT_FOUND,
      `Can't find ${req.originalUrl} on this server!`,
    ),
  );
};

const SHUTDOWN_TIMEOUT_MS = 10_000;

const performGracefulShutdown = (
  server: { close: (cb?: () => void) => void },
  exitCode: number,
): void => {
  const timer = setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);

  timer.unref();

  server.close(() => {
    logger.info('Server closed gracefully.');
    process.exit(exitCode);
  });
};

export const registerProcessErrorHandlers = (server?: {
  close: (cb?: () => void) => void;
}): void => {
  if (process.listenerCount('unhandledRejection') > 0) return;

  process.on('unhandledRejection', (reason) => {
    const err = normalizeError(reason);
    logger.fatal({ stack: err.stack }, `Unhandled Rejection: ${err.message}`);
    if (server) {
      performGracefulShutdown(server, 1);
    } else {
      process.exit(1);
    }
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ stack: err.stack }, `Uncaught Exception: ${err.message}`);
    if (server) {
      performGracefulShutdown(server, 1);
    } else {
      process.exit(1);
    }
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received.');
    if (server) {
      performGracefulShutdown(server, 0);
    } else {
      process.exit(0);
    }
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received.');
    if (server) {
      performGracefulShutdown(server, 0);
    } else {
      process.exit(0);
    }
  });
};
