import type { CurrencyCode } from './money.js';
import type { BookingOrder } from './bookings.js';
import type {
  WhiteboardMemoryState,
  WhiteboardMemorySnapshot,
  WhiteboardMemoryVersion,
} from './whiteboard-memory.js';

export const ADMIN_PORTAL_PERMISSIONS = [
  'admin:dashboard:read',
  'admin:whiteboards:read',
  'admin:whiteboards:restore',
  'admin:bookings:read',
  'admin:bookings:refund',
  'admin:bookings:reconcile',
  'admin:finance:read',
  'admin:finance:write',
  'admin:users:read',
  'admin:users:write',
  'admin:teaching:read',
  'admin:teaching:write',
  'admin:attendance:read',
  'admin:recordings:read',
  'admin:recordings:write',
  'admin:library:read',
  'admin:content:read',
  'admin:content:write',
  'admin:support:read',
  'admin:support:write',
  'admin:audit:read',
  'admin:errors:read',
  'admin:errors:write',
  'admin:system:access',
] as const;
export type AdminPortalPermission = (typeof ADMIN_PORTAL_PERMISSIONS)[number];
export interface AdminStaffRole {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: 'active' | 'inactive';
  version: number;
  permissions: AdminPortalPermission[];
  assignedUsers: number;
}
export interface AdminStaffMember {
  id: string;
  name: string;
  email: string;
  status: string;
  disabled: boolean;
  adminRoleId?: string;
  adminRoleName?: string;
}
export interface AdminStaffRoleInput {
  name: string;
  description: string;
  status: 'active' | 'inactive';
  permissions: AdminPortalPermission[];
  version?: number;
}
export interface AdminBookingQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: BookingOrder['status'] | 'all';
  kind?: 'lesson' | 'batch' | 'all';
  currency?: CurrencyCode;
  dateFrom?: string;
  dateTo?: string;
  refundStatus?: 'queued' | 'pending' | 'failed' | 'succeeded';
}
export interface AdminBookingDetail extends BookingOrder {
  reviewReason?: string;
  reconciliationDueAt?: string;
  providerSessionId?: string;
  providerPaymentId?: string;
  providerDashboardUrl?: string;
}
export interface AdminBookingPage {
  items: AdminBookingDetail[];
  page: number;
  limit: number;
  total: number;
}
export interface AdminFinanceCurrency {
  currency: CurrencyCode;
  paidBookings: number;
  collectedMinor: number;
  refundedMinor: number;
  netCollectedMinor: number;
  confirmedRefunds: number;
  pendingRefundMinor: number;
  failedRefunds: number;
}
export interface AdminFinanceDay {
  date: string;
  createdBookings: number;
  paidBookings: number;
  cancellations: number;
  currency: CurrencyCode;
  collectedMinor: number;
  refundedMinor: number;
  netCollectedMinor: number;
}
export interface AdminFinanceReport {
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  currencies: AdminFinanceCurrency[];
  days: AdminFinanceDay[];
  totals: {
    createdBookings: number;
    paidBookings: number;
    cancellations: number;
    paymentReviews: number;
  };
  basis: string;
}
export interface AdminWhiteboardReview {
  session: {
    id: string;
    batchId: string;
    title: string;
    status: string;
    teacherId: string;
  };
  board: WhiteboardMemoryState | null;
  versions: Array<WhiteboardMemoryVersion & { recoveryBackup?: boolean }>;
  canRestore: boolean;
}
export interface AdminWhiteboardVersionPreview {
  version: WhiteboardMemoryVersion;
  snapshot: WhiteboardMemorySnapshot;
}
