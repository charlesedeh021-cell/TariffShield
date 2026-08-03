import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import { env, isProduction } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL || 'info',
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: true,
        },
      },
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => {
    const existingHeader = req.headers['x-correlation-id'] || req.headers['x-request-id'];
    if (typeof existingHeader === 'string' && existingHeader.trim().length > 0) {
      return existingHeader;
    }
    return randomUUID();
  },
  customAttributeKeys: {
    reqId: 'correlationId',
  },
  customProps: (req) => ({
    correlationId: req.id,
  }),
});
