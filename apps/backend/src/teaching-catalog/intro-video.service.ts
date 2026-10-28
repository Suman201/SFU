import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import {
  invalidateTutorReview,
  saveTutorProfile,
} from './applications.service';
export const INTRO_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
type VideoFile = { buffer: Buffer; mimetype: string; size: number };
@Injectable()
export class IntroVideoService {
  constructor(
    @InjectModel(UserDocument.name)
    private readonly users: Model<UserMongoDocument>,
    private readonly config: ConfigService,
  ) {}
  private directory(id: string) {
    if (!isValidObjectId(id))
      throw new NotFoundException('Introduction video not found.');
    return join(
      this.config.get<string>('profileMedia.introVideoPath') ||
        join(
          this.config.get<string>('profileMedia.localPath', './profile-media'),
          'tutor-introductions',
        ),
      id,
    );
  }
  private async teacher(id: string, publicOnly = false) {
    if (!isValidObjectId(id))
      throw new NotFoundException('Introduction video not found.');
    const doc = await this.users
      .findOne({
        _id: id,
        roles: 'TEACHER',
        status: 'active',
        disabled: false,
        deletedAt: { $exists: false },
        ...(publicOnly
          ? { publicProfileEnabled: true, tutorReviewStatus: 'approved' }
          : {}),
      })
      .exec();
    if (!doc) throw new NotFoundException('Introduction video not found.');
    return doc;
  }
  async cleanup(id: string, video: UserDocument['tutorIntroVideo']) {
    if (!video || !/^intro-[a-f0-9-]+\.(mp4|webm)$/.test(video.fileName))
      return;
    await unlink(join(this.directory(id), video.fileName)).catch(
      () => undefined,
    );
  }
  async upload(id: string, file?: VideoFile) {
    if (
      !file?.buffer?.length ||
      file.size > INTRO_VIDEO_MAX_BYTES ||
      file.buffer.length > INTRO_VIDEO_MAX_BYTES
    )
      throw new BadRequestException('Choose an MP4 or WebM video up to 50 MB.');
    const mp4 =
      file.mimetype === 'video/mp4' &&
      file.buffer.toString('ascii', 4, 8) === 'ftyp';
    const webm =
      file.mimetype === 'video/webm' &&
      file.buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!mp4 && !webm)
      throw new BadRequestException('Upload a valid MP4 or WebM video.');
    const doc = await this.teacher(id),
      previous = doc.tutorIntroVideo;
    await mkdir(this.directory(id), { recursive: true });
    const fileName = `intro-${randomUUID()}.${mp4 ? 'mp4' : 'webm'}`;
    const filePath = join(this.directory(id), fileName);
    await writeFile(filePath, file.buffer, { mode: 0o600 });
    let durationSeconds: number;
    try {
      const result = await promisify(execFile)(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type,codec_name',
          '-of',
          'json',
          filePath,
        ],
        { timeout: 15000, maxBuffer: 128 * 1024 },
      );
      const metadata = JSON.parse(result.stdout);
      durationSeconds = Number(metadata.format?.duration);
      if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds > 180 ||
        !metadata.streams?.some(
          (s: { codec_type: string; codec_name: string }) =>
            s.codec_type === 'video' &&
            ['h264', 'vp8', 'vp9', 'av1'].includes(s.codec_name),
        )
      )
        throw new BadRequestException(
          'Use a playable MP4/WebM video no longer than 3 minutes.',
        );
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ServiceUnavailableException(
          'Video validation is temporarily unavailable. Use a video link or try again later.',
        );
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        'This video could not be read. Export it as MP4 or WebM and try again.',
      );
    }
    doc.tutorIntroVideo = {
      fileName,
      mimeType: file.mimetype,
      size: file.buffer.length,
      durationSeconds,
    };
    doc.introVideoUrl = undefined;
    invalidateTutorReview(doc);
    try {
      await saveTutorProfile(doc);
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
    await this.cleanup(id, previous);
    return {
      introVideoUploaded: true,
      introVideoDurationSeconds: durationSeconds,
    };
  }
  async remove(id: string) {
    const doc = await this.teacher(id),
      previous = doc.tutorIntroVideo;
    doc.tutorIntroVideo = undefined;
    doc.introVideoUrl = undefined;
    invalidateTutorReview(doc);
    await saveTutorProfile(doc);
    await this.cleanup(id, previous);
    return { removed: true };
  }
  async read(id: string, publicOnly: boolean, range?: string) {
    const doc = await this.teacher(id, publicOnly),
      video = doc.tutorIntroVideo;
    if (!video || !/^intro-[a-f0-9-]+\.(mp4|webm)$/.test(video.fileName))
      throw new NotFoundException('Introduction video not found.');
    const file = join(this.directory(id), video.fileName);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile())
      throw new NotFoundException('Introduction video not found.');
    const size = info.size;
    let start = 0,
      end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return { status: 416, size };
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      } else {
        const suffix = Number(match[2]);
        if (suffix <= 0) return { status: 416, size };
        start = Math.max(0, size - suffix);
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start >= size ||
        start > end
      )
        return { status: 416, size };
    }
    return {
      status: range ? 206 : 200,
      size,
      start,
      end,
      mimeType: video.mimeType,
      stream: createReadStream(file, { start, end }),
    };
  }
}
