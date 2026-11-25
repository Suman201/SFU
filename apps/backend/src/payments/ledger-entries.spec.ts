import { splitCommission, splitRefund, toMinorUnits, type LedgerLine } from '@native-sfu/contracts';
import {
  disputeFeeEntry,
  disputeLostEntry,
  disputeOpenedEntry,
  disputeWonEntry,
  earningsReleasedEntry,
  gatewayFeeEntry,
  naturalBalance,
  paymentCapturedEntry,
  payoutPaidEntry,
  payoutReleasedEntry,
  payoutRequestedEntry,
  refundEntry,
  type LedgerEntryDraft,
  type PaymentFacts,
} from './ledger-entries';
import { batchPrice } from './batch-price';

/** Minimal in-memory ledger mirroring the idempotent unique-key behaviour of LedgerService. */
class MemoryLedger {
  private readonly entries = new Map<string, LedgerEntryDraft>();

  post(entry: LedgerEntryDraft): boolean {
    if (this.entries.has(entry.key)) return false;
    this.entries.set(entry.key, entry);
    return true;
  }

  balance(account: LedgerLine['account'], teacherId?: string): number {
    let debit = 0;
    let credit = 0;
    for (const entry of this.entries.values()) {
      for (const line of entry.lines) {
        if (line.account !== account || (teacherId && line.teacherId !== teacherId)) continue;
        debit += line.debitMinor;
        credit += line.creditMinor;
      }
    }
    return naturalBalance(account, debit, credit);
  }

  totals(): { debit: number; credit: number } {
    let debit = 0;
    let credit = 0;
    for (const entry of this.entries.values()) for (const line of entry.lines) {
      debit += line.debitMinor;
      credit += line.creditMinor;
    }
    return { debit, credit };
  }

  teacherTotal(teacherId: string): number {
    return ['teacher_pending', 'teacher_available', 'teacher_reserved', 'teacher_frozen'].reduce(
      (sum, account) => sum + this.balance(account as LedgerLine['account'], teacherId),
      0,
    );
  }
}

const at = new Date('2026-11-24T10:00:00.000Z');

function payment(amountMinor: number, commissionBps: number, id = 'pay_1'): PaymentFacts {
  const split = splitCommission(amountMinor, commissionBps);
  return { id, teacherId: 'teacher_1', currency: 'USD', amountMinor, description: 'Algebra batch', ...split };
}

describe('money helpers', () => {
  it('converts fees to integer cents without floating point drift', () => {
    expect(toMinorUnits(19.99, 'USD')).toBe(1999);
    expect(toMinorUnits(0.29, 'USD')).toBe(29);
    expect(toMinorUnits(1234.5, 'USD')).toBe(123450);
    expect(batchPrice({ feeAmount: 49.99, feeCurrency: 'USD' })).toEqual({ amountMinor: 4999, currency: 'USD' });
    expect(batchPrice({ feeAmount: 0, feeCurrency: 'USD' })).toEqual({ amountMinor: 0, currency: 'USD' });
    expect(batchPrice({ feeAmount: 10, currency: 'INR' })).toEqual({ amountMinor: 1000, currency: 'INR' });
    expect(() => batchPrice({ feeAmount: 10, currency: 'XYZ' })).toThrow('explicit supported payment currency');
  });

  it('rounds commission half-up and gives the teacher the exact remainder', () => {
    expect(splitCommission(10_000, 1500)).toEqual({ commissionMinor: 1500, teacherMinor: 8500 });
    expect(splitCommission(4999, 1500)).toEqual({ commissionMinor: 750, teacherMinor: 4249 });
    expect(splitCommission(1, 5000)).toEqual({ commissionMinor: 1, teacherMinor: 0 });
    expect(splitCommission(999, 0)).toEqual({ commissionMinor: 0, teacherMinor: 999 });
    expect(splitCommission(999, 10_000)).toEqual({ commissionMinor: 999, teacherMinor: 0 });
    for (let gross = 0; gross < 3000; gross += 7) {
      const split = splitCommission(gross, 1234);
      expect(split.commissionMinor + split.teacherMinor).toBe(gross);
    }
    expect(() => splitCommission(100, 10_001)).toThrow();
    expect(() => splitCommission(1.5, 100)).toThrow();
  });

  it('allocates partial refunds so a full refund returns exactly the original split', () => {
    const facts = payment(4999, 1500);
    let refundedMinor = 0;
    let refundedCommissionMinor = 0;
    let refundedTeacherMinor = 0;
    for (const amount of [1000, 333, 1, 3665]) {
      const part = splitRefund({ amountMinor: facts.amountMinor, commissionMinor: facts.commissionMinor, refundedMinor, refundedCommissionMinor }, amount);
      expect(part.commissionMinor + part.teacherMinor).toBe(amount);
      refundedMinor += amount;
      refundedCommissionMinor += part.commissionMinor;
      refundedTeacherMinor += part.teacherMinor;
    }
    expect(refundedMinor).toBe(facts.amountMinor);
    expect(refundedCommissionMinor).toBe(facts.commissionMinor);
    expect(refundedTeacherMinor).toBe(facts.teacherMinor);
    expect(() => splitRefund({ amountMinor: 100, commissionMinor: 15, refundedMinor: 90, refundedCommissionMinor: 13 }, 11)).toThrow();
  });
});

