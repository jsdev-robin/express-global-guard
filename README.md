# express-global-guard

A production-ready global error handler for Express 5 applications, written in TypeScript.

It turns any error thrown in your app (Mongoose, MongoDB, Redis, JWT, Multer, Zod, body parser, system errors) into a clean, friendly JSON response, logs it with request context, and never leaks internal details in production.

## Features

- Friendly, human-readable error messages
- Mongoose, MongoDB, Redis, JWT, Multer, Zod and body-parser errors handled out of the box
- Field-level `errors` array for forms
- Structured logging with [pino](https://github.com/pinojs/pino) and automatic redaction of secrets
- Request ID on every request, response and log line
- Pluggable error reporter (Sentry, Datadog, or your own)
- Graceful shutdown with `unhandledRejection`, `uncaughtException`, `SIGTERM` and `SIGINT` handling
- No stack traces or internal messages in production
- Written in TypeScript with full type definitions

## Installation

```bash
npm install express-global-guard
```

For pretty logs during development:

```bash
npm install -D pino-pretty
```

## Quick start

```typescript
import express from 'express';
import {
  globalErrorHandler,
  notFoundHandler,
  requestId,
} from 'express-global-guard';

const app = express();

app.use(requestId);
app.use(express.json());

app.get('/units/:id', async (req, res) => {
  const unit = await UnitModel.findById(req.params.id).orFail();
  res.json({ data: unit });
});

app.use(notFoundHandler);
app.use(globalErrorHandler);

app.listen(3000);
```

Order matters:

1. `requestId` first, so every log line carries the request ID.
2. Your routes.
3. `notFoundHandler` after all routes.
4. `globalErrorHandler` last.

Express 5 forwards errors thrown or rejected inside async handlers to the error middleware automatically, so no `try/catch` or wrapper is needed.

## Throwing your own errors

```typescript
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

throw createError(StatusCodes.FORBIDDEN, 'You cannot edit this unit.');
```

Errors created with `http-errors` keep their status code. Messages of 4xx errors are sent to the client. Messages of 5xx errors are hidden in production.

## Graceful shutdown

```typescript
import mongoose from 'mongoose';
import { logger, registerProcessErrorHandlers } from 'express-global-guard';

const server = app.listen(3000, () => {
  logger.info({ port: 3000 }, 'server started');
});

registerProcessErrorHandlers(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
  await mongoose.disconnect();
});
```

On `unhandledRejection` and `uncaughtException` the error is logged and reported, your shutdown function runs, and the process exits with code `1`. On `SIGTERM` and `SIGINT` it shuts down and exits with code `0`. If shutdown takes longer than 10 seconds (configurable through the second argument), the process exits anyway.

Run the app under a process manager (Docker restart policy, PM2, Kubernetes) so it restarts after a crash.

## Error reporting

Connect any monitoring tool with `setErrorReporter`. It is called for every 5xx error and for fatal process errors.

```typescript
import * as Sentry from '@sentry/node';
import { setErrorReporter } from 'express-global-guard';

Sentry.init({ dsn: process.env.SENTRY_DSN });

setErrorReporter(async (error, context) => {
  Sentry.captureException(error, { extra: context });
  if (context.fatal) await Sentry.flush(2000);
});
```

The `context` object contains `requestId`, `method`, `path`, `userId`, `statusCode` and `fatal`. If the reporter throws or rejects, the failure is logged and never affects the response.

## Logging

The exported `logger` is a configured pino instance. Use it anywhere in your app, and every line automatically includes the current `requestId`.

```typescript
import { logger } from 'express-global-guard';

logger.info({ unitId: unit.id }, 'unit fetched');
```

Fields such as `authorization`, `cookie`, `password`, `token`, `accessToken` and `refreshToken` are redacted.

## Response format

```json
{
  "status": "fail",
  "message": "Please fix the following and try again: Email is required.",
  "code": "VALIDATION_FAILED",
  "errors": [{ "field": "email", "message": "Email is required." }],
  "requestId": "9f1c2e7a-4b1d-4c3a-9d0e-2f6b1c8a7e55"
}
```

| Field       | Description                                                     |
| ----------- | --------------------------------------------------------------- |
| `status`    | `fail` for 4xx, `error` for 5xx                                 |
| `message`   | Friendly message, safe to show to users                         |
| `code`      | Machine-readable code (only for errors safe to expose)          |
| `errors`    | Field-level problems, for validation, cast and duplicate errors |
| `requestId` | Same value as the `X-Request-Id` response header                |
| `debug`     | Name, message and stack. Only when `NODE_ENV=development`       |

## Handled errors

| Source                                                | Status    | Code                                                    |
| ----------------------------------------------------- | --------- | ------------------------------------------------------- |
| Mongoose `CastError`                                  | 400       | `INVALID_FIELD`                                         |
| Mongoose `ValidationError`, Zod `ZodError`            | 422       | `VALIDATION_FAILED`                                     |
| Mongoose `DocumentNotFoundError`                      | 404       | `NOT_FOUND`                                             |
| Mongoose `StrictModeError`, `StrictPopulateError`     | 400       | `FIELD_NOT_ALLOWED`                                     |
| Mongoose `VersionError`, `ParallelSaveError`          | 409       | `CONFLICT`                                              |
| BSON and `ObjectParameterError`                       | 400       | `INVALID_INPUT`                                         |
| MongoDB duplicate key (11000, 11001)                  | 409       | `DUPLICATE_KEY`                                         |
| MongoDB document validation (121)                     | 422       | `DB_VALIDATION_FAILED`                                  |
| MongoDB write conflict (112)                          | 409       | `WRITE_CONFLICT`                                        |
| MongoDB operation timeout (50)                        | 504       | `DB_TIMEOUT`                                            |
| MongoDB network, server selection, pool errors        | 503       | `DB_UNAVAILABLE`                                        |
| Redis client closed, offline, timeout, reconnect      | 503       | `SERVICE_UNAVAILABLE`                                   |
| JWT invalid, expired, not active                      | 401       | `INVALID_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_NOT_ACTIVE`    |
| Multer file too large, too many, unexpected file      | 413 / 400 | `FILE_TOO_LARGE`, `TOO_MANY_FILES`, `UNEXPECTED_FILE`   |
| Body parser invalid JSON, too large, bad encoding     | 400 / 413 | `INVALID_BODY`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_BODY` |
| `URIError`                                            | 400       | `MALFORMED_URL`                                         |
| `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND` and similar | 503       | `SERVICE_UNAVAILABLE`                                   |
| `ETIMEDOUT`, `ESOCKETTIMEDOUT`                        | 504       | `GATEWAY_TIMEOUT`                                       |
| Errors created with `http-errors`                     | as set    | as set                                                  |
| Anything else, including non-Error throws             | 500       | none                                                    |

Duplicate key errors name the field but never include the duplicated value.

## Environment variables

| Variable       | Default                        | Description                                          |
| -------------- | ------------------------------ | ---------------------------------------------------- |
| `NODE_ENV`     | none                           | `development` enables `debug` output and pretty logs |
| `LOG_LEVEL`    | `debug` (`info` in production) | Any pino level, or `silent`                          |
| `SERVICE_NAME` | `api`                          | Added to every log line as `service`                 |

## Request ID

`requestId` reads the incoming `X-Request-Id` header when it is 8 to 128 characters of letters, numbers, `.`, `_` or `-`. Anything else is replaced with a new UUID. The ID is sent back in the `X-Request-Id` response header, included in error bodies, and attached to every log line.

## User ID in logs

If an earlier middleware sets `req.userId`, it is included in error logs and reports.

## API

| Export                                               | Description                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `globalErrorHandler`                                 | Error-handling middleware. Register it last                    |
| `notFoundHandler`                                    | Returns 404 for unmatched routes                               |
| `requestId`                                          | Middleware that creates and propagates the request ID          |
| `getRequestId()`                                     | Returns the current request ID inside a request                |
| `logger`                                             | Configured pino logger                                         |
| `setErrorReporter(fn)`                               | Registers a monitoring callback. Pass `undefined` to remove it |
| `registerProcessErrorHandlers(shutdown, timeoutMs?)` | Crash and signal handling with graceful shutdown               |

## Testing

```bash
LOG_LEVEL=silent npx vitest
```

## Requirements

- Node.js 18 or newer
- Express 5

## License

MIT
