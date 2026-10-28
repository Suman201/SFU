import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isValidObjectId, Model } from 'mongoose';
import type {
  TutorVerificationDocument,
  TutorVerificationKind,
} from '@native-sfu/contracts';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { invalidateTutorReview, saveTutorProfile } from './tutor-profile-state';
export const VERIFICATION_MAX_BYTES = 10 * 1024 * 1024;
const exec = promisify(execFile);
export type StoredVerificationDocument = TutorVerificationDocument & {
  fileName?: string;
  checksum?: string;
  viewedBy?: string[];
};
export function verificationDocumentSummary(
  document: StoredVerificationDocument,
): TutorVerificationDocument {
  const {
    id,
    kind,
    name,
    mimeType,
    size,
    uploadedAt,
    expiresAt,
    status,
    reviewNote,
    reviewedAt,
    reviewerId,
    purgedAt,
  } = document;
  return {
    id,
    kind,
    name,
    mimeType,
    size,
    uploadedAt,
    expiresAt,
    status,
    ...(reviewNote ? { reviewNote } : {}),
    ...(reviewedAt ? { reviewedAt } : {}),
    ...(reviewerId ? { reviewerId } : {}),
    ...(purgedAt ? { purgedAt } : {}),
    fileAvailable: !purgedAt && new Date(expiresAt) > new Date(),
  };
}
@Injectable()
export class VerificationDocumentsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(VerificationDocumentsService.name);
  private timer?: NodeJS.Timeout;
  constructor(
    @InjectModel(UserDocument.name)
    private readonly users: Model<UserMongoDocument>,
    private readonly config: ConfigService,
    private readonly audit: AuditLogsService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.purgeExpired().catch(() =>
          this.logger.error(
            'Private document retention cleanup failed; it will be retried.',
          ),
        ),
      this.config.get<number>('tutorVerification.sweepMs', 60_000),
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private key() {
    const encoded = this.config.get<string>(
      'tutorVerification.encryptionKey',
      '',
    );
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded)
      throw new ServiceUnavailableException(
        'Private document storage is not configured. Please contact support.',
      );
    return key;
  }
  private directory(id: string) {
    if (!isValidObjectId(id))
      throw new NotFoundException('Verification document not found.');
    return join(
      this.config.get<string>('tutorVerification.localPath') ||
        join(
          this.config.get<string>('profileMedia.localPath', './profile-media'),
          'tutor-verification',
        ),
      id,
    );
  }
  private async teacher(id: string) {
    if (!isValidObjectId(id))
      throw new NotFoundException('Verification document not found.');
    const user = await this.users
      .findOne({
        _id: id,
        roles: 'TEACHER',
        disabled: false,
        status: 'active',
        deletedAt: { $exists: false },
      })
      .exec();
    if (!user) throw new NotFoundException('Verification document not found.');
    return user;
  }
  private filePath(userId: string, document: StoredVerificationDocument) {
    if (
      !document.fileName ||
      !/^document-[a-f0-9-]{36}\.bin$/.test(document.fileName)
    )
      throw new NotFoundException('Verification document is unavailable.');
    return join(this.directory(userId), document.fileName);
  }
  private async validate(
    file: { buffer: Buffer; mimetype: string; size: number },
    temporary: string,
  ) {
    const bytes = file.buffer;
    const png =
      file.mimetype === 'image/png' &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg =
      file.mimetype === 'image/jpeg' &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255;
    const pdf =
      file.mimetype === 'application/pdf' &&
      /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString()) &&
      bytes.subarray(-2048).includes(Buffer.from('%%EOF'));
    if (!png && !jpeg && !pdf)
      throw new BadRequestException(
        'Upload a valid PDF, PNG or JPEG document.',
      );
    try {
      if (pdf) {
        const result = await exec(
          this.config.get<string>('tutorVerification.pdfinfoPath', 'pdfinfo'),
          [temporary],
          { timeout: 10_000, maxBuffer: 64 * 1024 },
        );
        const pages = Number(result.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
        if (!pages || pages > 10 || /^Encrypted:\s+yes/im.test(result.stdout))
          throw new Error('Invalid PDF');
      } else {
        const result = await exec(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'stream=width,height',
            '-of',
            'json',
            temporary,
          ],
          { timeout: 10_000, maxBuffer: 64 * 1024 },
        );
        const stream = JSON.parse(result.stdout).streams?.[0];
        if (
          !stream?.width ||
          !stream.height ||
          stream.width * stream.height > 40_000_000
        )
          throw new Error('Invalid image');
        await exec(
          'ffmpeg',
          ['-v', 'error', '-i', temporary, '-frames:v', '1', '-f', 'null', '-'],
          { timeout: 10_000, maxBuffer: 64 * 1024 },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ServiceUnavailableException(
          'Document validation is temporarily unavailable. Please try again later.',
        );
      throw new BadRequestException(
        'Use a readable PNG/JPEG image or an unencrypted PDF with at most 10 pages.',
      );
    }
  }
  async upload(
    actor: AuthenticatedUser,
    kind: string,
    file?: {
      buffer: Buffer;
      mimetype: string;
      size: number;
      originalname?: string;
    },
  ) {
    if (!['identity', 'qualification', 'safeguarding'].includes(kind))
      throw new BadRequestException(
        'Choose identity, qualification or safeguarding evidence.',
      );
    if (
      !file?.buffer?.length ||
      file.buffer.length > VERIFICATION_MAX_BYTES ||
      file.size > VERIFICATION_MAX_BYTES
    )
      throw new BadRequestException('Choose a PDF, PNG or JPEG up to 10 MB.');
    const key = this.key();
    const user = await this.teacher(actor.sub);
    const documents = user.tutorVerificationDocuments ?? [];
    if (
      documents.filter((d) => !d.purgedAt).reduce((sum, d) => sum + d.size, 0) +
        file.buffer.length >
      50 * 1024 * 1024
    )
      throw new BadRequestException(
        'Remove older verification files before uploading more than 50 MB.',
      );
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    if (
      documents.some(
        (d) =>
          d.kind === kind && (d as any).checksum === checksum && !d.purgedAt,
      )
    )
      throw new ConflictException('This document is already uploaded.');
    const id = randomUUID();
    // Validation uses a short-lived private temporary file; only ciphertext is persisted.
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const temp = await mkdtemp(join(tmpdir(), 'sapiovian-verification-'));
    try {
      const path = join(temp, 'upload');
      await writeFile(path, file.buffer, { mode: 0o600 });
      await this.validate(file, path);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${user.id}:${id}`));
    const ciphertext = Buffer.concat([
      Buffer.from([1]),
      iv,
      Buffer.alloc(16),
      cipher.update(file.buffer),
      cipher.final(),
    ]);
    cipher.getAuthTag().copy(ciphertext, 13);
    await mkdir(this.directory(user.id), { recursive: true, mode: 0o700 });
    const fileName = `document-${id}.bin`;
    const destination = join(this.directory(user.id), fileName);
    await writeFile(destination, ciphertext, { mode: 0o600, flag: 'wx' });
    const now = new Date();
    const document = {
      id,
      kind: kind as TutorVerificationKind,
      name: (file.originalname || `${kind}.pdf`)
        .replace(/[\x00-\x1f/\\]/g, '_')
        .slice(0, 120),
      mimeType: file.mimetype,
      size: file.buffer.length,
      uploadedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() +
          this.config.get<number>('tutorVerification.retentionDays', 30) *
            86400_000,
      ).toISOString(),
      status: 'pending' as const,
      fileName,
      checksum,
    };
    user.tutorVerificationDocuments = [...documents, document];
    invalidateTutorReview(user);
    try {
      await saveTutorProfile(user);
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    await this.audit.record({
      actor,
      action: 'tutor_verification.uploaded',
      resourceType: 'tutor_verification_document',
      resourceId: id,
      targetUserId: user.id,
      metadata: { kind },
    });
    return verificationDocumentSummary(document);
  }
  async read(actor: AuthenticatedUser, teacherId: string, id: string) {
    if (
      actor.sub !== teacherId &&
      !actor.roles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r))
    )
      throw new ForbiddenException(
        'Private verification documents are restricted to their owner and reviewers.',
      );
    const user = await this.teacher(teacherId);
    const document = user.tutorVerificationDocuments.find((d) => d.id === id);
    if (
      !document ||
      document.purgedAt ||
      new Date(document.expiresAt) <= new Date()
    )
      throw new NotFoundException(
        'Verification file has expired or was removed.',
      );
    let bytes: Buffer;
    try {
      const encrypted = await readFile(this.filePath(user.id, document));
      if (encrypted[0] !== 1 || encrypted.length < 30)
        throw new Error('Invalid encrypted file');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key(),
        encrypted.subarray(1, 13),
      );
      decipher.setAAD(Buffer.from(`${user.id}:${id}`));
      decipher.setAuthTag(encrypted.subarray(13, 29));
      bytes = Buffer.concat([
        decipher.update(encrypted.subarray(29)),
        decipher.final(),
      ]);
    } catch {
      throw new ServiceUnavailableException(
        'The private document could not be read. Please contact support.',
      );
    }
    await this.audit.record({
      actor,
      action: 'tutor_verification.downloaded',
      resourceType: 'tutor_verification_document',
      resourceId: id,
      targetUserId: user.id,
      metadata: { kind: document.kind },
    });
    if (actor.sub !== teacherId)
      await this.users
        .updateOne(
          { _id: user.id, 'tutorVerificationDocuments.id': id },
          { $addToSet: { 'tutorVerificationDocuments.$.viewedBy': actor.sub } },
        )
        .exec();
    return { bytes, mimeType: document.mimeType, name: document.name };
  }
  async review(
    actor: AuthenticatedUser,
    teacherId: string,
    id: string,
    decision: 'verified' | 'rejected',
    note: string,
  ) {
    if (note.trim().length < 20)
      throw new BadRequestException(
        'Add useful verification findings of at least 20 characters.',
      );
    if (actor.sub === teacherId)
      throw new BadRequestException('You cannot verify your own documents.');
    const user = await this.teacher(teacherId);
    const document = user.tutorVerificationDocuments.find((d) => d.id === id);
    if (
      !document ||
      document.purgedAt ||
      new Date(document.expiresAt) <= new Date()
    )
      throw new NotFoundException('Verification document is unavailable.');
    if (!document.viewedBy?.includes(actor.sub))
      throw new BadRequestException(
        'Download and inspect this document before recording the verification outcome.',
      );
    document.status = decision;
    document.reviewNote = note.trim();
    document.reviewerId = actor.sub;
    document.reviewedAt = new Date().toISOString();
    user.markModified('tutorVerificationDocuments');
    const priorStatus = user.tutorReviewStatus;
    invalidateTutorReview(user);
    if (priorStatus === 'submitted') user.tutorReviewStatus = 'submitted';
    await saveTutorProfile(user);
    await this.audit.record({
      actor,
      action: `tutor_verification.${decision}`,
      resourceType: 'tutor_verification_document',
      resourceId: id,
      targetUserId: user.id,
      metadata: { kind: document.kind },
    });
    return verificationDocumentSummary(document);
  }
  async remove(actor: AuthenticatedUser, id: string) {
    const user = await this.teacher(actor.sub);
    const document = user.tutorVerificationDocuments.find((d) => d.id === id);
    if (!document)
      throw new NotFoundException('Verification document not found.');
    user.tutorVerificationDocuments = user.tutorVerificationDocuments.filter(
      (d) => d.id !== id,
    );
    invalidateTutorReview(user);
    await saveTutorProfile(user);
    if (document.fileName)
      await unlink(this.filePath(user.id, document)).catch(() => undefined);
    await this.audit.record({
      actor,
      action: 'tutor_verification.removed',
      resourceType: 'tutor_verification_document',
      resourceId: id,
      targetUserId: user.id,
      metadata: { kind: document.kind },
    });
    return { removed: true };
  }
  async purgeExpired() {
    const now = new Date().toISOString();
    const users = await this.users
      .find({
        tutorVerificationDocuments: {
          $elemMatch: {
            expiresAt: { $lte: now },
            purgedAt: { $exists: false },
          },
        },
      })
      .limit(20)
      .exec();
    for (const user of users)
      for (const document of user.tutorVerificationDocuments) {
        if (document.purgedAt || document.expiresAt > now) continue;
        try {
          await unlink(this.filePath(user.id, document));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        }
        const updated = await this.users
          .updateOne(
            {
              _id: user.id,
              tutorVerificationDocuments: {
                $elemMatch: { id: document.id, purgedAt: { $exists: false } },
              },
            },
            {
              $set: { 'tutorVerificationDocuments.$.purgedAt': now },
              $unset: {
                'tutorVerificationDocuments.$.fileName': '',
                'tutorVerificationDocuments.$.viewedBy': '',
                'tutorVerificationDocuments.$.checksum': '',
              },
            },
          )
          .exec();
        if (updated.modifiedCount)
          await this.audit.record({
            action: 'tutor_verification.file_purged',
            resourceType: 'tutor_verification_document',
            resourceId: document.id,
            targetUserId: user.id,
            metadata: { kind: document.kind },
          });
      }
  }
}
