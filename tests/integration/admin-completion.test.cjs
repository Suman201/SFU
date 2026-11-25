'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcrypt');
const { io } = require('socket.io-client');
const { startBookingStack } = require('../browser/helpers/booking-stack.cjs');

test(
  'complete admin operations against real HTTP and replica-set transactions',
  { timeout: 240000 },
  async (t) => {
    const stack = await startBookingStack();
    t.after(() => stack.stop());
    await require('../../scripts/setup-admin-operations.cjs').setupAdminOperationsIndexes(
      stack.connection,
    );
    const tokens = {};
    async function api(
      name,
      method,
      path,
      body,
      expected = method === 'POST' ? 201 : 200,
    ) {
      const response = await fetch(stack.origin + '/api/v1/' + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(tokens[name] ? { authorization: 'Bearer ' + tokens[name] } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await response.json();
      assert.equal(response.status, expected, JSON.stringify(json));
      return json.data ?? json;
    }
    for (const name of ['admin', 'teacher', 'student', 'other'])
      tokens[name] = (
        await api(
          name,
          'POST',
          'auth/login',
          { email: stack.users[name].email, password: stack.password },
          200,
        )
      ).accessToken;
    const staff = await stack.bookings.users.create({
      displayName: 'Whiteboard Reviewer',
      name: 'Whiteboard Reviewer',
      email: 'reviewer@booking.test',
      passwordHash: await bcrypt.hash(stack.password, 4),
      roles: ['ADMIN'],
      permissions: [],
      status: 'active',
      disabled: false,
    });
    tokens.staff = (
      await api(
        'staff',
        'POST',
        'auth/login',
        { email: staff.email, password: stack.password },
        200,
      )
    ).accessToken;
    let role, order, board, oldVersion;
    const billing = {
      name: 'Acceptance Learner',
      email: stack.users.student.email,
      address: '123 Synthetic Street',
      countryCode: 'GB',
      vatNumber: '',
    };
    let offset = 0;
    const epoch = Math.ceil((Date.now() + 72 * 3600000) / 300000) * 300000;
    async function paid(currency = 'EUR', amountMinor = 5000) {
      const offer = await api('teacher', 'POST', 'bookings/teacher/offers', {
        title: 'Admin acceptance lesson ' + offset,
        description: 'Synthetic acceptance lesson',
        durationMinutes: 30,
        amountMinor,
        currency,
        active: true,
      });
      const slot = await api('teacher', 'POST', 'bookings/teacher/slots', {
        offerId: offer.id,
        startsAt: new Date(epoch + offset++ * 3600000).toISOString(),
      });
      const value = await api(
        'student',
        'POST',
        'bookings/slots/' + slot.id + '/reserve',
        {
          requestId: randomUUID(),
          expectedTotalMinor: offer.price.amountMinor,
          expectedOfferVersion: offer.version,
          billing,
        },
      );
      await api('student', 'POST', 'bookings/orders/' + value.id + '/checkout');
      stack.gateway.pay(value.id);
      await api('admin', 'POST', 'admin/bookings/' + value.id + '/reconcile', {
        reason: 'Verify provider payment for admin acceptance.',
      });
      return api('admin', 'GET', 'admin/bookings/' + value.id);
    }
    const snapshot = (title) => ({
      schemaVersion: 1,
      activePageId: 'page-1',
      pages: [
        {
          id: 'page-1',
          title,
          tags: ['algebra'],
          order: 0,
          template: 'grid',
          view: { zoom: 1, panX: 0, panY: 0 },
          elements: [
            {
              id: 'text-1',
              type: 'text',
              position: { x: 100, y: 100 },
              width: 400,
              height: 100,
              text: title,
              fontSize: 28,
              color: '#21362d',
              rotation: 0,
            },
          ],
        },
      ],
    });
    await t.test(
      'staff policy is super-admin-only and enforced immediately on an existing token',
      async () => {
        await api('teacher', 'GET', 'admin/staff/roles', undefined, 403);
        await api('staff', 'GET', 'users');
        const socket = io(stack.origin + '/sfu', {
          auth: { token: tokens.staff },
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          timeout: 3000,
        });
        t.after(() => socket.disconnect());
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('connect_error', reject);
        });
        role = await api('admin', 'POST', 'admin/staff/roles', {
          name: 'Board review',
          description: 'Read-only board review',
          status: 'active',
          permissions: ['admin:whiteboards:read'],
        });
        await api(
          'admin',
          'POST',
          'admin/staff/members/' + staff.id + '/role',
          {
            roleId: role.id,
            expectedRoleId: null,
            reason: 'Assign bounded board review duties.',
          },
        );
        await api('staff', 'GET', 'admin/whiteboards');
        await api('staff', 'GET', 'admin/bookings', undefined, 403);
        await api('staff', 'GET', 'admin/staff/roles', undefined, 403);
        await api('staff', 'POST', 'student-enrollments', {}, 403);
        await api('staff', 'POST', 'assignments', {}, 403);
        await api('staff', 'GET', 'rooms/restricted-room', undefined, 403);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error('Assigned staff retained its administrative socket.'),
              ),
            3000,
          );
          socket.once('disconnect', () => {
            clearTimeout(timer);
            resolve();
          });
          socket.emit('whiteboard:command', {});
        });
        const denied = io(stack.origin + '/sfu', {
          auth: { token: tokens.staff },
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          timeout: 3000,
        });
        try {
          await new Promise((resolve, reject) => {
            denied.once('connect', () =>
              reject(
                new Error('Managed staff opened an administrative socket.'),
              ),
            );
            denied.once('connect_error', resolve);
          });
        } finally {
          denied.disconnect();
        }

        await api('staff', 'GET', 'users', undefined, 403);
        const me = await api('staff', 'GET', 'auth/me');
        assert.deepEqual(me.permissions, ['admin:whiteboards:read']);
        await api(
          'admin',
          'POST',
          'admin/staff/members/' + staff.id + '/role',
          { reason: 'Missing access selection.' },
          400,
        );
        await api(
          'admin',
          'DELETE',
          'admin/staff/roles/' + role.id,
          undefined,
          409,
        );
        await api(
          'admin',
          'PATCH',
          'admin/staff/roles/' + role.id,
          {
            name: role.name,
            description: role.description,
            status: 'active',
            permissions: ['admin:whiteboards:read'],
            version: 99,
          },
          409,
        );
      },
    );
    await t.test(
      'booking controls verify provider truth and expose the paid invoice',
      async () => {
        order = await paid();
        assert.equal(order.status, 'confirmed');
        assert.ok(order.invoiceId);
        const invoice = await fetch(
          stack.origin + '/api/v1/bookings/orders/' + order.id + '/invoice',
          { headers: { authorization: 'Bearer ' + tokens.admin } },
        );
        assert.equal(invoice.status, 200);
        assert.equal(
          Buffer.from(await invoice.arrayBuffer())
            .subarray(0, 4)
            .toString(),
          '%PDF',
        );
        await api(
          'admin',
          'POST',
          'admin/bookings/' + order.id + '/reconcile',
          { reason: 'Idempotent confirmation retry.' },
        );
        assert.equal(
          await stack.connection.db
            .collection('invoices')
            .countDocuments({ orderId: order.id }),
          1,
        );
      },
    );
    await t.test(
      'whiteboard versions are previewable without mutation and live recovery is blocked',
      async () => {
        const body = {
          batchId: order.batchId,
          snapshot: snapshot('Original algebra explanation'),
          expectedSnapshotVersion: 0,
          expectedLastOperationSeq: 0,
          reason: 'manual-save',
          createVersion: true,
        };
        const first = await api(
          'teacher',
          'PUT',
          'class-sessions/' + order.sessionId + '/whiteboard',
          body,
        );
        oldVersion = first.latestVersionId;
        await api(
          'teacher',
          'PUT',
          'class-sessions/' + order.sessionId + '/whiteboard',
          {
            ...body,
            snapshot: snapshot('Revised explanation'),
            expectedSnapshotVersion: first.snapshotVersion,
          },
        );
        board = await api(
          'staff',
          'GET',
          'admin/whiteboards/' + order.sessionId,
        );
        assert.equal(board.board.snapshotVersion, 2);
        assert.equal(board.versions.length, 2);
        const preview = await api(
          'staff',
          'GET',
          'admin/whiteboards/' + order.sessionId + '/versions/' + oldVersion,
        );
        assert.equal(
          preview.snapshot.pages[0].title,
          'Original algebra explanation',
        );
        assert.equal(
          (await api('staff', 'GET', 'admin/whiteboards/' + order.sessionId))
            .board.snapshot.pages[0].title,
          'Revised explanation',
        );
        await api(
          'staff',
          'POST',
          'admin/whiteboards/' +
            order.sessionId +
            '/versions/' +
            oldVersion +
            '/restore',
          {
            expectedSnapshotVersion: 2,
            expectedLastOperationSeq: 0,
            reason: 'Read-only account cannot restore.',
          },
          403,
        );
        await stack.bookings.classes.updateOne(
          { _id: order.sessionId },
          { $set: { status: 'live' } },
        );
        await api(
          'admin',
          'POST',
          'admin/whiteboards/' +
            order.sessionId +
            '/versions/' +
            oldVersion +
            '/restore',
          {
            expectedSnapshotVersion: 2,
            expectedLastOperationSeq: 0,
            reason: 'Must not alter a live board.',
          },
          409,
        );
        await stack.bookings.classes.updateOne(
          { _id: order.sessionId },
          { $set: { status: 'completed' } },
        );
      },
    );
    await t.test(
      'controlled recovery is atomic, rejects stale state and retains a backup',
      async () => {
        await api(
          'admin',
          'POST',
          'admin/whiteboards/' +
            order.sessionId +
            '/versions/' +
            oldVersion +
            '/restore',
          {
            expectedSnapshotVersion: 1,
            expectedLastOperationSeq: 0,
            reason: 'This stale snapshot must fail.',
          },
          409,
        );
        const recovered = await api(
          'admin',
          'POST',
          'admin/whiteboards/' +
            order.sessionId +
            '/versions/' +
            oldVersion +
            '/restore',
          {
            expectedSnapshotVersion: 2,
            expectedLastOperationSeq: 0,
            reason: 'Recover the original teaching explanation.',
          },
        );
        assert.equal(recovered.board.snapshotVersion, 3);
        assert.equal(
          recovered.board.snapshot.pages[0].title,
          'Original algebra explanation',
        );
        assert.equal(recovered.versions.length, 4);
        assert.equal(
          recovered.versions.find(
            (item) => item.versionId === recovered.backupVersionId,
          ).recoveryBackup,
          true,
        );
        const backup = await api(
          'admin',
          'GET',
          'admin/whiteboards/' +
            order.sessionId +
            '/versions/' +
            recovered.backupVersionId,
        );
        assert.equal(backup.snapshot.pages[0].title, 'Revised explanation');
        const json = await fetch(
          stack.origin +
            '/api/v1/admin/whiteboards/' +
            order.sessionId +
            '/export',
          { headers: { authorization: 'Bearer ' + tokens.staff } },
        );
        assert.equal(json.status, 200);
        assert.equal(
          (await json.json()).pages[0].title,
          'Original algebra explanation',
        );
        assert.ok(
          await stack.connection.db.collection('audit_logs').findOne({
            action: 'admin.whiteboard.restored',
            targetId: order.sessionId,
          }),
        );
      },
    );
    await t.test(
      'role edits and deactivation affect active requests without token reissue',
      async () => {
        role = await api('admin', 'PATCH', 'admin/staff/roles/' + role.id, {
          name: role.name,
          description: role.description,
          status: 'active',
          permissions: ['admin:whiteboards:read', 'admin:whiteboards:restore'],
          version: role.version,
        });
        const me = await api('staff', 'GET', 'auth/me');
        assert.ok(me.permissions.includes('admin:whiteboards:restore'));
        role = await api('admin', 'PATCH', 'admin/staff/roles/' + role.id, {
          name: role.name,
          description: role.description,
          status: 'inactive',
          permissions: role.permissions,
          version: role.version,
        });
        await api('staff', 'GET', 'admin/whiteboards', undefined, 403);
        role = await api('admin', 'PATCH', 'admin/staff/roles/' + role.id, {
          name: role.name,
          description: role.description,
          status: 'active',
          permissions: ['admin:finance:read'],
          version: role.version,
        });
        await api('staff', 'GET', 'admin/bookings/finance');
        await api('staff', 'GET', 'admin/bookings', undefined, 403);
        await api('staff', 'POST', 'admin/invoices', {}, 403);
      },
    );
    await t.test(
      'booking pagination reaches records beyond 100 and filters/export remain truthful',
      async () => {
        const base = (
          await stack.bookings.orders.findById(order.id)
        ).toObject();
        const rows = Array.from({ length: 112 }, (_, index) => {
          const id = randomUUID();
          return {
            ...base,
            _id: id,
            requestId: randomUUID(),
            title: 'Archived admin search ' + index,
            studentName:
              index === 0 ? '=SUM(1,2)' : 'Archived learner ' + index,
            status: 'expired',
            paidAt: undefined,
            paymentIntentId: undefined,
            stripeSessionId: undefined,
            invoiceId: undefined,
            checkoutUrl: undefined,
            slotId: undefined,
            batchId: 'historical-batch',
            kind: 'batch',
            capacityReleased: true,
            nextReconcileAt: undefined,
            refundedMinor: 0,
            refundPendingMinor: 0,
            invoiceSource: {
              ...base.invoiceSource,
              orderId: id,
              paidAt: new Date(0),
              paymentReference: '',
            },
            createdAt: new Date('2025-01-01T00:00:00Z'),
            updatedAt: new Date('2025-01-01T00:00:00Z'),
          };
        });
        await stack.bookings.orders.insertMany(rows, { timestamps: false });
        const page = await api(
          'admin',
          'GET',
          'admin/bookings?search=Archived%20admin&status=expired&page=11&limit=10',
        );
        assert.equal(page.total, 112);
        assert.equal(page.items.length, 10);
        assert.equal(
          (
            await api(
              'admin',
              'GET',
              'admin/bookings?search=Archived%20admin&dateFrom=2025-01-01&dateTo=2025-01-01',
            )
          ).total,
          112,
        );
        await api(
          'admin',
          'GET',
          'admin/bookings?dateFrom=2025-02-31',
          undefined,
          400,
        );
        const csv = await fetch(
          stack.origin +
            '/api/v1/admin/bookings/export.csv?search=Archived%20admin',
          { headers: { authorization: 'Bearer ' + tokens.admin } },
        );
        assert.equal(csv.status, 200);
        assert.match(await csv.text(), /"'=SUM\(1,2\)"/);
      },
    );
    await t.test(
      'failed refund retry preserves history and rejects duplicate new retry requests',
      async () => {
        const Stripe = require('stripe');
        const original = stack.gateway.refund;
        await api('admin', 'POST', 'admin/bookings/' + order.id + '/refunds', {
          requestId: randomUUID(),
          amountMinor: 2000,
          reason: 'Synthetic refund rejection for retry.',
        });
        try {
          stack.gateway.refund = async () => {
            throw new Stripe.errors.StripeInvalidRequestError({
              type: 'invalid_request_error',
              message: 'Synthetic rejection',
            });
          };
          await stack.worker.tick();
        } finally {
          stack.gateway.refund = original;
        }
        const failed = await stack.bookings.refunds.findOne({
          orderId: order.id,
          status: 'failed',
        });
        assert.ok(failed);
        const requestId = randomUUID();
        await api(
          'admin',
          'POST',
          'admin/bookings/' + order.id + '/refunds/' + failed.id + '/retry',
          { requestId, reason: 'Retry after resolving provider rejection.' },
        );
        await api(
          'admin',
          'POST',
          'admin/bookings/' + order.id + '/refunds/' + failed.id + '/retry',
          { requestId, reason: 'Retry after resolving provider rejection.' },
        );
        await api(
          'admin',
          'POST',
          'admin/bookings/' + order.id + '/refunds/' + failed.id + '/retry',
          {
            requestId: randomUUID(),
            reason: 'Another retry must not duplicate this refund.',
          },
          409,
        );
        await stack.worker.tick();
        assert.equal(
          (await api('admin', 'GET', 'admin/bookings/' + order.id))
            .refundedMinor,
          2000,
        );
        assert.equal(
          await stack.bookings.refunds.countDocuments({
            orderId: order.id,
            status: 'succeeded',
          }),
          1,
        );
      },
    );
    await t.test(
      'financial reporting keeps JPY and EUR separate and uses confirmed cash activity',
      async () => {
        await paid('JPY', 1000);
        const report = await api('admin', 'GET', 'admin/bookings/finance');
        const euro = report.currencies.find((item) => item.currency === 'EUR'),
          yen = report.currencies.find((item) => item.currency === 'JPY');
        assert.equal(euro.collectedMinor, 6000);
        assert.equal(euro.refundedMinor, 2000);
        assert.equal(euro.netCollectedMinor, 4000);
        assert.equal(euro.failedRefunds, 0);
        assert.equal(yen.collectedMinor, 1200);
        assert.equal(yen.refundedMinor, 0);
        assert.equal(report.totals.paidBookings, 2);
        await api(
          'admin',
          'GET',
          'admin/bookings/finance?dateFrom=2020-01-01&dateTo=2026-11-25',
          undefined,
          400,
        );
        await api('student', 'GET', 'admin/bookings/finance', undefined, 403);
      },
    );
  },
);
