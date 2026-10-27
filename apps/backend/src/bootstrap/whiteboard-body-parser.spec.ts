import { expect } from '@jest/globals';
import express from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import request from 'supertest';
import { whiteboardBodyParser } from './whiteboard-body-parser';

describe('whiteboard request size limits', () => {
  function createApp() {
    const app = express();
    app.use('/api/v1/class-sessions/:sessionId/whiteboard', whiteboardBodyParser());
    new ExpressAdapter(app).registerParserMiddleware('/api/v1', false);
    app.post('/api/v1/class-sessions/:sessionId/whiteboard/checkpoints', (_req, res) => res.sendStatus(204));
    app.put('/api/v1/class-sessions/:sessionId/whiteboard', (_req, res) => res.sendStatus(204));
    app.post('/unrelated', (_req, res) => res.sendStatus(204));
    app.post('/api/v1/auth/login', (req, res) => res.json(req.body ?? null));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.sendStatus(error.status ?? 500);
    });
    return app;
  }

  it('accepts bounded image-backed snapshots and checkpoints above the default JSON limit', async () => {
    const app = createApp();
    const snapshot = { background: 'x'.repeat(250_000) };
    expect((await request(app).put('/api/v1/class-sessions/session-1/whiteboard').send(snapshot)).status).toBe(204);
    expect((await request(app).post('/api/v1/class-sessions/session-1/whiteboard/checkpoints').send(snapshot)).status).toBe(204);
  });

  it('preserves Nest default JSON parsing for login and other unrelated routes', async () => {
    const body = { email: 'acceptance@example.com', password: 'local-test-password' };
    const response = await request(createApp()).post('/api/v1/auth/login').send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
  });

  it('keeps the default limit on unrelated routes', async () => {
    expect((await request(createApp()).post('/unrelated').send({ data: 'x'.repeat(250_000) })).status).toBe(413);
  });

  it('rejects whiteboard requests above the bounded transport limit', async () => {
    expect((await request(createApp()).put('/api/v1/class-sessions/session-1/whiteboard').send({ data: 'x'.repeat(2_000_000) })).status).toBe(413);
  });
});
