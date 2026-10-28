import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import type {
  TutorReviewStatus,
  TutorOnboardingNotice,
} from '@native-sfu/contracts';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { NotificationsService } from '../notifications/notifications.service';

export function tutorStatusNotice(
  status: TutorReviewStatus,
): UserDocument['tutorOnboardingNotices'][number] {
  const messages: Partial<Record<TutorReviewStatus, [string, string]>> = {
    submitted: [
      'Application received',
      'Your teaching profile has been submitted. We will notify you when the review is complete.',
    ],
    changes_requested: [
      'Changes requested',
      'Your reviewer has requested changes. Open your teaching profile to read the feedback and resubmit.',
    ],
    approved: [
      'Teaching profile approved',
      'Your teaching profile has been approved. Open your profile to check your public listing.',
    ],
    rejected: [
      'Application review complete',
      'Your teaching application has not been approved. Open your profile to read your reviewer’s feedback.',
    ],
  };
  const [title, body] = messages[status] ?? [
    'Teaching profile updated',
    'Open your teaching profile for the latest status.',
  ];
  return {
    id: randomUUID(),
    status,
    title,
    body,
    createdAt: new Date().toISOString(),
    emailStatus: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
  };
}
@Injectable()
export class TutorNoticesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TutorNoticesService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    @InjectModel(UserDocument.name)
    private readonly users: Model<UserMongoDocument>,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.process().catch(() =>
          this.logger.error(
            'Tutor notification delivery failed; queued notices will be retried.',
          ),
        ),
      this.config.get<number>('tutorVerification.notificationPollMs', 30_000),
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  kick() {
    setImmediate(
      () =>
        void this.process().catch(() =>
          this.logger.error(
            'Tutor notification delivery failed; queued notices will be retried.',
          ),
        ),
    );
  }
  async list(userId: string): Promise<TutorOnboardingNotice[]> {
    const user = await this.users
      .findById(userId)
      .select({ tutorOnboardingNotices: 1 })
      .exec();
    return [...(user?.tutorOnboardingNotices ?? [])]
      .reverse()
      .map(({ id, status, title, body, createdAt, readAt }) => ({
        id,
        status,
        title,
        body,
        createdAt,
        ...(readAt ? { readAt } : {}),
      }));
  }
  async read(userId: string, id: string) {
    await this.users
      .updateOne(
        { _id: userId, tutorOnboardingNotices: { $elemMatch: { id } } },
        {
          $set: { 'tutorOnboardingNotices.$.readAt': new Date().toISOString() },
        },
      )
      .exec();
    return { read: true };
  }
  async process() {
    if (
      this.busy ||
      !this.config.get<boolean>('notifications.email.enabled', false)
    )
      return;
    this.busy = true;
    try {
      const now = new Date();
      const eligible = {
        $or: [
          {
            emailStatus: { $in: ['pending', 'failed'] },
            nextAttemptAt: { $lte: now },
            attempts: { $lt: 6 },
          },
          {
            emailStatus: 'sending',
            leaseUntil: { $lte: now },
            attempts: { $lt: 6 },
          },
        ],
      };
      const candidates = await this.users
        .find({
          disabled: false,
          deletedAt: { $exists: false },
          tutorOnboardingNotices: { $elemMatch: eligible },
        })
        .select({ tutorOnboardingNotices: 1 })
        .limit(10)
        .exec();
      for (const user of candidates)
        for (const notice of user.tutorOnboardingNotices) {
          if (
            !(
              ['pending', 'failed'].includes(notice.emailStatus) &&
              new Date(notice.nextAttemptAt) <= now &&
              notice.attempts < 6
            ) &&
            !(
              notice.emailStatus === 'sending' &&
              notice.leaseUntil &&
              new Date(notice.leaseUntil) <= now &&
              notice.attempts < 6
            )
          )
            continue;
          const lease = randomUUID();
          const claimed = await this.users
            .updateOne(
              {
                _id: user.id,
                tutorOnboardingNotices: {
                  $elemMatch: { id: notice.id, ...eligible },
                },
              },
              {
                $set: {
                  'tutorOnboardingNotices.$.emailStatus': 'sending',
                  'tutorOnboardingNotices.$.leaseUntil': new Date(
                    Date.now() + 120_000,
                  ),
                  'tutorOnboardingNotices.$.deliveryLease': lease,
                },
                $inc: { 'tutorOnboardingNotices.$.attempts': 1 },
              },
            )
            .exec();
          if (!claimed.modifiedCount) continue;
          let status = 'failed';
          try {
            const origin = new URL(
              process.env.FRONTEND_URL || 'http://localhost:4200',
            ).origin;
            const summary = await this.notifications.sendEmailToUser(
              user.id,
              'tutor_application_update',
              {
                subject: `Sapiovian — ${notice.title}`,
                text: `${notice.body}\n\n${origin}/teacher/profile`,
              },
            );
            const result = summary.results.find((r) => r.channel === 'email');
            status = result?.delivered
              ? 'sent'
              : result?.skipped && !result?.errors.length
                ? 'skipped'
                : result?.skipped &&
                    result.errors.some((e) => e.includes('preferences'))
                  ? 'skipped'
                  : 'failed';
          } catch {
            status = 'failed';
          }
          await this.users
            .updateOne(
              {
                _id: user.id,
                tutorOnboardingNotices: {
                  $elemMatch: { id: notice.id, deliveryLease: lease },
                },
              },
              {
                $set: {
                  'tutorOnboardingNotices.$.emailStatus': status,
                  'tutorOnboardingNotices.$.nextAttemptAt': new Date(
                    Date.now() +
                      Math.min(3600_000, 30_000 * 2 ** notice.attempts),
                  ),
                },
                $unset: {
                  'tutorOnboardingNotices.$.leaseUntil': '',
                  'tutorOnboardingNotices.$.deliveryLease': '',
                },
              },
            )
            .exec();
        }
    } finally {
      this.busy = false;
    }
  }
}
