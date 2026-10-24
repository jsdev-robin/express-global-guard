import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import createError, { type HttpError } from 'http-errors';
import { StatusCodes } from 'http-status-codes';

interface FieldError {
  field: string;
  message: string;
}

interface RawError extends Error {
  code?: string | number;
  path?: string;
  kind?: string;
  keyValue?: Record<string, unknown>;
  errors?: Record<string, { path?: string; message: string }>;
  issues?: { path: PropertyKey[]; message: string }[];
}

interface ApiErrorOptions {
  code?: string;
  errors?: FieldError[];
  expose?: boolean;
  headers?: Record<string, string>;
}

type ApiError = HttpError & { code?: string; errors?: FieldError[] };
type Handler = (err: RawError) => ApiError;
type RequestWithUser = Request & { userId?: string };

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
} as const;

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

const build = (
  statusCode: number,
  message: string,
  options: ApiErrorOptions = {},
): ApiError => createError(statusCode, message, options) as ApiError;

const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

const joinMessages = (errors: FieldError[]): string =>
  errors.map((e) => sentence(e.message)).join(' ');

const quoteList = (items: string[]): string =>
  items.map((item) => `"${item}"`).join(', ');

const handleCastError: Handler = (err) =>
  build(
    StatusCodes.BAD_REQUEST,
    err.path
      ? `The value you entered for "${err.path}" doesn't look right. Please check it and try again.`
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
  const entries = err.errors
    ? Object.values(err.errors)
    : [{ path: err.path, message: err.message }];
  const errors = entries.map((entry) => ({
    field: entry.path ?? '',
    message: entry.message,
  }));
  return build(
    StatusCodes.UNPROCESSABLE_ENTITY,
    `Please fix the following and try again: ${joinMessages(errors)}`,
    { code: 'VALIDATION_FAILED', errors },
  );
};

const handleZodError: Handler = (err) => {
  const errors = (err.issues ?? []).map((issue) => ({
    field: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return build(
    StatusCodes.UNPROCESSABLE_ENTITY,
    `Please fix the following and try again: ${joinMessages(errors)}`,
    { code: 'VALIDATION_FAILED', errors },
  );
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
        expose: true,
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

const HANDLERS = new Map<string, Handler>();

const register = (names: string[], handler: Handler): void => {
  for (const name of names) HANDLERS.set(name, handler);
};

register(['CastError'], handleCastError);
register(['ValidationError', 'ValidatorError'], handleValidationError);
register(['ZodError'], handleZodError);
register(['DocumentNotFoundError'], handleDocumentNotFound);
register(['StrictModeError', 'StrictPopulateError'], handleStrictMode);
register(
  ['ObjectParameterError', 'BSONError', 'BSONTypeError'],
  handleBadInput,
);
register(['VersionError', 'ParallelSaveError'], handleConflict);
register(['MongoServerError', 'MongoBulkWriteError'], handleMongoServerError);
register(
  [
    'DisconnectedError',
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoServerSelectionError',
    'MongooseServerSelectionError',
    'MongoTopologyClosedError',
    'MongoNotConnectedError',
    'MongoPoolClearedError',
    'MongoPoolClosedError',
  ],
  handleDatabaseUnavailable,
);
register(
  [
    'ClientClosedError',
    'ClientOfflineError',
    'ConnectionTimeoutError',
    'SocketClosedUnexpectedlyError',
    'SocketTimeoutError',
    'ReconnectStrategyError',
  ],
  handleCacheUnavailable,
);
register(['MulterError'], handleMulterError);
register(['JsonWebTokenError'], handleInvalidToken);
register(['TokenExpiredError'], handleExpiredToken);
register(['NotBeforeError'], handleInactiveToken);
register(['URIError'], handleMalformedUrl);

const toRawError = (value: unknown): RawError => {
  if (value instanceof Error) return value as RawError;
  return new Error(
    typeof value === 'string' ? value : MESSAGES.unknown,
  ) as RawError;
};

const normalizeError = (err: RawError): ApiError => {
  if (createError.isHttpError(err)) return err as ApiError;

  const handler = HANDLERS.get(err.name);
  if (handler) return handler(err);

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

const logError = (
  raw: RawError,
  req: RequestWithUser,
  statusCode: number,
): void => {
  if (statusCode < StatusCodes.INTERNAL_SERVER_ERROR) return;
  console.error(
    JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      statusCode,
      requestId: req.get('x-request-id'),
      userId: req.userId,
      name: raw.name,
      message: raw.message,
      stack: raw.stack,
    }),
  );
};

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

  logError(raw, req as RequestWithUser, statusCode);

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

  const requestId = req.get('x-request-id');
  if (requestId) body.requestId = requestId;

  if (isDev) {
    body.debug = { name: raw.name, message: raw.message, stack: raw.stack };
  }

  res.status(statusCode).json(body);
};

export const registerProcessErrorHandlers = (
  shutdown: () => Promise<void> | void,
): void => {
  let shuttingDown = false;

  const exit = async (reason: string, error?: unknown): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (error) {
      const raw = toRawError(error);
      console.error(
        JSON.stringify({
          level: 'fatal',
          time: new Date().toISOString(),
          reason,
          name: raw.name,
          message: raw.message,
          stack: raw.stack,
        }),
      );
    }

    setTimeout(() => process.exit(1), 10_000).unref();

    try {
      await shutdown();
    } catch (shutdownError) {
      console.error(shutdownError);
    } finally {
      process.exit(error ? 1 : 0);
    }
  };

  process.on('unhandledRejection', (reason) => {
    void exit('unhandledRejection', reason);
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
