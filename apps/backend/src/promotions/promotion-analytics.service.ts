import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PromotionAnalytics, PromotionEventKind, PromotionTracking, PublicTeacherListItem } from '@native-sfu/contracts';
import { TeacherPromotionDocument, UserDocument } from '../database/schemas';
import { PromotionAnalyticsDaily, PromotionAnalyticsEvent } from './promotion.schema';
@Injectable()
export class PromotionAnalyticsService {
  constructor(@InjectConnection() private readonly connection: Connection, @InjectModel(TeacherPromotionDocument.name) private readonly campaigns: Model<TeacherPromotionDocument>, @InjectModel(UserDocument.name) private readonly users: Model<UserDocument>, @InjectModel(PromotionAnalyticsDaily.name) private readonly daily: Model<PromotionAnalyticsDaily>, @InjectModel(PromotionAnalyticsEvent.name) private readonly events: Model<PromotionAnalyticsEvent>, private readonly config: ConfigService) {}
  private live(teacherId?: string, placement?: string) { return { ...(teacherId ? { teacherId } : {}), ...(placement ? { placement } : {}), status: { $in: ['active', 'scheduled'] }, billingStatus: 'paid', approvedByUserId: { $type: 'string' }, paymentConfirmedAt: { $exists: true }, deletedAt: { $exists: false }, startsAt: { $lte: new Date() }, endsAt: { $gt: new Date() } }; }
  private sign(value: string) { return createHmac('sha256', this.config.getOrThrow<string>('jwt.accessSecret')).update('promotion-analytics-v1:' + value).digest(); }
  private token(campaign: TeacherPromotionDocument): PromotionTracking { const expiry = Math.floor(Date.now() / 1000) + 900, payload = Buffer.from(JSON.stringify({ campaignId: campaign.promotionId, teacherId: campaign.teacherId, nonce: randomUUID(), expiry })).toString('base64url'); return { campaignId: campaign.promotionId, expiresAt: new Date(expiry * 1000).toISOString(), token: payload + '.' + this.sign(payload).toString('base64url') }; }
  async profile(teacherId: string): Promise<PromotionTracking | undefined> { const campaign = await this.campaigns.findOne(this.live(teacherId, 'profile_badge')).lean(); return campaign ? this.token(campaign) : undefined; }
  async decorate(items: PublicTeacherListItem[], placement: string): Promise<PublicTeacherListItem[]> { const campaigns = await this.campaigns.find({ ...this.live(undefined, placement), teacherId: { $in: items.filter(item => item.promoted).map(item => item.teacherId) } }).lean(); return items.map(item => { const campaign = campaigns.find(row => row.teacherId === item.teacherId); return campaign ? { ...item, promotionTracking: this.token(campaign) } : item; }); }
  async record(token: string, kind: PromotionEventKind) {
    let facts: { campaignId: string; teacherId: string; nonce: string; expiry: number };
    try { const [payload, signature, extra] = token.split('.'); if (!payload) throw new Error(); const actual = Buffer.from(signature ?? '', 'base64url'), expected = this.sign(payload); if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error(); facts = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (!facts.nonce || !Number.isInteger(facts.expiry) || facts.expiry * 1000 < Date.now() || facts.expiry * 1000 > Date.now() + 901000) throw new Error(); }
    catch { throw new BadRequestException('Invalid or expired promotion event.'); }
    if (!await this.campaigns.exists({ ...this.live(facts.teacherId), promotionId: facts.campaignId }) || !await this.users.exists({ _id: facts.teacherId, roles: 'TEACHER', status: 'active', disabled: false, deletedAt: { $exists: false }, publicProfileEnabled: true, tutorReviewStatus: 'approved' })) return { accepted: false };
    const now = new Date(), date = now.toISOString().slice(0, 10), session = await this.connection.startSession();
    try { await session.withTransaction(async () => { const counts: Record<string, number> = {}; for (const event of new Set<PromotionEventKind>(['impression', kind])) { const key = facts.nonce + ':' + event; if (await this.events.exists({ _id: key }).session(session)) continue; await this.events.create([{ _id: key, campaignId: facts.campaignId, teacherId: facts.teacherId, kind: event, occurredAt: now, expiresAt: new Date(now.getTime() + 86400000) }], { session }); const field = { impression: 'impressions', profile_click: 'profileClicks', demo_open: 'demoOpens', booking_click: 'bookingClicks' }[event]; counts[field] = 1; } if (Object.keys(counts).length) await this.daily.updateOne({ _id: facts.campaignId + ':' + date }, { $setOnInsert: { campaignId: facts.campaignId, teacherId: facts.teacherId, date }, $inc: counts }, { upsert: true, session }); }); } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; } finally { await session.endSession(); } return { accepted: true };
  }
  async report(id: string, fromInput?: string, toInput?: string, owner?: string): Promise<PromotionAnalytics> {
    const campaign = await this.campaigns.findOne({ promotionId: id, ...(owner ? { teacherId: owner } : {}) }).lean(); if (!campaign) throw new NotFoundException('Campaign not found.');
    const to = toInput ?? new Date().toISOString().slice(0, 10), from = fromInput ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
    if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 365 * 86400000) throw new BadRequestException('Choose an ordered date range of up to 366 days.');
    const daily = await this.daily.find({ campaignId: id, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean();
    const result: PromotionAnalytics = { campaignId: id, teacherId: campaign.teacherId, from, to, impressions: 0, profileClicks: 0, demoOpens: 0, bookingClicks: 0, daily: daily.map(row => ({ date: row.date, impressions: row.impressions, profileClicks: row.profileClicks, demoOpens: row.demoOpens, bookingClicks: row.bookingClicks })) };
    for (const row of daily) { result.impressions += row.impressions; result.profileClicks += row.profileClicks; result.demoOpens += row.demoOpens; result.bookingClicks += row.bookingClicks; } return result;
  }
}
