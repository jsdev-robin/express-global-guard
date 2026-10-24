import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import createError, { type HttpError } from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

interface RequestStore {
  requestId: string;
}

interface FieldError {
  field: string;
  message: string;
}

interface RawIssue {
  path?: string;
  kind?: string;
  name?: string;
  message: string;
}

interface RawError extends Error {
  code?: string | number;
  path?: string;
  kind?: string;
  keyValue?: Record<string, unknown>;
  errors?: Record<string, RawIssue>;
  issues?: { path: PropertyKey[]; message: string }[];
}

interface ApiErrorOptions {
  code?: string;
  errors?: FieldError[];
  expose?: boolean;
  headers?: Record<string, string>;
}

interface Rule {
  test: (err: RawError) => boolean;
  handle: Handler;
}

export interface ErrorContext {
  requestId?: string;
  method?: string;
  path?: string;
  userId?: string;
  statusCode?: number;
  fatal?: boolean;
}

export type ErrorReporter = (
  error: Error,
  context: ErrorContext,
) => void | Promise<void>;

type ApiError = HttpError & { code?: string; errors?: FieldError[] };
type Handler = (err: RawError) => ApiError;
type RequestWithUser = Request & { userId?: string };

const storage = new AsyncLocalStorage<RequestStore>();
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

export const getRequestId = (): string | undefined =>
  storage.getStore()?.requestId;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  base: { service: process.env.SERVICE_NAME ?? 'api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  mixin: () => ({ requestId: getRequestId() }),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.authorization',
      '*.cookie',
    ],
    censor: '[REDACTED]',
  },
  transport: isDevelopment
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  storage.run({ requestId: id }, next);
};

const MESSAGES = {
  generic:
    'Oops! Something went wrong on our end. Please try again in a little while.',
  unknown:
    'Oops! Something unexpected happened. Please try again in a little while.',
  notFound:
    "We couldn't find what you were looking for. It may have been moved or removed.",
  badInput:
    "Something in your request doesn't look right. Please check your input and try again.",
  conflict:
    'Someone else just updated this. Please refresh the page and try again.',
  writeConflict:
    'We hit a small snag while saving your changes. Please try again.',
  dbValidation:
    "Some of the information doesn't meet our requirements. Please review it and try again.",
  dbTimeout:
    'This is taking longer than expected. Please try again in a moment.',
  dbUnavailable:
    "We're having trouble reaching our servers right now. Please try again in a few moments.",
  busy: "We're a little busy right now. Please try again in a few moments.",
  serviceUnavailable:
    "We're having trouble connecting to one of our services. Please try again shortly.",
  gatewayTimeout:
    'A service took too long to respond. Please try again in a moment.',
  fileTooLarge: 'That file is too large. Please choose a smaller one.',
  tooManyFiles:
    "You've selected too many files. Please remove a few and try again.",
  unexpectedFile:
    "That file couldn't be accepted here. Please check the upload field and try again.",
  uploadFailed:
    "We couldn't process your upload. Please check the file and try again.",
  invalidToken: 'Your session is no longer valid. Please log in again.',
  expiredToken: 'Your session has expired. Please log in again.',
  inactiveToken: "Your session isn't active yet. Please try again shortly.",
  malformedUrl:
    'That link looks broken. Please check the address and try again.',
  bodyParseFailed:
    "We couldn't read your request. Please check the format and try again.",
  payloadTooLarge:
    'Your request is too large. Please send less data and try again.',
  unsupportedBody:
    "We can't read the format of your request. Please try a different one.",
  requestAborted: 'Your request was interrupted. Please try again.',
} as const;

const HTTP_TYPES: Record<string, { message: string; code: string }> = {
  'entity.parse.failed': {
    message: MESSAGES.bodyParseFailed,
    code: 'INVALID_BODY',
  },
  'request.size.invalid': {
    message: MESSAGES.bodyParseFailed,
    code: 'INVALID_BODY',
  },
  'entity.too.large': {
    message: MESSAGES.payloadTooLarge,
    code: 'PAYLOAD_TOO_LARGE',
  },
  'encoding.unsupported': {
    message: MESSAGES.unsupportedBody,
    code: 'UNSUPPORTED_BODY',
  },
  'charset.unsupported': {
    message: MESSAGES.unsupportedBody,
    code: 'UNSUPPORTED_BODY',
  },
  'request.aborted': {
    message: MESSAGES.requestAborted,
    code: 'REQUEST_ABORTED',
  },
};

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

let reporter: ErrorReporter | undefined;

export const setErrorReporter = (fn: ErrorReporter | undefined): void => {
  reporter = fn;
};

