import { pino } from 'pino';
import { env, isProd } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Pretty output in dev; structured JSON everywhere else, which is what a
  // log shipper wants.
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.keyHash',
    ],
    censor: '[redacted]',
  },
  base: { service: 'mtlink-api' },
});

export type Logger = typeof logger;
