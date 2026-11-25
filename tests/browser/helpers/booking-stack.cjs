'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, VersioningType } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { setupBookingIndexes } = require('../../../scripts/setup-bookings.cjs');

async function startBookingStack(options = {}) {
  const uri = new URL(
    options.mongoUri ||
      process.env.BOOKING_TEST_MONGODB_URI ||
      'mongodb://127.0.0.1:27124/unused?directConnection=true&replicaSet=booking-tests',
  );
  if (
    !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
    uri.port !== '27124'
  )
    throw new Error('Use the isolated booking test replica set on port 27124.');
  uri.pathname =
    '/booking_acceptance_' +
    Date.now() +
    '_' +
    crypto.randomBytes(3).toString('hex');
  const redisUrl = options.redisUrl || 'redis://127.0.0.1:6395';
  if (new URL(redisUrl).port !== '6395')
    throw new Error('Use isolated booking Redis on port 6395.');
  const webhookSecret = 'whsec_local_booking_acceptance_only';
  const env = {
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    MONGODB_URI: uri.toString(),
    REDIS_URL: redisUrl,
    REDIS_REQUIRED: 'true',
    JWT_ACCESS_SECRET: 'booking-fixture-access-secret-32characters',
    JWT_REFRESH_SECRET: 'booking-fixture-refresh-secret-32characters',
    TURN_SECRET: 'booking-fixture-turn-secret-32characters',
    OPERATIONS_TOKEN: 'booking-fixture-operations-secret-32characters',
    MEDIA_WORKER_MAX_TRANSPORTS_PER_WORKER: '50',
    MEDIA_WORKER_MODE: 'in-process',
    MEDIA_WORKER_COUNT: '1',
    HOST_CANDIDATE_PORT_RANGE: '48000-48049',
    PIPE_PORT_RANGE: '49000-49049',
    ENABLE_PIPE_TRANSPORT: 'false',
    SMTP_ENABLED: 'false',
    BOOKINGS_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_local_booking_acceptance',
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    BOOKING_CHARGE_CURRENCIES: 'EUR,GBP,USD,INR,JPY,KWD',
    BOOKING_TAX_RATE_BPS: '2000',
    BOOKING_TAX_NOTE: 'Tax configured for synthetic acceptance records.',
    BOOKING_WORKER_POLL_MS: '60000',
    FRONTEND_URL: 'http://127.0.0.1:4485',
    PUBLIC_URL: 'http://127.0.0.1:3385',
    NODE_PUBLIC_URL: 'http://127.0.0.1:3385',
    NODE_ID: 'booking-acceptance-' + crypto.randomUUID(),
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:4485',
  };
  Object.assign(process.env, env);
  const connection = await mongoose
    .createConnection(uri.toString(), { autoIndex: false })
    .asPromise();
  if (options.debug) console.log('Fixture database connected');
  await setupBookingIndexes(connection);
  if (options.debug) console.log('Fixture indexes ready');
  const root = path.resolve(__dirname, '../../..');
  const { AppModule } = require(
    path.join(root, 'apps/backend/dist/app.module.js'),
  );
  const { StripeGateway } = require(
    path.join(root, 'apps/backend/dist/bookings/stripe.gateway.js'),
  );
  const { BookingsService } = require(
    path.join(root, 'apps/backend/dist/bookings/bookings.service.js'),
  );
  const { BookingWorkerService } = require(
    path.join(root, 'apps/backend/dist/bookings/booking-worker.service.js'),
  );
  const { SuccessResponseInterceptor } = require(
    path.join(
      root,
      'apps/backend/dist/common/interceptors/success-response.interceptor.js',
    ),
  );
  const { ROLE_PERMISSION_MAP } = require(
    path.join(root, 'apps/backend/dist/rbac/rbac.constants.js'),
  );
  class FakeStripeGateway extends StripeGateway {
    constructor() {
      super(new ConfigService(env));
      this.sessions = new Map();
      this.remoteRefunds = new Map();
      this.creates = 0;
      this.refundCreates = 0;
      this.failCreateOnce = false;
      this.failRefundOnce = false;
    }
    async createCheckout(order) {
      if (!this.sessions.has(order._id)) {
        this.creates++;
        this.sessions.set(order._id, {
          id: 'cs_test_' + order._id,
          orderId: order._id,
          studentId: order.studentId,
          status: 'open',
          paid: false,
          failed: false,
          amountMinor: order.invoiceSource.totalMinor,
          currency: order.invoiceSource.currency.toLowerCase(),
          paymentIntentId: 'pi_test_' + order._id,
          paidAt: new Date(),
          url: 'https://checkout.stripe.com/c/pay/test_' + order._id,
          livemode: false,
        });
      }
      if (this.failCreateOnce) {
        this.failCreateOnce = false;
        throw new Error(
          'Simulated lost checkout response after provider creation.',
        );
      }
      return { ...this.sessions.get(order._id) };
    }
    async recoverCheckout(order) {
      return this.createCheckout(order);
    }
    async retrieveCheckout(id) {
      const found = [...this.sessions.values()].find(
        (session) => session.id === id,
      );
      if (!found) throw new Error('Unknown fixture checkout');
      return { ...found };
    }
    async expireCheckout(id) {
      const found = [...this.sessions.values()].find(
        (session) => session.id === id,
      );
      if (found && !found.paid) found.status = 'expired';
    }
    pay(orderId, overrides = {}) {
      const session = this.sessions.get(orderId);
      if (!session) throw new Error('Unknown checkout');
      Object.assign(
        session,
        { paid: true, status: 'complete', paidAt: new Date() },
        overrides,
      );
      return { ...session };
    }
    async refund(paymentIntentId, amountMinor, requestId) {
      if (!this.remoteRefunds.has(requestId)) {
        this.refundCreates++;
        const payment = [...this.sessions.values()].find(
          (session) => session.paymentIntentId === paymentIntentId,
        );
        this.remoteRefunds.set(requestId, {
          id: 're_test_' + requestId,
          paymentIntentId,
          amountMinor,
          currency: payment.currency,
          status: 'succeeded',
          requestId,
        });
      }
      if (this.failRefundOnce) {
        this.failRefundOnce = false;
        throw new Error('Simulated lost refund response.');
      }
      return { ...this.remoteRefunds.get(requestId) };
    }
    async retrieveRefund(id) {
      const found = [...this.remoteRefunds.values()].find(
        (refund) => refund.id === id,
      );
      if (!found) throw new Error('Unknown refund');
      return { ...found };
    }
    async refundsFor(paymentIntentId) {
      return [...this.remoteRefunds.values()]
        .filter((refund) => refund.paymentIntentId === paymentIntentId)
        .map((refund) => ({ ...refund }));
    }
  }
  const gateway = new FakeStripeGateway();
  const password = 'Password@12345';
  const hash = await bcrypt.hash(password, 10);
  const users = {};
  for (const [name, role] of [
    ['teacher', 'TEACHER'],
    ['secondTeacher', 'TEACHER'],
    ['student', 'STUDENT'],
    ['other', 'STUDENT'],
    ['admin', 'SUPER_ADMIN'],
  ]) {
    const objectId = new mongoose.Types.ObjectId();
    const id = objectId.toString();
    users[name] = { id, email: name.toLowerCase() + '@booking.test', role };
    await connection.db.collection('users').insertOne({
      _id: objectId,
      name: name === 'teacher' ? 'Avery Morgan' : name + ' booking',
      displayName: name === 'teacher' ? 'Avery Morgan' : name + ' booking',
      email: users[name].email,
      passwordHash: hash,
      roles: role === 'SUPER_ADMIN' ? ['SUPER_ADMIN', 'ADMIN'] : [role],
      permissions: ROLE_PERMISSION_MAP[role] || [],
      status: 'active',
      disabled: false,
      publicProfileEnabled: role === 'TEACHER',
      tutorReviewStatus: 'approved',
      timezone: 'Europe/London',
      headline: 'Mathematics and confidence',
      settings: {
        theme: 'system',
        locale: 'en-GB',
        notifications: {},
        privacy: {},
      },
    });
  }
  await connection.db.collection('invoice_settings').insertOne({
    _id: 'issuer',
    value: {
      version: 1,
      defaultCurrency: 'EUR',
      defaultTaxNote: '',
      seller: {
        name: 'Acceptance Learning Ltd',
        email: 'billing@booking.test',
        address: '123 Synthetic Street\nLondon',
        countryCode: 'GB',
        vatNumber: 'GB-TEST-ONLY',
        registrationNumber: 'TEST-001',
        paymentInstructions: 'Paid online.',
      },
    },
  });
  let app, worker, bookings;
  async function boot() {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeGateway)
      .useValue(gateway)
      .compile();
    if (options.debug) console.log('Nest compiled');
    app = module.createNestApplication({ rawBody: true, abortOnError: false });
    app.useLogger(options.debug ? ['error', 'warn'] : false);
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new SuccessResponseInterceptor());
    await app.listen(options.port || 0, '127.0.0.1');
    worker = app.get(BookingWorkerService);
    worker.onModuleDestroy();
    bookings = app.get(BookingsService);
  }
  if (options.debug) console.log('Fixture users seeded');
  await boot();
  if (options.debug) console.log('Fixture HTTP server ready');
  return {
    get app() {
      return app;
    },
    get worker() {
      return worker;
    },
    get bookings() {
      return bookings;
    },
    connection,
    gateway,
    users,
    password,
    webhookSecret,
    get origin() {
      return 'http://127.0.0.1:' + app.getHttpServer().address().port;
    },
    async restart() {
      await app.close();
      require('prom-client').register.clear();
      await boot();
    },
    async stop() {
      await app.close();
      require('prom-client').register.clear();
      if (!connection.name.startsWith('booking_acceptance_'))
        throw new Error('Refusing to drop a non-fixture database');
      await connection.dropDatabase();
      await connection.close();
    },
  };
}
module.exports = { startBookingStack };