const report = (error: Error, context: ErrorContext): void => {
  if (!reporter) return;
  try {
    const result = reporter(error, context);
    if (result instanceof Promise) {
      result.catch((reporterError: unknown) =>
        logger.error({ err: reporterError }, 'error reporter failed'),
      );
    }
  } catch (reporterError) {
    logger.error({ err: reporterError }, 'error reporter failed');
  }
};

const reportAndWait = async (
  error: Error,
  context: ErrorContext,
  timeoutMs: number,
): Promise<void> => {
  if (!reporter) return;
  try {
    await Promise.race([
      Promise.resolve(reporter(error, context)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  } catch (reporterError) {
    logger.error({ err: reporterError }, 'error reporter failed');
  }
};

const build = (
  statusCode: number,
  message: string,
  options: ApiErrorOptions = {},
): ApiError => createError(statusCode, message, options) as ApiError;

const sentence = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const humanize = (field: string): string => {
  const last =
    field
      .split('.')
      .filter((segment) => segment && !/^\d+$/.test(segment))
      .pop() ?? 'This field';
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const quoteList = (items: string[]): string =>
  items.map((item) => `"${item}"`).join(', ');

const describeIssue = (issue: RawIssue): string => {
  const label = humanize(issue.path ?? '');
  if (issue.name === 'CastError') return `${label} has an invalid value.`;
  switch (issue.kind) {
    case 'required':
      return `${label} is required.`;
    case 'minlength':
      return `${label} is too short.`;
    case 'maxlength':
      return `${label} is too long.`;
    case 'min':
      return `${label} is too small.`;
    case 'max':
      return `${label} is too large.`;
    case 'enum':
      return `${label} has an option we don't recognize.`;
    default:
      return sentence(issue.message);
  }
};

const summarize = (errors: FieldError[]): string =>
  `Please fix the following and try again: ${errors
    .map((e) => e.message)
    .join(' ')}`;

const handleCastError: Handler = (err) =>
  build(
    StatusCodes.BAD_REQUEST,
    err.path
      ? `${humanize(err.path)} has an invalid value. Please check it and try again.`
      : MESSAGES.badInput,
    {
      code: 'INVALID_FIELD',
      errors: [
        {
          field: err.path ?? '',
          message: `Expected a valid ${err.kind ?? 'value'}.`,
        },
      ],
    },
  );

const handleValidationError: Handler = (err) => {
  const issues: RawIssue[] = err.errors
    ? Object.values(err.errors)
    : [{ path: err.path, message: err.message }];
  const errors = issues.map((issue) => ({
    field: issue.path ?? '',
    message: describeIssue(issue),
  }));
  return build(StatusCodes.UNPROCESSABLE_ENTITY, summarize(errors), {
    code: 'VALIDATION_FAILED',
    errors,
  });
};

const handleZodError: Handler = (err) => {
  const errors = (err.issues ?? []).map((issue) => {
    const field = issue.path.map(String).join('.');
    return {
      field,
      message: field
        ? `${humanize(field)}: ${sentence(issue.message)}`
        : sentence(issue.message),
    };
  });
  return build(StatusCodes.UNPROCESSABLE_ENTITY, summarize(errors), {
    code: 'VALIDATION_FAILED',
    errors,
  });
};

const handleDocumentNotFound: Handler = () =>
  build(StatusCodes.NOT_FOUND, MESSAGES.notFound, { code: 'NOT_FOUND' });

const handleStrictMode: Handler = (err) =>
  build(
    StatusCodes.BAD_REQUEST,
    err.path
      ? `"${err.path}" isn't something we can accept here. Please remove it and try again.`
      : "Your request includes something we can't accept. Please review it and try again.",
    { code: 'FIELD_NOT_ALLOWED' },
  );

const handleBadInput: Handler = () =>
  build(StatusCodes.BAD_REQUEST, MESSAGES.badInput, { code: 'INVALID_INPUT' });

const handleConflict: Handler = () =>
  build(StatusCodes.CONFLICT, MESSAGES.conflict, { code: 'CONFLICT' });

const handleDuplicateKey: Handler = (err) => {
  const fields = Object.keys(err.keyValue ?? {});
  const message = fields.length
    ? `Looks like ${quoteList(fields)} already exists. Please use a different value.`
    : 'Looks like that already exists. Please use a different value.';
  return build(StatusCodes.CONFLICT, message, {
    code: 'DUPLICATE_KEY',
    errors: fields.map((field) => ({
      field,
      message: 'This value is already taken.',
    })),
  });
};

const handleMongoServerError: Handler = (err) => {
  switch (err.code) {
    case 11000:
    case 11001:
      return handleDuplicateKey(err);
    case 121:
      return build(StatusCodes.UNPROCESSABLE_ENTITY, MESSAGES.dbValidation, {
        code: 'DB_VALIDATION_FAILED',
      });
    case 112:
      return build(StatusCodes.CONFLICT, MESSAGES.writeConflict, {
        code: 'WRITE_CONFLICT',
      });
    case 50:
      return build(StatusCodes.GATEWAY_TIMEOUT, MESSAGES.dbTimeout, {
        code: 'DB_TIMEOUT',
        expose: true,
      });
    default:
      return build(StatusCodes.INTERNAL_SERVER_ERROR, MESSAGES.generic);
  }
};

const handleDatabaseUnavailable: Handler = () =>
  build(StatusCodes.SERVICE_UNAVAILABLE, MESSAGES.dbUnavailable, {
    code: 'DB_UNAVAILABLE',
    expose: true,
    headers: { 'Retry-After': '5' },
  });

const handleCacheUnavailable: Handler = () =>
  build(StatusCodes.SERVICE_UNAVAILABLE, MESSAGES.busy, {
    code: 'SERVICE_UNAVAILABLE',
    expose: true,
    headers: { 'Retry-After': '5' },
  });

const handleMulterError: Handler = (err) => {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return build(StatusCodes.REQUEST_TOO_LONG, MESSAGES.fileTooLarge, {
        code: 'FILE_TOO_LARGE',
      });
    case 'LIMIT_FILE_COUNT':
      return build(StatusCodes.BAD_REQUEST, MESSAGES.tooManyFiles, {
        code: 'TOO_MANY_FILES',
      });
    case 'LIMIT_UNEXPECTED_FILE':
      return build(StatusCodes.BAD_REQUEST, MESSAGES.unexpectedFile, {
        code: 'UNEXPECTED_FILE',
      });
    default:
      return build(StatusCodes.BAD_REQUEST, MESSAGES.uploadFailed, {
        code: 'UPLOAD_FAILED',
      });
  }
};

const handleInvalidToken: Handler = () =>
  build(StatusCodes.UNAUTHORIZED, MESSAGES.invalidToken, {
    code: 'INVALID_TOKEN',
  });

const handleExpiredToken: Handler = () =>
  build(StatusCodes.UNAUTHORIZED, MESSAGES.expiredToken, {
    code: 'TOKEN_EXPIRED',
  });

const handleInactiveToken: Handler = () =>
  build(StatusCodes.UNAUTHORIZED, MESSAGES.inactiveToken, {
    code: 'TOKEN_NOT_ACTIVE',
  });

const handleMalformedUrl: Handler = () =>
  build(StatusCodes.BAD_REQUEST, MESSAGES.malformedUrl, {
    code: 'MALFORMED_URL',
  });

const handleSystemError = (err: RawError): ApiError | undefined => {
  if (typeof err.code !== 'string') return undefined;
  if (UNAVAILABLE_CODES.has(err.code)) {
    return build(StatusCodes.SERVICE_UNAVAILABLE, MESSAGES.serviceUnavailable, {
      code: 'SERVICE_UNAVAILABLE',
      expose: true,
    });
  }
  if (TIMEOUT_CODES.has(err.code)) {
    return build(StatusCodes.GATEWAY_TIMEOUT, MESSAGES.gatewayTimeout, {
      code: 'GATEWAY_TIMEOUT',
      expose: true,
    });
  }
  return undefined;
};

const byName =
  (...names: string[]) =>
  (err: RawError): boolean =>
    names.includes(err.name);

const byPattern =
  (pattern: RegExp) =>
  (err: RawError): boolean =>
    pattern.test(err.name);

const RULES: Rule[] = [
  { test: byName('CastError'), handle: handleCastError },
  {
    test: byName('ValidationError', 'ValidatorError'),
    handle: handleValidationError,
  },
  { test: byName('ZodError'), handle: handleZodError },
  { test: byName('DocumentNotFoundError'), handle: handleDocumentNotFound },
  {
    test: byName('StrictModeError', 'StrictPopulateError'),
    handle: handleStrictMode,
  },
  {
    test: byName('ObjectParameterError', 'BSONError', 'BSONTypeError'),
    handle: handleBadInput,
  },
  {
    test: byName('VersionError', 'ParallelSaveError'),
    handle: handleConflict,
  },
  {
    test: byName('MongoServerError', 'MongoBulkWriteError'),
    handle: handleMongoServerError,
  },
  {
    test: (err) =>
      err.name === 'DisconnectedError' ||
      /^(Mongo|Mongoose).*(Network|ServerSelection|Topology|PoolCleared|PoolClosed|NotConnected)/.test(
        err.name,
      ),
    handle: handleDatabaseUnavailable,
  },
  {
    test: byPattern(
      /^(ClientClosed|ClientOffline|ConnectionTimeout|SocketClosed|SocketTimeout|Reconnect)/,
    ),
    handle: handleCacheUnavailable,
  },
  { test: byName('MulterError'), handle: handleMulterError },
  { test: byName('JsonWebTokenError'), handle: handleInvalidToken },
  { test: byName('TokenExpiredError'), handle: handleExpiredToken },
  { test: byName('NotBeforeError'), handle: handleInactiveToken },
  { test: byName('URIError'), handle: handleMalformedUrl },
];

const toRawError = (value: unknown): RawError => {
  if (value instanceof Error) return value as RawError;
  return new Error(
    typeof value === 'string' && value ? value : MESSAGES.unknown,
  ) as RawError;
};

const refineHttpError = (err: ApiError): ApiError => {
  const type = (err as { type?: unknown }).type;
  const known = typeof type === 'string' ? HTTP_TYPES[type] : undefined;
  if (!known) return err;
  return build(err.statusCode, known.message, {
    code: known.code,
    expose: true,
  });
};

const normalizeError = (err: RawError): ApiError => {
  if (createError.isHttpError(err)) return refineHttpError(err as ApiError);

  const rule = RULES.find((candidate) => candidate.test(err));
  if (rule) return rule.handle(err);

  if (err.code === 11000 || err.code === 11001) return handleDuplicateKey(err);

  const systemError = handleSystemError(err);
  if (systemError) return systemError;

  return build(
    StatusCodes.INTERNAL_SERVER_ERROR,
    err.message || MESSAGES.generic,
  );
};

const resolveStatusCode = (err: ApiError): number =>
  err.statusCode >= 400 && err.statusCode <= 599
    ? err.statusCode
    : StatusCodes.INTERNAL_SERVER_ERROR;

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(
    createError(
      StatusCodes.NOT_FOUND,
      `We couldn't find ${req.method} ${req.path}. Please check the address and try again.`,
    ),
  );
};

export const globalErrorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) return next(err);

  const raw = toRawError(err);
  const apiError = normalizeError(raw);
  const statusCode = resolveStatusCode(apiError);
  const isDev = process.env.NODE_ENV === 'development';
  const currentRequestId =
    (res.locals.requestId as string | undefined) ?? getRequestId();
  const userId = (req as RequestWithUser).userId;

  if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
    logger.error(
      { err: raw, method: req.method, path: req.path, statusCode, userId },
      'request failed',
    );
    report(raw, {
      requestId: currentRequestId,
      method: req.method,
      path: req.path,
      userId,
      statusCode,
    });
  } else {
    logger.warn(
      {
        errName: raw.name,
        errMessage: raw.message,
        method: req.method,
        path: req.path,
        statusCode,
        userId,
      },
      'request rejected',
    );
  }

  res.set('Cache-Control', 'no-store');
  if (apiError.headers) res.set(apiError.headers);

  const body: Record<string, unknown> = {
    status: statusCode >= StatusCodes.INTERNAL_SERVER_ERROR ? 'error' : 'fail',
    message: isDev || apiError.expose ? apiError.message : MESSAGES.generic,
  };

  if (apiError.expose && typeof apiError.code === 'string') {
    body.code = apiError.code;
  }
  if (apiError.expose && apiError.errors?.length) {
    body.errors = apiError.errors;
  }
  if (currentRequestId) body.requestId = currentRequestId;
  if (isDev) {
    body.debug = { name: raw.name, message: raw.message, stack: raw.stack };
  }

  res.status(statusCode).json(body);
};

export const registerProcessErrorHandlers = (
  shutdown: () => Promise<void> | void,
  timeoutMs = 10_000,
): void => {
  let shuttingDown = false;

  const exit = async (reason: string, error?: unknown): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    const raw = error === undefined ? undefined : toRawError(error);

    if (raw) {
      logger.fatal({ err: raw, reason }, 'fatal error, shutting down');
      await reportAndWait(raw, { fatal: true }, 2_000);
    } else {
      logger.info({ reason }, 'shutdown signal received');
    }

    setTimeout(() => process.exit(1), timeoutMs).unref();

    let exitCode = raw ? 1 : 0;
    try {
      await shutdown();
    } catch (shutdownError) {
      exitCode = 1;
      logger.error({ err: shutdownError }, 'shutdown failed');
    }
    process.exit(exitCode);
  };

  process.on('unhandledRejection', (reason) => {
    void exit('unhandledRejection', reason ?? 'Unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    void exit('uncaughtException', error);
  });
  process.on('SIGTERM', () => {
    void exit('SIGTERM');
  });
  process.on('SIGINT', () => {
    void exit('SIGINT');
  });
};
