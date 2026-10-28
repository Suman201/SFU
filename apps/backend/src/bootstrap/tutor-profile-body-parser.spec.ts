import { expect } from '@jest/globals';
import express from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import request from 'supertest';
import { tutorProfileBodyParser } from './tutor-profile-body-parser';

describe('Tutor profile request envelopes', () => {
  function app() {
    const server = express();
    server.use('/api/v1/profile/me', tutorProfileBodyParser());
    server.use('/api/v1/admin/tutor-applications/:id/review', tutorProfileBodyParser());
    new ExpressAdapter(server).registerParserMiddleware('/api/v1', false);
    server.patch('/api/v1/profile/me', (req, res) => res.json({ length: req.body.response.length }));
    server.post('/api/v1/admin/tutor-applications/:id/review', (req, res) => res.json({ length: req.body.response.length }));
    server.post('/api/v1/auth/login', (req, res) => res.json(req.body));
    server.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.sendStatus(error.status ?? 500));
    return server;
  }
  it('accepts detailed assessments and reviews beyond the default envelope', async () => {
    const body = { response: 'x'.repeat(200_000) };
    expect((await request(app()).patch('/api/v1/profile/me').send(body)).body.length).toBe(200_000);
    expect((await request(app()).post('/api/v1/admin/tutor-applications/tutor/review').send(body)).body.length).toBe(200_000);
  });
  it('keeps the default parsing and size limit on unrelated routes', async () => {
    const body = { email: 'tutor@example.test' };
    expect((await request(app()).post('/api/v1/auth/login').send(body)).body).toEqual(body);
    expect((await request(app()).post('/api/v1/auth/login').send({ response: 'x'.repeat(200_000) })).status).toBe(413);
  });
  it('rejects oversized profile submissions', async () => {
    expect((await request(app()).patch('/api/v1/profile/me').send({ response: 'x'.repeat(1_000_000) })).status).toBe(413);
  });
});
