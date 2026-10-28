import { json, type RequestHandler } from 'express';

// Multi-category profiles can exceed Express's 100 KiB default when each
// assessment contains a detailed answer. Keep a bounded transport envelope.
export function tutorProfileBodyParser(): RequestHandler {
  const parse = json({ limit: 1_000_000 });
  // A distinct name preserves Nest's default parsers on unrelated routes.
  return function tutorProfileJsonParser(req, res, next) {
    parse(req, res, next);
  };
}