describe('ledger entries', () => {
  it('records a full payment, fee, release and payout lifecycle that stays balanced', () => {
    const ledger = new MemoryLedger();
    const facts = payment(10_000, 1500);
    expect(ledger.post(paymentCapturedEntry(facts, at))).toBe(true);
    // Replaying the same webhook must not double count.
    expect(ledger.post(paymentCapturedEntry(facts, at))).toBe(false);
    ledger.post(gatewayFeeEntry(facts, 320, at));
    expect(ledger.balance('teacher_pending', 'teacher_1')).toBe(8500);
    expect(ledger.balance('platform_revenue')).toBe(1500);
    expect(ledger.balance('gateway_clearing')).toBe(9680);

    ledger.post(earningsReleasedEntry(facts, 8500, at));
    expect(ledger.balance('teacher_pending', 'teacher_1')).toBe(0);
    expect(ledger.balance('teacher_available', 'teacher_1')).toBe(8500);

    const payout = { id: 'po_1', teacherId: 'teacher_1', currency: 'USD' as const, amountMinor: 8000 };
    ledger.post(payoutRequestedEntry(payout, at));
    expect(ledger.balance('teacher_available', 'teacher_1')).toBe(500);
    expect(ledger.balance('teacher_reserved', 'teacher_1')).toBe(8000);
    ledger.post(payoutPaidEntry(payout, at));
    expect(ledger.balance('teacher_reserved', 'teacher_1')).toBe(0);
    // Platform keeps commission minus the processing fee it bears, plus what it still owes the teacher.
    expect(ledger.balance('gateway_clearing')).toBe(1500 - 320 + 500);
    expect(ledger.teacherTotal('teacher_1')).toBe(500);
    const totals = ledger.totals();
    expect(totals.debit).toBe(totals.credit);
  });

  it('returns a rejected payout to the available balance', () => {
    const ledger = new MemoryLedger();
    const facts = payment(5000, 2000);
    ledger.post(paymentCapturedEntry(facts, at));
    ledger.post(earningsReleasedEntry(facts, facts.teacherMinor, at));
    const payout = { id: 'po_2', teacherId: 'teacher_1', currency: 'USD' as const, amountMinor: 4000 };
    ledger.post(payoutRequestedEntry(payout, at));
    ledger.post(payoutReleasedEntry(payout, 'Rejected', at));
    expect(ledger.balance('teacher_available', 'teacher_1')).toBe(4000);
    expect(ledger.balance('teacher_reserved', 'teacher_1')).toBe(0);
  });

  it('reverses commission and teacher share on refunds from either bucket', () => {
    const ledger = new MemoryLedger();
    const facts = payment(4999, 1500);
    ledger.post(paymentCapturedEntry(facts, at));
    const first = { id: 'rf_1', amountMinor: 2000, ...splitRefund({ amountMinor: 4999, commissionMinor: facts.commissionMinor, refundedMinor: 0, refundedCommissionMinor: 0 }, 2000) };
    ledger.post(refundEntry(facts, first, 'teacher_pending', at));
    ledger.post(earningsReleasedEntry(facts, ledger.balance('teacher_pending', 'teacher_1'), at));
    const second = {
      id: 'rf_2',
      amountMinor: 2999,
      ...splitRefund({ amountMinor: 4999, commissionMinor: facts.commissionMinor, refundedMinor: 2000, refundedCommissionMinor: first.commissionMinor }, 2999),
    };
    ledger.post(refundEntry(facts, second, 'teacher_available', at));
    expect(ledger.balance('platform_revenue')).toBe(0);
    expect(ledger.teacherTotal('teacher_1')).toBe(0);
    expect(ledger.balance('gateway_clearing')).toBe(0);
  });

  it('freezes the teacher share during a dispute and releases or reverses it', () => {
    const won = new MemoryLedger();
    const facts = payment(10_000, 1500);
    const dispute = { id: 'dp_1', amountMinor: 10_000, frozenTeacherMinor: 8500, frozenCommissionMinor: 1500 };
    won.post(paymentCapturedEntry(facts, at));
    won.post(disputeOpenedEntry(facts, dispute, 'teacher_pending', at));
    won.post(disputeFeeEntry(facts, dispute.id, 1500, at));
    expect(won.balance('teacher_pending', 'teacher_1')).toBe(0);
    expect(won.balance('teacher_frozen', 'teacher_1')).toBe(8500);
    expect(won.balance('dispute_hold')).toBe(10_000);
    won.post(disputeWonEntry(facts, dispute, 'teacher_pending', at));
    expect(won.balance('teacher_pending', 'teacher_1')).toBe(8500);
    expect(won.balance('teacher_frozen', 'teacher_1')).toBe(0);
    expect(won.balance('dispute_hold')).toBe(0);

    const lost = new MemoryLedger();
    lost.post(paymentCapturedEntry(facts, at));
    lost.post(disputeOpenedEntry(facts, dispute, 'teacher_pending', at));
    lost.post(disputeLostEntry(facts, dispute, at));
    expect(lost.teacherTotal('teacher_1')).toBe(0);
    expect(lost.balance('platform_revenue')).toBe(0);
    expect(lost.balance('dispute_hold')).toBe(0);
    expect(lost.balance('gateway_clearing')).toBe(0);
  });

  it('rejects unbalanced or malformed lines', () => {
    const facts = payment(1000, 1000);
    expect(() => earningsReleasedEntry(facts, -5, at)).toThrow();
    expect(() => gatewayFeeEntry(facts, 1.5, at)).toThrow();
  });
});
