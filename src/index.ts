import { NextFunction, Request, Response } from 'express';
import { HTTPException } from 'express-http-exception';
import { StatusCodes } from 'http-status-codes';

interface CustomError extends Error {
  statusCode?: number;
  status?: string;
  isOperational?: boolean;
  path?: string;
  value?: string;
  code?: number;
  errmsg?: string;
  errors?: Record<string, { message: string }>;
  reason?: unknown;
}

const handleInvalidFieldError = (err: CustomError) =>
  new HTTPException(
    `Invalid input for "${err.path}": "${err.value}". Provide valid data.`,
    StatusCodes.BAD_REQUEST,
  );

const handleDuplicateValueError = () =>
  new HTTPException(
    'Duplicate entry detected. Provide a unique value.',
    StatusCodes.CONFLICT,
  );

const handleInputValidationError = (err: CustomError) => {
  const messages = Object.values(err.errors ?? {})
    .map((e) => e.message)
    .join('. ');
  return new HTTPException(
    `Validation errors: ${messages}`,
    StatusCodes.UNPROCESSABLE_ENTITY,
  );
};

const handleDocumentNotFoundError = () =>
  new HTTPException('Requested resource not found.', StatusCodes.NOT_FOUND);

const handleStrictModeError = (err: CustomError) =>
  new HTTPException(
    `Field "${err.path}" is not allowed by strict schema.`,
    StatusCodes.BAD_REQUEST,
  );

const handleMissingSchemaError = (err: CustomError) =>
  new HTTPException(
    `Schema missing: ${err.message}`,
    StatusCodes.INTERNAL_SERVER_ERROR,
  );

const handleDisconnectedError = () =>
  new HTTPException(
    'Database connection lost. Try again later.',
    StatusCodes.SERVICE_UNAVAILABLE,
  );

const handleInvalidTokenError = () =>
  new HTTPException('Invalid session token.', StatusCodes.UNAUTHORIZED);

const handleExpiredTokenError = () =>
  new HTTPException('Session token expired.', StatusCodes.UNAUTHORIZED);

const handleInactiveTokenError = () =>
  new HTTPException('Token not yet active.', StatusCodes.UNAUTHORIZED);

const handleMongoServerError = (err: CustomError) => {
  if (err.code === 11000) return handleDuplicateValueError();
  return new HTTPException(
    'Database server error.',
    StatusCodes.INTERNAL_SERVER_ERROR,
  );
};

const handleNodeError = (err: CustomError) => {
  switch (err.name) {
    case 'SyntaxError':
      return new HTTPException(
        `Syntax error: ${err.message}`,
        StatusCodes.BAD_REQUEST,
      );
    case 'TypeError':
      return new HTTPException(
        `Type error: ${err.message}`,
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    case 'ReferenceError':
      return new HTTPException(
        `Reference error: ${err.message}`,
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    case 'RangeError':
      return new HTTPException(
        `Range error: ${err.message}`,
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    case 'EvalError':
      return new HTTPException(
        `Eval error: ${err.message}`,
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    case 'URIError':
      return new HTTPException(
        `URI error: ${err.message}`,
        StatusCodes.BAD_REQUEST,
      );
    default:
      return err instanceof HTTPException
        ? err
        : new HTTPException(
            'Internal server error.',
            StatusCodes.INTERNAL_SERVER_ERROR,
          );
  }
};

const sendError = (err: CustomError, res: Response, isDev: boolean) => {
  const statusCode = err.statusCode ?? StatusCodes.INTERNAL_SERVER_ERROR;
  const status = err.status ?? 'error';

  if (isDev) {
    res.status(statusCode).json({
      status,
      error: err,
      message: err.message,
      stack: err.stack,
    });
  } else {
    if (err.isOperational) {
      res.status(statusCode).json({ status, message: err.message });
    } else {
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        status: 'error',
        message: 'Something went wrong. Try again later.',
      });
    }
  }
};

export const globalErrorHandler = (
  err: CustomError,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  err.statusCode = err.statusCode ?? StatusCodes.INTERNAL_SERVER_ERROR;
  err.status = err.status ?? 'error';
  const isDev = process.env.NODE_ENV === 'development';

  if (!err)
    err = new HTTPException(
      'Unknown error occurred',
      StatusCodes.INTERNAL_SERVER_ERROR,
    );

  switch (err.name) {
    case 'CastError':
      err = handleInvalidFieldError(err);
      break;
    case 'ValidationError':
      err = handleInputValidationError(err);
      break;
    case 'DocumentNotFoundError':
      err = handleDocumentNotFoundError();
      break;
    case 'StrictModeError':
      err = handleStrictModeError(err);
      break;
    case 'MissingSchemaError':
      err = handleMissingSchemaError(err);
      break;
    case 'DisconnectedError':
      err = handleDisconnectedError();
      break;
    case 'JsonWebTokenError':
      err = handleInvalidTokenError();
      break;
    case 'TokenExpiredError':
      err = handleExpiredTokenError();
      break;
    case 'NotBeforeError':
      err = handleInactiveTokenError();
      break;
    default:
      if (err.code === 11000) {
        err = handleMongoServerError(err);
      } else {
        err = handleNodeError(err);
      }
      break;
  }

  sendError(err, res, isDev);
  next();
};
