import { needsBookingRefundReview } from './refund-review';
describe('booking refund review', () => {
  it('keeps failed intents on hold until a linked retry resolves them', () => {
    const original = { _id: 'a', status: 'failed' };
    expect(needsBookingRefundReview([original])).toBe(true);
    expect(needsBookingRefundReview([original, { _id: 'b', retryOfRefundId: 'a', status: 'pending' }])).toBe(false);
    expect(needsBookingRefundReview([original, { _id: 'b', retryOfRefundId: 'a', status: 'failed' }, { _id: 'c', retryOfRefundId: 'b', status: 'succeeded' }])).toBe(false);
  });
  it('does not use an unrelated successful refund to dismiss a failed intent', () => {
    expect(needsBookingRefundReview([{ _id: 'a', status: 'failed' }, { _id: 'b', status: 'succeeded' }])).toBe(true);
  });
  it('retains review for a corrupt retry cycle', () => {
    expect(needsBookingRefundReview([{ _id: 'a', retryOfRefundId: 'b', status: 'failed' }, { _id: 'b', retryOfRefundId: 'a', status: 'pending' }])).toBe(true);
  });
});
