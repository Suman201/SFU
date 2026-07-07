import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Assignment,
  AssignmentAttachment,
  AssignmentDetailResponse,
  AssignmentLinkAttachmentRequest,
  AssignmentMaterialLinkRequest,
  AssignmentSubmission,
  AssignmentSubmissionListResponse,
  AssignmentSubmissionLinkRequest,
  AssignmentSubmissionStatus,
  AssignmentSubmissionSummary,
  AssignmentSubmissionType,
  CreateAssignmentRequest,
  ReviewAssignmentSubmissionRequest,
  StudentAssignmentListResponse,
  SubmitAssignmentRequest,
  TeacherAssignmentListResponse,
  UpdateAssignmentRequest
} from '@native-sfu/contracts';
import { Model } from 'mongoose';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  AssignmentDocument,
  AssignmentMongoDocument,
  AssignmentSubmissionDocument,
  AssignmentSubmissionMongoDocument,
  BatchDocument,
  BatchMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  ClassSessionMaterialDocument,
  ClassSessionMaterialMongoDocument,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';
import { StudentEnrollmentsService } from '../student-enrollments/student-enrollments.service';

const ASSIGNMENT_ATTACHMENT_MAX_COUNT = 5;
const ASSIGNMENT_SUBMISSION_FILE_MAX_COUNT = 5;
const DEFAULT_ASSIGNMENT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);
const EXTENSION_BY_MIME = new Map<string, string[]>([
  ['application/pdf', ['pdf']],
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/png', ['png']],
  ['image/webp', ['webp']],
  ['text/plain', ['txt']],
  ['application/msword', ['doc']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx']],
  ['application/vnd.ms-powerpoint', ['ppt']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['pptx']]
]);

export interface AssignmentUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface AssignmentFileDownload {
  stream: ReturnType<typeof createReadStream>;
  fileName: string;
  mimeType: string;
  size: number;
}

interface AssignmentHydration {
  submissions?: AssignmentSubmissionMongoDocument[];
}

type StoredAssignmentAttachment = Omit<AssignmentAttachment, 'createdAt'> & {
  createdAt?: string | Date;
  path?: string;
  storageKey?: string;
};

@Injectable()
export class AssignmentsService {
  constructor(
    @InjectModel(AssignmentDocument.name) private readonly assignments: Model<AssignmentMongoDocument>,
    @InjectModel(AssignmentSubmissionDocument.name) private readonly submissions: Model<AssignmentSubmissionMongoDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(ClassSessionMaterialDocument.name) private readonly materials: Model<ClassSessionMaterialMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    private readonly enrollments: StudentEnrollmentsService,
    private readonly config: ConfigService
  ) {}

  async createAssignment(user: AuthenticatedUser, request: CreateAssignmentRequest): Promise<Assignment> {
    const batch = await this.findManageableBatch(request.batchId, user);
    const session = await this.resolveOptionalSession(batch, request.sessionId);
    const doc = await this.assignments.create({
      assignmentId: randomUUID(),
      batchId: batch.id,
      batchName: batch.name,
      ...(session ? { sessionId: session.id, sessionTitle: session.title } : request.sessionId ? { sessionId: this.cleanText(request.sessionId, 160) } : {}),
      teacherId: batch.teacherId,
      title: this.requiredText(request.title, 'Assignment title', 180),
      instructions: this.requiredText(request.instructions, 'Assignment instructions', 5000),
      ...(request.dueAt ? { dueAt: this.parseDate(request.dueAt, 'dueAt') } : {}),
      attachments: await this.assignmentReferenceAttachments(request.links, request.materialLinks, batch.id),
      allowedSubmissionTypes: this.normalizeSubmissionTypes(request.allowedSubmissionTypes),
      status: 'published'
    });
    return this.toAssignment(doc);
  }

  async updateAssignment(user: AuthenticatedUser, assignmentId: string, request: UpdateAssignmentRequest): Promise<Assignment> {
    const assignment = await this.findAssignmentForTeacher(assignmentId, user);
    const update: Record<string, unknown> = {};
    if (request.title !== undefined) update.title = this.requiredText(request.title, 'Assignment title', 180);
    if (request.instructions !== undefined) update.instructions = this.requiredText(request.instructions, 'Assignment instructions', 5000);
    if (request.dueAt !== undefined) update.dueAt = request.dueAt ? this.parseDate(request.dueAt, 'dueAt') : undefined;
    if (request.allowedSubmissionTypes !== undefined) update.allowedSubmissionTypes = this.normalizeSubmissionTypes(request.allowedSubmissionTypes);
    if (request.links !== undefined || request.materialLinks !== undefined) {
      update.attachments = await this.assignmentReferenceAttachments(request.links, request.materialLinks, assignment.batchId);
    }
    if (request.status !== undefined) update.status = request.status === 'archived' ? 'archived' : 'published';
    Object.assign(assignment, update);
    await assignment.save();
    return this.toAssignment(assignment, { submissions: await this.submissions.find({ assignmentId: assignment.assignmentId, deletedAt: { $exists: false } }).exec() });
  }

  async archiveAssignment(user: AuthenticatedUser, assignmentId: string): Promise<void> {
    const assignment = await this.findAssignmentForTeacher(assignmentId, user);
    assignment.status = 'archived';
    assignment.deletedAt = new Date();
    await assignment.save();
  }

  async listTeacherAssignments(user: AuthenticatedUser, options: { batchId?: string; sessionId?: string } = {}): Promise<TeacherAssignmentListResponse> {
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (this.isAdmin(user)) {
      if (options.batchId) filter.batchId = options.batchId;
    } else {
      filter.teacherId = user.sub;
      if (options.batchId) filter.batchId = options.batchId;
    }
    if (options.sessionId) filter.sessionId = options.sessionId;
    const items = await this.assignments.find(filter).sort({ dueAt: 1, createdAt: -1 }).exec();
    const submissionMap = await this.submissionMap(items.map((item) => item.assignmentId));
    return {
      items: items.map((assignment) => this.toAssignment(assignment, { submissions: submissionMap.get(assignment.assignmentId) ?? [] }))
    };
  }

  async getAssignment(user: AuthenticatedUser, assignmentId: string): Promise<AssignmentDetailResponse> {
    const assignment = await this.findVisibleAssignment(assignmentId);
    if (user.roles.includes('STUDENT') && !this.isAdmin(user)) {
      await this.assertStudentCanAccessAssignment(user.sub, assignment);
      const submission = await this.ensureStudentSubmission(assignment, user);
      return { assignment: this.toAssignment(assignment), submission: this.toSubmission(submission) };
    }
    await this.assertTeacherCanManageAssignment(assignment, user);
    return { assignment: this.toAssignment(assignment, { submissions: await this.submissions.find({ assignmentId: assignment.assignmentId, deletedAt: { $exists: false } }).exec() }) };
  }

  async listStudentAssignments(user: AuthenticatedUser, options: { batchId?: string; sessionId?: string } = {}): Promise<StudentAssignmentListResponse> {
    const enrolledBatches = await this.enrollments.listStudentBatches(user.sub, { status: 'active' });
    const batchIds = enrolledBatches.map((batch) => batch.id).filter(Boolean);
    if (!batchIds.length) return { items: [] };
    const filter: Record<string, unknown> = {
      batchId: options.batchId ? options.batchId : { $in: batchIds },
      status: 'published',
      deletedAt: { $exists: false }
    };
    if (options.batchId && !batchIds.includes(options.batchId)) {
      throw new ForbiddenException('You are not enrolled in this batch.');
    }
    if (options.sessionId) filter.sessionId = options.sessionId;
    const assignments = await this.assignments.find(filter).sort({ dueAt: 1, createdAt: -1 }).exec();
    const submissions = await this.submissions.find({
      assignmentId: { $in: assignments.map((assignment) => assignment.assignmentId) },
      studentId: user.sub,
      deletedAt: { $exists: false }
    }).exec();
    const submissionByAssignment = new Map(submissions.map((submission) => [submission.assignmentId, submission]));
    return {
      items: assignments.map((assignment) => ({
        ...this.toAssignment(assignment),
        submission: submissionByAssignment.has(assignment.assignmentId)
          ? this.toSubmission(submissionByAssignment.get(assignment.assignmentId)!)
          : this.toAssignedSubmission(assignment, user)
      }))
    };
  }

  async markViewed(user: AuthenticatedUser, assignmentId: string): Promise<AssignmentSubmission> {
    const assignment = await this.findVisibleAssignment(assignmentId);
    await this.assertStudentCanAccessAssignment(user.sub, assignment);
    const submission = await this.ensureStudentSubmission(assignment, user);
    if (submission.status === 'assigned') {
      submission.status = 'viewed';
    }
    submission.viewedAt = submission.viewedAt ?? new Date();
    await submission.save();
    return this.toSubmission(submission);
  }

  async submitAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
    request: SubmitAssignmentRequest,
    files: AssignmentUploadFile[] = []
  ): Promise<AssignmentSubmission> {
    const assignment = await this.findVisibleAssignment(assignmentId);
    await this.assertStudentCanAccessAssignment(user.sub, assignment);
    const allowed = new Set(assignment.allowedSubmissionTypes);
    const text = this.cleanText(request.text, 10000);
    const links = this.submissionLinks(request.links);
    if (text && !allowed.has('text')) throw new ForbiddenException('Text submissions are not enabled for this assignment.');
    if (links.length && !allowed.has('link')) throw new ForbiddenException('Link submissions are not enabled for this assignment.');
    if (files.length && !allowed.has('file')) throw new ForbiddenException('File submissions are not enabled for this assignment.');
    if (!text && !links.length && !files.length) {
      throw new BadRequestException('Add text, a link, or a file before submitting.');
    }
    const submission = await this.ensureStudentSubmission(assignment, user);
    submission.text = text || undefined;
    submission.links = links as unknown as typeof submission.links;
    submission.files = files.length ? (await this.persistSubmissionFiles(assignment, user, files) as unknown as typeof submission.files) : submission.files ?? [];
    submission.submittedAt = new Date();
    submission.status = assignment.dueAt && submission.submittedAt.getTime() > assignment.dueAt.getTime() ? 'late' : 'submitted';
    submission.reviewedAt = undefined;
    submission.completedAt = undefined;
    await submission.save();
    return this.toSubmission(submission);
  }

  async addAssignmentFiles(user: AuthenticatedUser, assignmentId: string, files: AssignmentUploadFile[]): Promise<Assignment> {
    const assignment = await this.findAssignmentForTeacher(assignmentId, user);
    if (!files.length) throw new BadRequestException('At least one file is required.');
    if (files.length > ASSIGNMENT_ATTACHMENT_MAX_COUNT) {
      throw new BadRequestException(`You can upload up to ${ASSIGNMENT_ATTACHMENT_MAX_COUNT} assignment files at once.`);
    }
    assignment.attachments = [...(assignment.attachments ?? []), ...(await this.persistAssignmentFiles(assignment, files) as unknown as typeof assignment.attachments)];
    await assignment.save();
    return this.toAssignment(assignment, { submissions: await this.submissions.find({ assignmentId: assignment.assignmentId, deletedAt: { $exists: false } }).exec() });
  }

  async listSubmissions(user: AuthenticatedUser, assignmentId: string): Promise<AssignmentSubmissionListResponse> {
    const assignment = await this.findAssignmentForTeacher(assignmentId, user);
    const submissions = await this.submissions.find({ assignmentId: assignment.assignmentId, deletedAt: { $exists: false } }).sort({ updatedAt: -1 }).exec();
    return { assignment: this.toAssignment(assignment, { submissions }), submissions: submissions.map((submission) => this.toSubmission(submission)) };
  }

  async reviewSubmission(
    user: AuthenticatedUser,
    assignmentId: string,
    submissionId: string,
    request: ReviewAssignmentSubmissionRequest
  ): Promise<AssignmentSubmission> {
    const assignment = await this.findAssignmentForTeacher(assignmentId, user);
    const submission = await this.submissions.findOne({ assignmentId: assignment.assignmentId, submissionId, deletedAt: { $exists: false } });
    if (!submission) throw new NotFoundException('Submission not found.');
    submission.feedback = this.cleanText(request.feedback, 5000) || undefined;
    if (request.status === 'returned') {
      submission.status = 'returned';
      submission.returnedAt = new Date();
      submission.reviewedAt = new Date();
      submission.completedAt = undefined;
    } else if (request.status === 'completed') {
      submission.status = 'completed';
      submission.completedAt = new Date();
      submission.reviewedAt = new Date();
    } else {
      submission.status = 'reviewed';
      submission.reviewedAt = new Date();
      submission.completedAt = undefined;
    }
    await submission.save();
    return this.toSubmission(submission);
  }

  async downloadAssignmentAttachment(user: AuthenticatedUser, assignmentId: string, attachmentId: string): Promise<AssignmentFileDownload> {
    const assignment = await this.findVisibleAssignment(assignmentId);
    if (user.roles.includes('STUDENT') && !this.isAdmin(user)) {
      await this.assertStudentCanAccessAssignment(user.sub, assignment);
    } else {
      await this.assertTeacherCanManageAssignment(assignment, user);
    }
    const attachment = assignment.attachments.find((item) => item.id === attachmentId) as StoredAssignmentAttachment | undefined;
    return this.fileDownloadFromAttachment(attachment);
  }

  async downloadSubmissionAttachment(
    user: AuthenticatedUser,
    assignmentId: string,
    submissionId: string,
    attachmentId: string
  ): Promise<AssignmentFileDownload> {
    const assignment = await this.findVisibleAssignment(assignmentId);
    const submission = await this.submissions.findOne({ assignmentId: assignment.assignmentId, submissionId, deletedAt: { $exists: false } });
    if (!submission) throw new NotFoundException('Submission not found.');
    if (user.roles.includes('STUDENT') && !this.isAdmin(user)) {
      if (submission.studentId !== user.sub) throw new ForbiddenException('You can only access your own submission.');
      await this.assertStudentCanAccessAssignment(user.sub, assignment);
    } else {
      await this.assertTeacherCanManageAssignment(assignment, user);
    }
    const attachment = submission.files.find((item) => item.id === attachmentId) as StoredAssignmentAttachment | undefined;
    return this.fileDownloadFromAttachment(attachment);
  }

  private async findVisibleAssignment(assignmentId: string): Promise<AssignmentMongoDocument> {
    const assignment = await this.assignments.findOne({ assignmentId, deletedAt: { $exists: false } });
    if (!assignment) throw new NotFoundException('Assignment not found.');
    return assignment;
  }

  private async findAssignmentForTeacher(assignmentId: string, user: AuthenticatedUser): Promise<AssignmentMongoDocument> {
    const assignment = await this.findVisibleAssignment(assignmentId);
    await this.assertTeacherCanManageAssignment(assignment, user);
    return assignment;
  }

  private async findManageableBatch(batchId: string, user: AuthenticatedUser): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: batchId, deletedAt: { $exists: false } });
    if (!batch) throw new NotFoundException('Batch not found.');
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && batch.teacherId === user.sub)) return batch;
    throw new ForbiddenException('You are not allowed to manage assignments for this batch.');
  }

  private async assertTeacherCanManageAssignment(assignment: AssignmentMongoDocument, user: AuthenticatedUser): Promise<void> {
    if (this.isAdmin(user) || (user.roles.includes('TEACHER') && assignment.teacherId === user.sub)) return;
    throw new ForbiddenException('You are not allowed to manage this assignment.');
  }

  private async assertStudentCanAccessAssignment(studentId: string, assignment: AssignmentMongoDocument): Promise<void> {
    if (assignment.status !== 'published') throw new NotFoundException('Assignment not found.');
    if (await this.enrollments.isStudentEnrolledInBatch(studentId, assignment.batchId)) return;
    throw new ForbiddenException('You are not enrolled in this batch.');
  }

  private async resolveOptionalSession(batch: BatchMongoDocument, sessionId: string | undefined): Promise<ClassSessionMongoDocument | null> {
    const normalized = this.cleanText(sessionId, 160);
    if (!normalized) return null;
    const session = await this.classSessions.findOne({ _id: normalized, batchId: batch.id });
    return session ?? null;
  }

  private async assignmentReferenceAttachments(
    links: AssignmentLinkAttachmentRequest[] | undefined,
    materialLinks: AssignmentMaterialLinkRequest[] | undefined,
    batchId: string
  ): Promise<AssignmentAttachment[]> {
    const linkAttachments = (links ?? []).slice(0, ASSIGNMENT_ATTACHMENT_MAX_COUNT).map((link) => ({
      id: randomUUID(),
      type: 'link' as const,
      title: this.requiredText(link.title, 'Link title', 180),
      url: this.normalizeUrl(link.url),
      createdAt: new Date().toISOString()
    }));
    const materialIds = [...new Set((materialLinks ?? []).map((item) => item.materialId).filter(Boolean))].slice(0, ASSIGNMENT_ATTACHMENT_MAX_COUNT);
    const materials = materialIds.length
      ? await this.materials.find({ materialId: { $in: materialIds }, batchId, deletedAt: { $exists: false } }).exec()
      : [];
    const materialAttachments = materials.map((material) => ({
      id: randomUUID(),
      type: 'material' as const,
      materialId: material.materialId,
      title: this.cleanText(materialLinks?.find((item) => item.materialId === material.materialId)?.title, 180) || material.title,
      createdAt: new Date().toISOString()
    }));
    return [...linkAttachments, ...materialAttachments].slice(0, ASSIGNMENT_ATTACHMENT_MAX_COUNT);
  }

  private submissionLinks(links: AssignmentSubmissionLinkRequest[] | undefined): AssignmentAttachment[] {
    return (links ?? []).slice(0, ASSIGNMENT_SUBMISSION_FILE_MAX_COUNT).map((link) => ({
      id: randomUUID(),
      type: 'link',
      title: this.requiredText(link.title, 'Submission link title', 180),
      url: this.normalizeUrl(link.url),
      createdAt: new Date().toISOString()
    }));
  }

  private async persistAssignmentFiles(assignment: AssignmentMongoDocument, files: AssignmentUploadFile[]): Promise<StoredAssignmentAttachment[]> {
    const root = this.assignmentStorageRoot();
    const directory = join(root, 'assignments', this.safeStorageSegment(assignment.assignmentId));
    await mkdir(directory, { recursive: true });
    const attachments: StoredAssignmentAttachment[] = [];
    for (const file of files) {
      this.assertUploadFile(file);
      const id = randomUUID();
      const fileName = this.safeFileName(file.originalname, file.mimetype);
      const storageKey = `assignments/${this.safeStorageSegment(assignment.assignmentId)}/${id}/${fileName}`;
      const path = join(directory, `${id}-${fileName}`);
      await writeFile(path, file.buffer);
      attachments.push({
        id,
        type: 'file',
        title: this.titleFromFileName(fileName),
        fileName,
        mimeType: file.mimetype,
        size: file.size,
        storageProvider: 'local',
        downloadUrl: this.assignmentAttachmentDownloadUrl(assignment.assignmentId, id),
        createdAt: new Date().toISOString(),
        storageKey,
        path
      });
    }
    return attachments;
  }

  private async persistSubmissionFiles(
    assignment: AssignmentMongoDocument,
    user: AuthenticatedUser,
    files: AssignmentUploadFile[]
  ): Promise<StoredAssignmentAttachment[]> {
    if (files.length > ASSIGNMENT_SUBMISSION_FILE_MAX_COUNT) {
      throw new BadRequestException(`You can upload up to ${ASSIGNMENT_SUBMISSION_FILE_MAX_COUNT} submission files.`);
    }
    const root = this.assignmentStorageRoot();
    const directory = join(root, 'submissions', this.safeStorageSegment(assignment.assignmentId), this.safeStorageSegment(user.sub));
    await mkdir(directory, { recursive: true });
    const attachments: StoredAssignmentAttachment[] = [];
    for (const file of files) {
      this.assertUploadFile(file);
      const id = randomUUID();
      const fileName = this.safeFileName(file.originalname, file.mimetype);
      const storageKey = `submissions/${this.safeStorageSegment(assignment.assignmentId)}/${this.safeStorageSegment(user.sub)}/${id}/${fileName}`;
      const path = join(directory, `${id}-${fileName}`);
      await writeFile(path, file.buffer);
      attachments.push({
        id,
        type: 'file',
        title: this.titleFromFileName(fileName),
        fileName,
        mimeType: file.mimetype,
        size: file.size,
        storageProvider: 'local',
        createdAt: new Date().toISOString(),
        storageKey,
        path
      });
    }
    return attachments;
  }

  private async ensureStudentSubmission(assignment: AssignmentMongoDocument, user: AuthenticatedUser): Promise<AssignmentSubmissionMongoDocument> {
    const existing = await this.submissions.findOne({ assignmentId: assignment.assignmentId, studentId: user.sub, deletedAt: { $exists: false } });
    if (existing) return existing;
    const profile = await this.users.findById(user.sub).exec().catch(() => null);
    return this.submissions.create({
      submissionId: randomUUID(),
      assignmentId: assignment.assignmentId,
      batchId: assignment.batchId,
      ...(assignment.sessionId ? { sessionId: assignment.sessionId } : {}),
      studentId: user.sub,
      studentName: profile?.displayName ?? profile?.name ?? user.email ?? user.sub,
      studentEmail: profile?.email ?? user.email,
      links: [],
      files: [],
      status: 'assigned'
    });
  }

  private toAssignedSubmission(assignment: AssignmentMongoDocument, user: AuthenticatedUser): AssignmentSubmission {
    return {
      id: '',
      submissionId: '',
      assignmentId: assignment.assignmentId,
      batchId: assignment.batchId,
      sessionId: assignment.sessionId,
      studentId: user.sub,
      links: [],
      files: [],
      status: 'assigned',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  private async submissionMap(assignmentIds: string[]): Promise<Map<string, AssignmentSubmissionMongoDocument[]>> {
    if (!assignmentIds.length) return new Map();
    const submissions = await this.submissions.find({ assignmentId: { $in: assignmentIds }, deletedAt: { $exists: false } }).exec();
    return submissions.reduce((map, submission) => {
      const list = map.get(submission.assignmentId) ?? [];
      list.push(submission);
      map.set(submission.assignmentId, list);
      return map;
    }, new Map<string, AssignmentSubmissionMongoDocument[]>());
  }

  private toAssignment(doc: AssignmentMongoDocument, hydration: AssignmentHydration = {}): Assignment {
    return {
      id: doc.id,
      assignmentId: doc.assignmentId,
      batchId: doc.batchId,
      ...(doc.batchName ? { batchName: doc.batchName } : {}),
      ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
      ...(doc.sessionTitle ? { sessionTitle: doc.sessionTitle } : {}),
      teacherId: doc.teacherId,
      title: doc.title,
      instructions: doc.instructions,
      ...(doc.dueAt ? { dueAt: doc.dueAt.toISOString() } : {}),
      attachments: (doc.attachments ?? []).map((attachment) => this.publicAttachment(attachment as StoredAssignmentAttachment, doc.assignmentId)),
      allowedSubmissionTypes: doc.allowedSubmissionTypes ?? ['text'],
      status: doc.status,
      ...(hydration.submissions ? { submissionSummary: this.submissionSummary(hydration.submissions) } : {}),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      ...(doc.deletedAt ? { deletedAt: doc.deletedAt.toISOString() } : {})
    };
  }

  private toSubmission(doc: AssignmentSubmissionMongoDocument): AssignmentSubmission {
    return {
      id: doc.id,
      submissionId: doc.submissionId,
      assignmentId: doc.assignmentId,
      batchId: doc.batchId,
      ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
      studentId: doc.studentId,
      ...(doc.studentName ? { studentName: doc.studentName } : {}),
      ...(doc.studentEmail ? { studentEmail: doc.studentEmail } : {}),
      ...(doc.text ? { text: doc.text } : {}),
      links: (doc.links ?? []).map((attachment) => this.publicAttachment(attachment as StoredAssignmentAttachment, doc.assignmentId)),
      files: (doc.files ?? []).map((attachment) => this.publicAttachment(attachment as StoredAssignmentAttachment, doc.assignmentId, doc.submissionId)),
      status: doc.status,
      ...(doc.viewedAt ? { viewedAt: doc.viewedAt.toISOString() } : {}),
      ...(doc.submittedAt ? { submittedAt: doc.submittedAt.toISOString() } : {}),
      ...(doc.reviewedAt ? { reviewedAt: doc.reviewedAt.toISOString() } : {}),
      ...(doc.returnedAt ? { returnedAt: doc.returnedAt.toISOString() } : {}),
      ...(doc.completedAt ? { completedAt: doc.completedAt.toISOString() } : {}),
      ...(doc.feedback ? { feedback: doc.feedback } : {}),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      ...(doc.deletedAt ? { deletedAt: doc.deletedAt.toISOString() } : {})
    };
  }

  private publicAttachment(attachment: StoredAssignmentAttachment, assignmentId: string, submissionId?: string): AssignmentAttachment {
    return {
      id: attachment.id,
      type: attachment.type,
      title: attachment.title,
      ...(attachment.url ? { url: attachment.url } : {}),
      ...(attachment.materialId ? { materialId: attachment.materialId } : {}),
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      ...(attachment.storageProvider ? { storageProvider: attachment.storageProvider } : {}),
      ...(attachment.type === 'file'
        ? {
            downloadUrl: submissionId
              ? this.submissionAttachmentDownloadUrl(assignmentId, submissionId, attachment.id)
              : this.assignmentAttachmentDownloadUrl(assignmentId, attachment.id)
          }
        : {}),
      ...(attachment.createdAt ? { createdAt: this.toIso(attachment.createdAt) } : {})
    };
  }

  private submissionSummary(submissions: AssignmentSubmissionMongoDocument[]): AssignmentSubmissionSummary {
    const summary: AssignmentSubmissionSummary = { assigned: 0, viewed: 0, submitted: 0, late: 0, reviewed: 0, returned: 0, completed: 0 };
    for (const submission of submissions) {
      summary[submission.status] += 1;
    }
    return summary;
  }

  private fileDownloadFromAttachment(attachment: StoredAssignmentAttachment | undefined): AssignmentFileDownload {
    if (!attachment || attachment.type !== 'file' || !attachment.path || !attachment.fileName || !attachment.mimeType || !attachment.size) {
      throw new NotFoundException('Assignment file not found.');
    }
    return {
      stream: createReadStream(attachment.path),
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      size: attachment.size
    };
  }

  private normalizeSubmissionTypes(types: AssignmentSubmissionType[] | undefined): AssignmentSubmissionType[] {
    const allowed = new Set<AssignmentSubmissionType>(['text', 'file', 'link']);
    const normalized = [...new Set((types ?? ['text']).filter((type): type is AssignmentSubmissionType => allowed.has(type as AssignmentSubmissionType)))];
    if (!normalized.length) throw new BadRequestException('At least one submission type is required.');
    return normalized;
  }

  private assertUploadFile(file: AssignmentUploadFile): void {
    if (!file.buffer?.length) throw new BadRequestException('Uploaded file is empty.');
    if (file.size > this.assignmentMaxFileSizeBytes()) throw new BadRequestException('Assignment files cannot exceed 10 MB.');
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) throw new BadRequestException('This assignment file type is not allowed.');
    const extension = this.fileExtension(file.originalname);
    const allowedExtensions = EXTENSION_BY_MIME.get(file.mimetype) ?? [];
    if (!allowedExtensions.includes(extension)) {
      throw new BadRequestException('Assignment file extension does not match the uploaded file type.');
    }
  }

  private cleanText(value: string | undefined | null, maxLength: number): string {
    return (value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  private requiredText(value: string | undefined | null, label: string, maxLength: number): string {
    const cleaned = this.cleanText(value, maxLength);
    if (!cleaned) throw new BadRequestException(`${label} is required.`);
    return cleaned;
  }

  private normalizeUrl(value: string | undefined): string {
    const raw = value?.trim();
    if (!raw) throw new BadRequestException('URL is required.');
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new BadRequestException('URL is invalid.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new BadRequestException('URL must use http or https.');
    return parsed.toString();
  }

  private parseDate(value: string, field: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${field} must be a valid date.`);
    return parsed;
  }

  private safeFileName(originalName: string, mimeType: string): string {
    const fallbackExtension = EXTENSION_BY_MIME.get(mimeType)?.[0] ?? 'file';
    const fallback = `assignment-file.${fallbackExtension}`;
    const cleaned = (originalName || fallback).replace(/[\\/]/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '').trim();
    return cleaned || fallback;
  }

  private fileExtension(fileName: string): string {
    const last = fileName.split('.').pop();
    return (last ?? '').toLowerCase();
  }

  private titleFromFileName(fileName: string): string {
    return this.cleanText(fileName.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_-]+/g, ' '), 180) || fileName;
  }

  private safeStorageSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'assignment';
  }

  private assignmentStorageRoot(): string {
    return this.config.get<string>('assignments.localPath', this.config.get<string>('classMaterials.localPath', './class-materials'));
  }

  private assignmentMaxFileSizeBytes(): number {
    return this.config.get<number>('assignments.maxFileSizeBytes', DEFAULT_ASSIGNMENT_MAX_FILE_SIZE_BYTES);
  }

  private assignmentAttachmentDownloadUrl(assignmentId: string, attachmentId: string): string {
    return `/api/v1/assignments/${encodeURIComponent(assignmentId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
  }

  private submissionAttachmentDownloadUrl(assignmentId: string, submissionId: string, attachmentId: string): string {
    return `/api/v1/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(submissionId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
  }

  private toIso(value: string | Date | undefined): string | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private isAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('ADMIN') || user.roles.includes('SUPER_ADMIN');
  }
}
