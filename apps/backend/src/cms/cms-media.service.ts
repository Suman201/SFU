import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile, access } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { CmsMedia, CmsMediaPage, CmsPageBlock } from '@native-sfu/contracts';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CmsPageDocument, CmsPageMongoDocument } from '../database/schemas';
import { assertClassroomUploadSafe } from '../common/security/upload-scanner';
import { CmsMediaDocument, CmsMediaMongo } from './cms-media.schema';
const PREFIX = '/api/v1/cms/media/';
@Injectable()
export class CmsMediaService {
  constructor(@InjectModel(CmsMediaDocument.name) private readonly media: Model<CmsMediaMongo>, @InjectModel(CmsPageDocument.name) private readonly pages: Model<CmsPageMongoDocument>, private readonly config: ConfigService, private readonly audit: AuditLogsService) {}
  private root(): string { return resolve(this.config.get<string>('profileMedia.localPath', './profile-media'), 'cms-library'); }
  private file(row: Pick<CmsMediaDocument, '_id' | 'extension'>): string { return resolve(this.root(), row._id + '.' + row.extension); }
  private dto(row: CmsMediaDocument): CmsMedia { return { id: row._id, title: row.title, altText: row.altText, fileName: row.fileName, mimeType: row.mimeType, size: row.size, revision: row.revision, archived: Boolean(row.archivedAt), url: PREFIX + row._id, createdAt: row.createdAt.toISOString() }; }
  async list(input: { page?: string; q?: string; archived?: string }): Promise<CmsMediaPage> {
    const page = Number(input.page ?? 1), limit = 24;
    if (!Number.isInteger(page) || page < 1 || page > 10000 || (input.q?.length ?? 0) > 80) throw new BadRequestException('Choose a valid media search.');
    const filter: Record<string, unknown> = input.archived === 'true' ? {} : { archivedAt: { $exists: false } };
    if (input.q?.trim()) { const pattern = { $regex: input.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }; filter.$or = [{ title: pattern }, { altText: pattern }, { fileName: pattern }]; }
    const [items, total] = await Promise.all([this.media.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.media.countDocuments(filter)]);
    return { items: items.map(item => this.dto(item)), total, page, limit };
  }
  async upload(user: AuthenticatedUser, file: { buffer: Buffer; originalname?: string } | undefined, input: { title: string; altText: string }): Promise<CmsMedia> {
    if (!file?.buffer || !file.buffer.length || file.buffer.length > 5 * 1024 * 1024) throw new BadRequestException('Upload a PNG, JPEG or WebP image up to 5 MB.');
    const bytes = file.buffer; let mimeType = '', extension = '';
    if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 8000 || height > 8000 || width * height > 32000000) throw new BadRequestException('Use an image no larger than 8000 pixels per side and 32 megapixels.');
      mimeType = 'image/png'; extension = 'png';
    } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'))) { mimeType = 'image/jpeg'; extension = 'jpg'; }
    else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) { mimeType = 'image/webp'; extension = 'webp'; }
    else throw new BadRequestException('The file is not a supported image. SVG and HTML uploads are not accepted.');
    this.dimensions(bytes, extension);
    await assertClassroomUploadSafe(bytes, this.config);
    const digest = createHash('sha256').update(bytes).digest('hex'), existing = await this.media.findOne({ digest });
    if (existing?.archivedAt) throw new ConflictException('This image is archived. Include archived images and restore it before reuse.');
    if (existing) return this.dto(existing);
    const id = randomUUID(), fileName = basename(file.originalname ?? 'image').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) || 'image';
    await mkdir(this.root(), { recursive: true }); await writeFile(this.file({ _id: id, extension }), bytes, { flag: 'wx', mode: 0o600 });
    let created: CmsMediaMongo;
    try { created = await this.media.create({ _id: id, digest, title: this.title(input.title), altText: input.altText.trim(), fileName, mimeType, extension, size: bytes.length, revision: 0, uploadedBy: user.sub }); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) { const winner = await this.media.findOne({ digest }); if (winner) { await unlink(this.file({ _id: id, extension })).catch(() => undefined); if (winner.archivedAt) throw new ConflictException('This image is archived. Restore it in the library.'); return this.dto(winner); } }
      // Preserve a possibly committed file after an ambiguous database outcome.
      throw error;
    }
    await this.audit.record({ actor: user, action: 'cms.media_uploaded', resourceType: 'cms_media', resourceId: id, metadata: { mimeType, size: bytes.length } }); return this.dto(created);
  }
  async update(user: AuthenticatedUser, id: string, input: { revision: number; title?: string; altText?: string; archived?: boolean }): Promise<CmsMedia> {
    this.id(id);
    const changed = await this.media.findOneAndUpdate({ _id: id, revision: input.revision }, { $inc: { revision: 1 }, $set: { ...(input.title !== undefined ? { title: this.title(input.title) } : {}), ...(input.altText !== undefined ? { altText: input.altText.trim() } : {}), ...(input.archived === true ? { archivedAt: new Date() } : {}) }, ...(input.archived === false ? { $unset: { archivedAt: 1 } } : {}) }, { new: true });
    if (!changed) throw new ConflictException('This media item changed. Reload the library before saving.');
    await this.audit.record({ actor: user, action: 'cms.media_updated', resourceType: 'cms_media', resourceId: id, metadata: { archived: Boolean(changed.archivedAt) } }); return this.dto(changed);
  }
  async read(id: string, publicOnly: boolean): Promise<{ bytes: Buffer; mimeType: string; name: string }> {
    this.id(id); const row = await this.media.findById(id); if (!row) throw new NotFoundException('Image not found.');
    if (publicOnly) {
      const url = PREFIX + id;
      const published = await this.pages.exists({ status: 'published', $or: [{ 'publishedContent.audience': { $in: ['public', 'all'] }, $or: [{ 'publishedContent.sections.imageUrl': url }, { 'publishedContent.sections.items.imageUrl': url }] }, { publishedContent: { $exists: false }, audience: { $in: ['public', 'all'] }, $or: [{ 'sections.imageUrl': url }, { 'sections.items.imageUrl': url }] }] });
      if (!published) throw new NotFoundException('Image not found.');
    }
    try { return { bytes: await readFile(this.file(row)), mimeType: row.mimeType, name: id + '.' + row.extension }; } catch { throw new NotFoundException('Image file is unavailable.'); }
  }
  async validateReferences(sections: CmsPageBlock[]): Promise<void> {
    const urls = sections.flatMap(section => [section.imageUrl, ...(section.items ?? []).map(item => item.imageUrl)]).filter((value): value is string => Boolean(value?.startsWith(PREFIX)));
    for (const url of new Set(urls)) { const id = url.slice(PREFIX.length); this.id(id); const row = await this.media.findById(id); if (!row) throw new BadRequestException('A selected library image no longer exists.'); try { await access(this.file(row)); } catch { throw new BadRequestException('A selected library image is unavailable.'); } }
  }
  private title(value: string): string { const title = value.trim(); if (title.length < 2) throw new BadRequestException('Enter an image title of at least two characters.'); return title; }
  private dimensions(bytes: Buffer, extension: string): void {
    let width = 0, height = 0;
    if (extension === 'png') { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
    else if (extension === 'jpg') {
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset++] !== 255) break;
        while (bytes[offset] === 255) offset++;
        if (offset + 3 > bytes.length) break;
        const marker = bytes[offset++]!; if ([0xd9, 0xda].includes(marker)) break;
        const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) break;
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
        offset += length;
      }
    } else {
      const kind = bytes.toString('ascii', 12, 16);
      if (kind === 'VP8X' && bytes.length >= 30 && bytes.readUInt32LE(16) === 10) { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
      else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      else if (kind === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23,26).equals(Buffer.from('9d012a','hex'))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    }
    if (!width || !height || width > 8000 || height > 8000 || width * height > 32000000) throw new BadRequestException('Use a valid image no larger than 8000 pixels per side and 32 megapixels.');
  }
  private id(value: string): void { if (!/^[a-f0-9-]{36}$/.test(value)) throw new NotFoundException('Image not found.'); }
}
