import { raw, type RequestHandler } from 'express';

// Gateway signatures are computed over the exact request bytes, so webhook
// routes keep the raw body as a Buffer instead of parsed JSON.
export function paymentWebhookBodyParser(): RequestHandler {
  const parse = raw({ type: '*/*', limit: 1_000_000 });
  // Named wrapper: Nest must not mistake this for its global JSON parser.
  return function paymentWebhookRawParser(req, res, next) {
    parse(req, res, next);
  };
}
