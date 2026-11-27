import { assertBalancedLedgerLines, splitCommission, type BookingEarningsPolicy, type BookingInvoiceSource, type CurrencyCode } from '@native-sfu/contracts';
import { assertBookingFacts, bookingCaptureEntry, bookingRefundAllocation, bookingRefundEntry, type BookingFinancialFacts } from './booking-ledger-entries';

function booking(currency: CurrencyCode, netMinor: number, taxMinor: number, bps = 1500): BookingFinancialFacts {
  const policy: BookingEarningsPolicy = { version: 1, settingsVersion: 1, commissionBps: bps, ...splitCommission(netMinor, bps), holdDays: 7, source: 'reservation' };
  return { id: 'booking-1', teacherId: 'teacher-1', title: 'Reserved lesson', invoiceSource: { netMinor, taxMinor, totalMinor: netMinor + taxMinor, currency } as BookingInvoiceSource, earningsPolicy: policy };
}

const at = new Date('2026-11-27T10:00:00Z');
describe('booking journal allocation', () => {
  it('keeps tax out of commission and the teacher liability', () => {
    const entry = bookingCaptureEntry(booking('EUR', 10000, 2000), at);
    expect(() => assertBalancedLedgerLines(entry.lines)).not.toThrow();
    expect(entry.paymentId).toBeUndefined();
    expect(entry.bookingOrderId).toBe('booking-1');
    expect(entry.lines.find(line => line.account === 'platform_revenue')?.creditMinor).toBe(1500);
    expect(entry.lines.find(line => line.account === 'teacher_pending')?.creditMinor).toBe(8500);
    expect(entry.lines.find(line => line.account === 'tax_payable')?.creditMinor).toBe(2000);
  });

  for (const [currency, net, tax] of [['USD', 19, 4], ['JPY', 101, 20], ['KWD', 1001, 200]] as const) it(`returns exactly the original split through one-minor-unit partial refunds in ${currency}`, () => {
    const order = booking(currency, net, tax, 3333);
    let priorGross = 0, priorTax = 0, priorNet = 0, priorCommission = 0, returnedTeacher = 0;
    for (let i = 0; i < net + tax; i++) {
      const cumulativeTax = Number((BigInt(++priorGross) * BigInt(tax) * 2n + BigInt(net + tax)) / (BigInt(net + tax) * 2n));
      const allocation = bookingRefundAllocation(order, { totalMinor: 1, taxMinor: cumulativeTax - priorTax }, { netMinor: priorNet, commissionMinor: priorCommission });
      const entry = bookingRefundEntry(order, 'refund-' + i, allocation, i % 2 === 0, at);
      expect(() => assertBalancedLedgerLines(entry.lines)).not.toThrow();
      priorTax = cumulativeTax; priorNet += allocation.netMinor; priorCommission += allocation.commissionMinor; returnedTeacher += allocation.teacherMinor;
    }
    expect(priorNet).toBe(net); expect(priorTax).toBe(tax);
    expect(priorCommission).toBe(order.earningsPolicy.commissionMinor);
    expect(returnedTeacher).toBe(order.earningsPolicy.teacherMinor);
  });

  for (const bps of [0, 10000]) it(`balances zero-value sides at ${bps} basis points`, () => {
    const order = booking('USD', 1, 0, bps);
    expect(() => assertBalancedLedgerLines(bookingCaptureEntry(order, at).lines)).not.toThrow();
  });

  it('rejects inconsistent policy snapshots and excessive credited net amounts', () => {
    const order = booking('EUR', 100, 20);
    expect(() => assertBookingFacts({ ...order, earningsPolicy: { ...order.earningsPolicy, teacherMinor: 100 } })).toThrow();
    expect(() => bookingRefundAllocation(order, { totalMinor: 121, taxMinor: 20 }, { netMinor: 0, commissionMinor: 0 })).toThrow();
    expect(() => bookingRefundAllocation(order, { totalMinor: 1, taxMinor: 2 }, { netMinor: 0, commissionMinor: 0 })).toThrow();
  });
});
