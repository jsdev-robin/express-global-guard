# express-global-guard

Production-grade error handling middleware for Express 5.

## Install

```bash
npm install express-global-guard
# or
pnpm add express-global-guard
```

For pretty logs in development:

```bash
pnpm add -D pino-pretty
```

## Usage

```ts
import express from 'express';
import {
  globalErrorHandler,
  notFoundHandler,
  registerProcessErrorHandlers,
} from 'express-global-guard';

const app = express();

app.use(express.json());

// your routes here

app.use(notFoundHandler);
app.use(globalErrorHandler);

const server = app.listen(3000);

registerProcessErrorHandlers(server);
```

## `catchAsync`

For callback-based async code outside of Express 5's automatic error catching:

```ts
import { catchAsync } from 'express-global-guard';

app.get(
  '/user/:id',
  catchAsync(async (req, res) => {
    const user = await getUserById(req.params.id);
    res.json(user);
  }),
);
```

> Express 5 automatically catches errors from async route handlers. Use `catchAsync` only for callback-based patterns like `setTimeout`, `fs.readFile`, etc.

## Environment Variables

| Variable       | Default      | Description                                        |
| -------------- | ------------ | -------------------------------------------------- |
| `NODE_ENV`     | `production` | `development`, `staging`, `production`, `test`     |
| `LOG_LEVEL`    | `info`       | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `SERVICE_NAME` | `api`        | Service name attached to every log                 |

## Error Response Shape

**4xx (client errors)**

```json
{
  "status": "fail",
  "message": "Invalid input for \"email\": \"foo\". Provide valid data.",
  "requestId": "a1b2c3d4-..."
}
```

**5xx (server errors)**

```json
{
  "status": "error",
  "message": "Something went wrong. Try again later.",
  "requestId": "a1b2c3d4-..."
}
```

**Development only** — stack trace included:

```json
{
  "status": "error",
  "message": "...",
  "stack": "Error: ...\n    at ...",
  "requestId": "a1b2c3d4-..."
}
```

## Request Tracing

Every response includes an `X-Request-Id` header. The middleware reads `X-Request-Id` or `X-Correlation-Id` from the incoming request, falling back to `crypto.randomUUID()`.

## Supported Errors

| Error Name              | Status  | Description                      |
| ----------------------- | ------- | -------------------------------- |
| `CastError`             | 400     | Invalid field value (Mongoose)   |
| `ValidationError`       | 422     | Schema validation failure        |
| `StrictModeError`       | 400     | Unknown field in strict schema   |
| `DocumentNotFoundError` | 404     | Document not found (Mongoose)    |
| `MissingSchemaError`    | 500     | Mongoose schema not registered   |
| `DisconnectedError`     | 503     | Database connection lost         |
| `MongoServerError`      | 409/500 | Duplicate key or DB server error |
| `JsonWebTokenError`     | 401     | Invalid JWT                      |
| `TokenExpiredError`     | 401     | Expired JWT                      |
| `NotBeforeError`        | 401     | JWT not yet active               |
| `SyntaxError`           | 400     | Malformed JSON body              |
| `TypeError`             | 500     | Internal type error              |
| `ReferenceError`        | 500     | Internal reference error         |
| `RangeError`            | 500     | Internal range error             |
| `URIError`              | 400     | Malformed URI                    |

## Graceful Shutdown

`registerProcessErrorHandlers` handles `SIGTERM`, `SIGINT`, `uncaughtException`, and `unhandledRejection`. On fatal errors the server closes gracefully with a 10-second timeout before forcing exit.

```ts
const server = app.listen(3000);
registerProcessErrorHandlers(server);
```

## Logging

Structured JSON logs via [pino](https://github.com/pinojs/pino). When `pino-pretty` is installed and the process is attached to a TTY, logs are prettified automatically in development.

```bash
pnpm add -D pino-pretty
```

## License

MIT
