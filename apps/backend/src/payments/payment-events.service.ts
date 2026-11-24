import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { GatewayEventRecord, PageResult, PaymentGatewayId } from '@native-sfu/contracts';
import { PAYMENT_GATEWAY, type GatewayEvent, type PaymentGateway } from './gateways/payment-gateway';
import { GatewayEventDocument, type GatewayEventMongo } from './payment.schemas';
import { PaymentBusyError, PaymentsService } from './payments.service';
import { PayoutsService } from './payouts.service';

const MAX_ATTEMPTS = 8;

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

/**
 * Stores verified gateway notifications exactly once and applies them with
 * retries. The HTTP handler only verifies and stores, so the gateway always
 * gets a fast acknowledgement; processing failures are retried with backoff
 * and surface in the admin reconciliation view after the last attempt.
 */
@Injectable()
export class PaymentEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentEventsService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastSweep = 0;

  constructor(
    @InjectModel(GatewayEventDocument.name) private readonly events: Model<GatewayEventMongo>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), this.config.get<number>('payments.eventPollMs', 5000));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Verifies a webhook, stores it and attempts to apply it immediately. */
  async ingestWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ received: true; duplicate: boolean }> {
    const event = this.gateway.parseWebhook(rawBody, headers);
    return this.ingest(this.gateway.id, event);
  }

  async ingest(gateway: PaymentGatewayId, event: GatewayEvent): Promise<{ received: true; duplicate: boolean }> {
    const id = `${gateway}:${event.eventId}`;
    try {
      await this.events.create({
        _id: id,
        gateway,
        type: event.kind === 'ignored' ? event.type : event.kind,
        event: event as unknown as Record<string, unknown>,
        status: event.kind === 'ignored' ? 'ignored' : 'pending',
      });
    } catch (error) {
      if (isDuplicateKey(error)) return { received: true, duplicate: true };
      throw error;
    }
    if (event.kind !== 'ignored') await this.process(id);
    return { received: true, duplicate: false };
  }

  /** Applies one stored event if it is due. Never throws. */
  async process(id: string): Promise<void> {
    const token = randomUUID();
    const now = new Date();
    const claimed = await this.events
      .findOneAndUpdate(
        {
          _id: id,
          attempts: { $lt: MAX_ATTEMPTS },
          $or: [
            { status: 'pending', nextAttemptAt: { $lte: now } },
            { status: 'processing', leaseUntil: { $lt: now } },
          ],
        },
        { $set: { status: 'processing', leaseToken: token, leaseUntil: new Date(now.getTime() + 120_000) }, $inc: { attempts: 1 } },
        { new: true },
      )
      .exec();
    if (!claimed) return;
    const event = claimed.event as unknown as GatewayEvent;
    try {
      let paymentId: string | undefined;
      if (event.kind === 'payout_account.updated' || event.kind === 'transfer.reversed') {
        await this.payouts.applyEvent(event);
      } else {
        paymentId = await this.payments.applyEvent(event);
      }
      await this.events
        .updateOne(
          { _id: id, leaseToken: token },
          { $set: { status: 'done', processedAt: new Date(), ...(paymentId ? { paymentId } : {}) }, $unset: { leaseToken: '', leaseUntil: '', lastError: '' } },
        )
        .exec();
    } catch (error) {
      const busy = error instanceof PaymentBusyError;
      const message = (error instanceof Error ? error.message : 'Unknown error').slice(0, 500);
      const exhausted = !busy && claimed.attempts >= MAX_ATTEMPTS;
      const delay = busy ? 2_000 : Math.min(3_600_000, 5_000 * 2 ** (claimed.attempts - 1));
      await this.events
        .updateOne(
          { _id: id, leaseToken: token },
          {
            $set: { status: exhausted ? 'failed' : 'pending', lastError: message, nextAttemptAt: new Date(Date.now() + delay) },
            ...(busy ? { $inc: { attempts: -1 } } : {}),
            $unset: { leaseToken: '', leaseUntil: '' },
          },
        )
        .exec();
      if (!busy) this.logger.warn(`Payment event ${id} failed (attempt ${claimed.attempts}): ${message}`);
    }
  }

  async retry(id: string): Promise<GatewayEventRecord> {
    const updated = await this.events
      .findOneAndUpdate({ _id: id, status: { $in: ['failed', 'pending'] } }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date() } }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Only failed or waiting events can be retried.');
    await this.process(id);
    return this.toRecord((await this.events.findById(id).exec())!);
  }

  toRecord(doc: GatewayEventMongo): GatewayEventRecord {
    return {
      id: doc.id,
      gateway: doc.gateway,
      type: doc.type,
      status: doc.status,
      attempts: doc.attempts,
      lastError: doc.lastError,
      receivedAt: doc.receivedAt.toISOString(),
      processedAt: doc.processedAt?.toISOString(),
      paymentId: doc.paymentId,
    };
  }

  async list(query: { page?: number; status?: string }): Promise<PageResult<GatewayEventRecord>> {
    const limit = 50;
    const page = Math.max(1, Math.min(10_000, Math.floor(Number(query.page) || 1)));
    const filter: Record<string, unknown> = {};
    if (query.status && query.status !== 'all') filter.status = query.status;
    const [docs, total] = await Promise.all([
      this.events.find(filter).sort({ receivedAt: -1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.events.countDocuments(filter).exec(),
    ]);
    return { items: docs.map((doc) => this.toRecord(doc)), total, page, limit };
  }

  async failedEvents(limit = 50): Promise<GatewayEventRecord[]> {
    const docs = await this.events.find({ status: 'failed' }).sort({ receivedAt: -1 }).limit(limit).exec();
    return docs.map((doc) => this.toRecord(doc));
  }

  async countFailed(): Promise<number> {
    return this.events.countDocuments({ status: 'failed' }).exec();
  }

  /** Background loop: due events, settlement repair, earnings release and receipt emails. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.events
        .find({
          attempts: { $lt: MAX_ATTEMPTS },
          $or: [
            { status: 'pending', nextAttemptAt: { $lte: new Date() } },
            { status: 'processing', leaseUntil: { $lt: new Date() } },
          ],
        })
        .sort({ receivedAt: 1 })
        .select('_id')
        .limit(25)
        .exec();
      for (const { id } of due) await this.process(id);

      if (!this.config.get<boolean>('payments.enabled', false)) return;
      if (Date.now() - this.lastSweep >= 30_000) {
        this.lastSweep = Date.now();
        await this.payments.sweep();
        await this.payments.releaseDueEarnings();
      }
      await this.payments.sendDueReceiptEmails();
    } catch (error) {
      this.logger.error(`Payment background work failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.busy = false;
    }
  }
}
