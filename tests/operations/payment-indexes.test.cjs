'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { setupPaymentIndexes } = require('../../scripts/setup-payments.cjs');
test('production payment index setup is repeatable, preserves records and enforces idempotency', { timeout: 60000 }, async () => {
  const uri = new URL('mongodb://127.0.0.1:27028/p0_indexes_' + randomUUID().replaceAll('-', '') + '?directConnection=true&replicaSet=p0-tests');
  const connection = await mongoose.createConnection(uri.toString(), { autoIndex: false }).asPromise();
  try {
    const first = await setupPaymentIndexes(connection);
    assert.equal(first.length, 10);
    const Payment = connection.model('PaymentDocument');
    const data = { _id: 'synthetic-payment', activeKey: 'student:batch', status: 'pending', gateway: 'test', currency: 'USD', amountMinor: 10000, commissionBps: 1500, commissionMinor: 1500, teacherMinor: 8500, studentId: 'student', studentName: 'Synthetic learner', studentEmail: 'learner@example.test', teacherId: 'teacher', teacherName: 'Synthetic teacher', batchId: 'batch', batchName: 'Synthetic class', description: 'Index acceptance' };
    await Payment.create(data);
    assert.deepEqual(await setupPaymentIndexes(connection), first);
    assert.equal(await Payment.countDocuments(), 1);
    await assert.rejects(Payment.create({ ...data, _id: 'duplicate-payment' }), error => error.code === 11000);
    assert.equal((await Payment.findById(data._id)).amountMinor, 10000);
  } finally { if (!connection.name.startsWith('p0_indexes_')) throw Error('Refusing to drop non-fixture database.'); await connection.dropDatabase(); await connection.close(); }
});
