import type { TeacherPromotionPlacement } from './profile.js';
export const PROMOTION_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'JPY'] as const;
export interface PromotionPlan { id: string; revision: number; name: string; placement: TeacherPromotionPlacement; amountMinor: number; currency: typeof PROMOTION_CURRENCIES[number]; durationDays: number; enabled: boolean; autoApprove: boolean; automaticTax: boolean; taxCode?: string }
export type PromotionOrderStatus = 'awaiting_payment' | 'processing' | 'paid' | 'review' | 'expired' | 'refund_pending' | 'refunded';
export interface PromotionOrder { id: string; teacherId: string; plan: PromotionPlan; status: PromotionOrderStatus; startsAt: string; endsAt: string; expiresAt: string; createdAt: string; paidAt?: string; totalMinor?: number; taxMinor?: number; refundedMinor: number; refundPendingMinor: number; campaignId?: string; invoiceNumber?: string; invoiceReady: boolean; reviewReason?: string }
export interface PromotionTracking { token: string; campaignId: string; expiresAt: string }
export type PromotionEventKind = 'impression' | 'profile_click' | 'demo_open' | 'booking_click';
export interface PromotionAnalytics { campaignId: string; teacherId: string; from: string; to: string; impressions: number; profileClicks: number; demoOpens: number; bookingClicks: number; daily: Array<{ date: string; impressions: number; profileClicks: number; demoOpens: number; bookingClicks: number; }> }
