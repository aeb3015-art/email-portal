import pino from 'pino';
import { config } from './config.js';

/** Never log bodies, passwords or tokens: anything matching these paths is redacted. */
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: [
      'password', '*.password', 'config.password', 'apiKey', '*.apiKey', 'token', '*.token',
      'accessToken', 'refreshToken', '*.accessToken', '*.refreshToken', 'authorization',
      'req.headers.authorization', 'req.headers.cookie', 'bodyText', 'bodyHtml', '*.bodyText', '*.bodyHtml',
      'body', 'content', '*.content',
    ],
    censor: '[redacted]',
  },
});
