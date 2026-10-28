import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  randomUUID,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TeachingCatalogService } from './catalog.service';
import { EmailNotificationService } from '../notifications/email-notification.service';
import { UserDocument, UserMongoDocument } from '../database/schemas';
const exec = promisify(execFile);
@Injectable()
export class OnboardingReadinessService {
  constructor(
    private readonly config: ConfigService,
    private readonly catalog: TeachingCatalogService,
    private readonly email: EmailNotificationService,
    @InjectModel(UserDocument.name)
    private readonly users: Model<UserMongoDocument>,
  ) {}
  private async storage(path: string, encrypted = false) {
    const probe = join(path, `.onboarding-probe-${randomUUID()}`);
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const plain = randomBytes(32);
      let stored = plain;
      let key: Buffer | undefined;
      let iv: Buffer | undefined;
      let tag: Buffer | undefined;
      if (encrypted) {
        const encoded = this.config.get<string>(
          'tutorVerification.encryptionKey',
          '',
        );
        key = Buffer.from(encoded, 'base64');
        if (key.length !== 32 || key.toString('base64') !== encoded)
          return false;
        iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        stored = Buffer.concat([cipher.update(plain), cipher.final()]);
        tag = cipher.getAuthTag();
      }
      await writeFile(probe, stored, { mode: 0o600, flag: 'wx' });
      let result = await readFile(probe);
      if (encrypted) {
        const decipher = createDecipheriv('aes-256-gcm', key!, iv!);
        decipher.setAuthTag(tag!);
        result = Buffer.concat([decipher.update(result), decipher.final()]);
      }
      return result.equals(plain);
    } catch {
      return false;
    } finally {
      await unlink(probe).catch(() => undefined);
    }
  }
  async check() {
    const catalog = await this.catalog.snapshot();
    const entries = [...catalog.categories, ...(catalog.levels ?? [])];
    const unapproved = entries.filter(
      (e) => e.assessmentApproval?.version !== e.version,
    );
    const base = this.config.get<string>(
      'profileMedia.localPath',
      './profile-media',
    );
    const checks = {
      catalogue:
        catalog.categories.length > 0 &&
        catalog.subjects.length > 0 &&
        (catalog.levels?.length ?? 0) > 0 &&
        (catalog.languages?.length ?? 0) > 0,
      expertContentApproved: entries.length > 0 && unapproved.length === 0,
      privateVideoStorage: await this.storage(
        this.config.get<string>('profileMedia.introVideoPath') ||
          join(base, 'tutor-introductions'),
      ),
      encryptedVerificationStorage: await this.storage(
        this.config.get<string>('tutorVerification.localPath') ||
          join(base, 'tutor-verification'),
        true,
      ),
      videoValidator: await exec('ffprobe', ['-version'], {
        timeout: 5000,
        maxBuffer: 65536,
      }).then(
        () => true,
        () => false,
      ),
      documentValidator: await exec(
        this.config.get<string>('tutorVerification.pdfinfoPath', 'pdfinfo'),
        ['-v'],
        { timeout: 5000, maxBuffer: 65536 },
      ).then(
        () => true,
        () => false,
      ),
      smtpTransport: await this.email.verifyTransport(),
    };
    const failedNoticeUsers = await this.users
      .countDocuments({
        tutorOnboardingNotices: {
          $elemMatch: {
            emailStatus: { $in: ['pending', 'failed', 'sending'] },
            attempts: { $gte: 6 },
          },
        },
      })
      .exec();
    return {
      checkedAt: new Date().toISOString(),
      nodeId: this.config.get<string>(
        'cluster.nodeId',
        process.env.NODE_ID || 'local',
      ),
      technicalReady:
        Object.values(checks).every(Boolean) && failedNoticeUsers === 0,
      checks,
      unapprovedContentCount: unapproved.length,
      notificationDeliveryFailures: failedNoticeUsers,
      counts: {
        categories: catalog.categories.length,
        subjects: catalog.subjects.length,
        academicLevels: catalog.levels?.length ?? 0,
        languages: catalog.languages?.length ?? 0,
        curricula: catalog.curricula.length,
      },
      manualLaunchChecks: [
        'Record qualified subject-review sign-off for assessment content.',
        'Run and record a pilot with real teachers using their own content.',
        'Verify backup and restore, preserving the encryption key separately.',
        'Provision and validate the production environment and each API replica.',
      ],
    };
  }
}
