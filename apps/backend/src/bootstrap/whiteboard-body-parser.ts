import { json, type RequestHandler } from 'express';

// Whiteboard snapshots are capped at 1.5 MB by ClassSessionsService.
// Allow request-envelope overhead without increasing limits on unrelated endpoints.
export function whiteboardBodyParser(): RequestHandler {
  const parse = json({ limit: 2_000_000 });
  // Nest detects installed global parsers by function name. Mounting jsonParser
  // on this path directly would make Nest omit JSON parsing for every other route.
  return function whiteboardJsonParser(req, res, next) {
    parse(req, res, next);
  };
}
