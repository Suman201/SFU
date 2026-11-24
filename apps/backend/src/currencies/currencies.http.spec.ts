import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException, ValidationPipe, VersioningType } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { AuthService } from '../auth/auth.service';
import { UserDocument } from '../database/schemas';
import { CurrenciesController } from './currencies.controller';
import { CurrenciesService } from './currencies.service';

describe('currency HTTP contracts and account isolation', () => {
  let app: INestApplication;
  const updateOne = jest.fn().mockReturnValue({ exec: async () => ({ matchedCount: 1 }) });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [CurrenciesController], providers: [
      { provide: CurrenciesService, useValue: { catalogue: async () => ({ currencies: ['EUR', 'INR', 'JPY', 'KWD'], defaultCurrency: 'EUR', snapshot: null }), rates: async () => null } },
      { provide: getModelToken(UserDocument.name), useValue: { updateOne } },
      { provide: AuthService, useValue: { verifyAccessToken: async (token: string) => { if (token !== 'alice') throw new UnauthorizedException(); return { sub: 'alice-id' }; } } },
    ] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api'); app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  it('publishes supported currencies to guests', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/currencies').expect(200);
    expect(response.body.currencies).toContain('JPY');
  });
  it('requires authentication before saving and binds updates to the authenticated account', async () => {
    await request(app.getHttpServer()).patch('/api/v1/currencies/preference').send({ currency: 'INR' }).expect(401);
    await request(app.getHttpServer()).patch('/api/v1/currencies/preference').set('Authorization', 'Bearer alice').send({ currency: 'INR' }).expect(200);
    expect(updateOne).toHaveBeenCalledWith({ _id: 'alice-id', deletedAt: { $exists: false } }, { $set: { preferredCurrency: 'INR' } });
  });
  it('rejects unsupported currencies, account injection, fractional minor units, and missing rates', async () => {
    await request(app.getHttpServer()).patch('/api/v1/currencies/preference').set('Authorization', 'Bearer alice').send({ currency: 'ZZZ' }).expect(400);
    await request(app.getHttpServer()).patch('/api/v1/currencies/preference').set('Authorization', 'Bearer alice').send({ currency: 'INR', userId: 'bob' }).expect(400);
    await request(app.getHttpServer()).get('/api/v1/currencies/quote?amountMinor=1.5&currency=EUR&target=JPY').expect(400);
    await request(app.getHttpServer()).get('/api/v1/currencies/quote?amountMinor=100&currency=EUR&target=JPY').expect(503);
  });
});
