# express-global-guard

A robust global error handler for Express applications with TypeScript support.

## Installation

```bash
npm install express-global-guard
```

## Usage

```tsx
import express from 'express';
import { globalErrorHandler } from 'express-global-guard';

const app = express();

app.use(globalErrorHandler);
```
