/** A failed refund intent remains under review until a linked retry is pending/successful, or the booking is fully refunded. */
export function needsBookingRefundReview(refunds: ReadonlyArray<{ _id: string; retryOfRefundId?: string; status: string }>): boolean {
  const byId = new Map(refunds.map(refund => [String(refund._id), refund]));
  const groups = new Map<string, { failed: boolean; covered: boolean }>();
  for (const refund of refunds) {
    let root = String(refund._id), parent = refund.retryOfRefundId;
    const visited = new Set([root]);
    while (parent) {
      if (visited.has(parent)) return true;
      visited.add(parent); root = parent; parent = byId.get(parent)?.retryOfRefundId;
    }
    const group = groups.get(root) ?? { failed: false, covered: false };
    group.failed ||= refund.status === 'failed';
    group.covered ||= ['queued', 'pending', 'succeeded'].includes(refund.status);
    groups.set(root, group);
  }
  return [...groups.values()].some(group => group.failed && !group.covered);
}
