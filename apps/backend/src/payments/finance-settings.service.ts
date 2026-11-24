import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  DEFAULT_FINANCE_SETTINGS,
  MAX_COMMISSION_BPS,
  bpsToPercentLabel,
  commissionBpsForTeacher,
  isPaymentCurrency,
  type FinanceSettings,
  type FinanceSettingsUpdate,
} from '@native-sfu/contracts';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UserDocument, type UserMongoDocument } from '../database/schemas';
import { FinanceSettingsDocument } from './payment.schemas';

const SETTINGS_ID = 'default';

@Injectable()
export class FinanceSettingsService {
  constructor(
    @InjectModel(FinanceSettingsDocument.name) private readonly settingsModel: Model<FinanceSettingsDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    private readonly audit: AuditLogsService,
  ) {}

  async get(): Promise<FinanceSettings> {
    const doc = await this.settingsModel
      .findOneAndUpdate({ _id: SETTINGS_ID }, { $setOnInsert: { value: DEFAULT_FINANCE_SETTINGS } }, { upsert: true, new: true })
      .exec();
    return { ...DEFAULT_FINANCE_SETTINGS, ...doc!.value };
  }

  async commissionBpsFor(teacherId: string): Promise<number> {
    return commissionBpsForTeacher(await this.get(), teacherId);
  }

  async update(input: FinanceSettingsUpdate, actor: AuthenticatedUser): Promise<FinanceSettings> {
    const current = await this.get();
    if (current.version !== input.version) throw new ConflictException('Finance settings changed. Reload and try again.');
    this.assertBps(input.commissionBps, 'Platform commission');
    if (!Number.isInteger(input.holdDays) || input.holdDays < 0 || input.holdDays > 90) {
      throw new BadRequestException('The holding period must be between 0 and 90 days.');
    }
    if (!Number.isSafeInteger(input.minimumPayoutMinor) || input.minimumPayoutMinor < 100 || input.minimumPayoutMinor > 100_000_00) {
      throw new BadRequestException('The minimum payout must be between 1.00 and 100,000.00.');
    }
    const enabled = [...new Set(input.enabledCurrencies)];
    if (!enabled.every(isPaymentCurrency)) throw new BadRequestException('Choose only supported currencies.');
    if (!enabled.includes(current.defaultCurrency)) {
      throw new BadRequestException(`${current.defaultCurrency} is the default currency and must stay enabled.`);
    }

    const overrideIds = [...new Set(input.teacherOverrides.map((item) => item.teacherId.trim()))];
    if (overrideIds.length !== input.teacherOverrides.length) throw new BadRequestException('Each teacher can have only one commission override.');
    const teachers = overrideIds.length
      ? await this.users.find({ _id: { $in: overrideIds }, roles: 'TEACHER' }).select('_id displayName name email').exec()
      : [];
    if (teachers.length !== overrideIds.length) throw new BadRequestException('Commission overrides must reference existing teacher accounts.');
    const names = new Map(teachers.map((teacher) => [teacher.id as string, teacher.displayName ?? teacher.name ?? teacher.email]));
    const teacherOverrides = input.teacherOverrides.map((item) => {
      this.assertBps(item.commissionBps, 'Teacher commission');
      return { teacherId: item.teacherId.trim(), teacherName: names.get(item.teacherId.trim()), commissionBps: item.commissionBps };
    });

    const value: FinanceSettings = {
      ...current,
      version: current.version + 1,
      commissionBps: input.commissionBps,
      holdDays: input.holdDays,
      minimumPayoutMinor: input.minimumPayoutMinor,
      enabledCurrencies: enabled,
      teacherOverrides,
      updatedAt: new Date().toISOString(),
      updatedBy: actor.email || actor.sub,
    };
    const saved = await this.settingsModel
      .findOneAndUpdate({ _id: SETTINGS_ID, 'value.version': current.version }, { $set: { value } }, { new: true })
      .exec();
    if (!saved) throw new ConflictException('Finance settings changed. Reload and try again.');
    await this.audit.record({
      actor,
      action: 'finance.settings_updated',
      resourceType: 'finance_settings',
      resourceId: SETTINGS_ID,
      resourceLabel: `Commission ${bpsToPercentLabel(value.commissionBps)}`,
      metadata: {
        summary: `Commission ${bpsToPercentLabel(current.commissionBps)} → ${bpsToPercentLabel(value.commissionBps)}, hold ${value.holdDays} days`,
      },
      before: { commissionBps: current.commissionBps, holdDays: current.holdDays, minimumPayoutMinor: current.minimumPayoutMinor, enabledCurrencies: current.enabledCurrencies, teacherOverrides: current.teacherOverrides },
      after: { commissionBps: value.commissionBps, holdDays: value.holdDays, minimumPayoutMinor: value.minimumPayoutMinor, enabledCurrencies: value.enabledCurrencies, teacherOverrides: value.teacherOverrides },
    });
    return saved.value;
  }

  private assertBps(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_COMMISSION_BPS) {
      throw new BadRequestException(`${label} must be between 0% and 100% (0–10000 basis points).`);
    }
  }
}
