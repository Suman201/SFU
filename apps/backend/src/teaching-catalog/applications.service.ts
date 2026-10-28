import { verificationDocumentSummary } from './verification-documents.service';
import {
  TutorNoticesService,
  tutorStatusNotice,
} from './tutor-notices.service';
import { resolveTeachingAssessments } from '@native-sfu/contracts';
import { normalizeTeachingAreas } from './teaching-areas';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import type {
  TutorApplication,
  TutorReviewStatus,
} from '@native-sfu/contracts';
import { UserDocument, UserMongoDocument } from '../database/schemas';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { TeachingCatalogService } from './catalog.service';
import { ReviewTutorDto, SubmitTutorDto } from './catalog.dto';
@Injectable()
export class TutorApplicationsService {
  constructor(
    @InjectModel(UserDocument.name)
    private readonly users: Model<UserMongoDocument>,
    private readonly catalog: TeachingCatalogService,
    private readonly audit: AuditLogsService,
    private readonly notices: TutorNoticesService,
  ) {}
  private async teacher(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Teacher not found.');
    const doc = await this.users
      .findOne({
        _id: id,
        roles: 'TEACHER',
        disabled: false,
        status: 'active',
        deletedAt: { $exists: false },
      })
      .exec();
    if (!doc) throw new NotFoundException('Teacher not found.');
    return doc;
  }
  async mine(actor: AuthenticatedUser) {
    if (!actor.roles.includes('TEACHER'))
      throw new ForbiddenException('Only teachers can apply.');
    return this.summary(await this.teacher(actor.sub));
  }
  async summary(doc: UserMongoDocument): Promise<TutorApplication> {
    const missing: string[] = [];
    const snapshot = await this.catalog.snapshot();
    const areas = doc.teachingAreas;
    const requiredAssessments = resolveTeachingAssessments(
      snapshot,
      areas ?? [],
    );
    const verificationDocuments = (doc.tutorVerificationDocuments ?? []).map(
      verificationDocumentSummary,
    );
    const usable = (kind: string) =>
      verificationDocuments.some(
        (d) =>
          d.kind === kind &&
          d.status !== 'rejected' &&
          (d.status === 'verified' || d.fileAvailable),
      );
    if (!usable('identity'))
      missing.push(
        'Upload a private identity document for reviewer verification.',
      );
    if (
      (doc.credentials?.length || doc.education?.length) &&
      !usable('qualification')
    )
      missing.push(
        'Upload private evidence for your stated qualifications or education.',
      );
    if (!doc.introVideoUrl && !doc.tutorIntroVideo)
      missing.push(
        'Upload a short introduction video or add a YouTube/Vimeo link.',
      );
    for (const task of requiredAssessments)
      if (!task.contentApproved)
        missing.push(
          'Assessment content awaits qualified review for ' +
            task.categoryName +
            ' — ' +
            task.levelName +
            '.',
        );
    for (const required of requiredAssessments)
      if (
        !(doc.assessmentResponses ?? []).some(
          (answer) =>
            answer.categoryId === required.categoryId &&
            answer.levelId === required.levelId &&
            answer.taskVersion === required.taskVersion &&
            answer.response.trim().length >= 100,
        )
      )
        missing.push(
          'Complete the ' +
            required.categoryName +
            ' — ' +
            required.levelName +
            ' teaching assessment (at least 100 characters).',
        );

    if (
      !doc.displayName?.trim() ||
      !doc.headline ||
      doc.headline.trim().length < 12
    )
      missing.push(
        'Add your name and a clear teaching headline (at least 12 characters).',
      );
    if (!doc.bio || doc.bio.trim().length < 100)
      missing.push(
        'Describe your teaching approach in at least 100 characters.',
      );
    if (!doc.avatarUrl) missing.push('Upload a clear profile photo.');
    if (!doc.languages?.length) missing.push('Add the languages you teach in.');
    try {
      new Intl.DateTimeFormat('en', { timeZone: doc.timezone || '!' });
    } catch {
      missing.push('Select a valid time zone.');
    }
    if (!doc.availability || doc.availability.trim().length < 10)
      missing.push('Describe your weekly availability.');
    if (!areas?.length)
      missing.push(
        'Add at least one teaching area, including its academic levels and teaching languages.',
      );
    for (const area of areas ?? []) {
      const label =
        snapshot.categories.find((c) => c.id === area.categoryId)?.name ??
        'Other subjects';
      if (!area.categoryId && !area.otherSubjects.length)
        missing.push('Name the subjects you teach under Other.');
      if (!area.levelIds.length)
        missing.push('Choose academic levels for ' + label + '.');
      if (!area.languageIds.length)
        missing.push('Choose teaching languages for ' + label + '.');
    }
    try {
      if (areas) normalizeTeachingAreas(areas, snapshot);
    } catch {
      missing.push(
        'Update teaching areas with categories, subjects, academic levels and languages that are still active.',
      );
    }
    if (!doc.teachingCountries?.length)
      missing.push('Choose the European markets you teach in.');
    if (!doc.learnerAgeGroups?.length)
      missing.push('Choose children, adults, or both.');
    if (
      !doc.credentials?.length &&
      !doc.education?.length &&
      !doc.experience?.length
    )
      missing.push(
        'Add relevant qualifications, education, or teaching experience.',
      );
    try {
      await this.catalog.validateSelections(
        doc.teacherSubjectIds ?? [],
        doc.curriculumIds ?? [],
      );
    } catch {
      missing.push('Replace subjects or curricula that are no longer active.');
    }
    return {
      teachingAreas: areas,
      verificationDocuments,
      requiredAssessments,
      assessmentResponses: doc.assessmentResponses ?? [],
      introVideoUploaded: Boolean(doc.tutorIntroVideo),
      introVideoDurationSeconds: doc.tutorIntroVideo?.durationSeconds,
      introVideoUrl: doc.introVideoUrl,
      teacherId: doc.id,
      displayName: doc.displayName,
      email: doc.email,
      status: doc.tutorReviewStatus ?? 'draft',
      revision: doc.tutorRevision ?? 0,
      submittedAt: doc.tutorSubmittedAt?.toISOString(),
      reviewedAt: doc.tutorReviewedAt?.toISOString(),
      reviewNote: doc.tutorReviewNote,
      missing,
      subjectIds: doc.teacherSubjectIds ?? [],
      curriculumIds: doc.curriculumIds ?? [],
      teachingCountries: doc.teachingCountries ?? [],
      learnerAgeGroups: doc.learnerAgeGroups ?? [],
      teachingLevels: doc.teachingLevels ?? [],
      profile: {
        headline: doc.headline,
        bio: doc.bio,
        avatarUrl: doc.avatarUrl,
        languages: doc.languages,
        timezone: doc.timezone,
        availability: doc.availability,
        credentials: doc.credentials,
        education: doc.education,
        experience: doc.experience,
      },
    };
  }
  async submit(actor: AuthenticatedUser, input: SubmitTutorDto) {
    return this.catalog.withStablePolicy(() =>
      this.submitApplication(actor, input),
    );
  }
  private async submitApplication(
    actor: AuthenticatedUser,
    input: SubmitTutorDto,
  ) {
    const application = await this.mine(actor);
    if (input.revision !== application.revision)
      throw new ConflictException(
        'Your profile changed. Reload before submitting.',
      );
    if (application.missing.length)
      throw new BadRequestException(application.missing.join(' '));
    if (
      !input.adultTutorConfirmed ||
      !input.codeOfConductAccepted ||
      (application.learnerAgeGroups.includes('children') &&
        !input.safeguardingAccepted)
    )
      throw new BadRequestException(
        'Confirm the tutor declarations before submitting.',
      );
    const saved = await this.users
      .findOneAndUpdate(
        {
          _id: actor.sub,
          tutorRevision: input.revision,
          tutorReviewStatus: {
            $in: ['draft', 'changes_requested', 'rejected'],
          },
        },
        {
          $set: {
            tutorReviewStatus: 'submitted',
            tutorSubmittedAt: new Date(),
            tutorReviewNote: '',
            tutorDeclarations: {
              adultTutorConfirmed: true,
              codeOfConductAccepted: true,
              safeguardingAccepted: input.safeguardingAccepted,
              acceptedAt: new Date(),
              policyVersion: '2026-10-28',
            },
            publicProfileEnabled: false,
          },
          $push: {
            tutorOnboardingNotices: {
              $each: [tutorStatusNotice('submitted')],
              $slice: -50,
            },
          },
        },
        { new: true },
      )
      .exec();
    if (!saved)
      throw new ConflictException(
        'Your profile changed or is already submitted. Reload before submitting.',
      );
    await this.audit.record({
      actor,
      action: 'tutor_application.submitted',
      resourceType: 'tutor_application',
      resourceId: actor.sub,
      metadata: { revision: input.revision },
    });
    this.notices.kick();
    return this.summary(saved);
  }
  async list(status: string = 'submitted', page = 1) {
    if (
      ![
        'draft',
        'submitted',
        'changes_requested',
        'approved',
        'rejected',
      ].includes(status) ||
      !Number.isInteger(page) ||
      page < 1
    )
      throw new BadRequestException('Invalid application filters.');
    const filter = {
      roles: 'TEACHER',
      deletedAt: { $exists: false },
      ...(status === 'draft'
        ? {
            $or: [
              { tutorReviewStatus: 'draft' },
              { tutorReviewStatus: { $exists: false } },
            ],
          }
        : { tutorReviewStatus: status }),
    };
    const [docs, total] = await Promise.all([
      this.users
        .find(filter)
        .sort({ tutorSubmittedAt: 1, _id: 1 })
        .skip((page - 1) * 20)
        .limit(20)
        .exec(),
      this.users.countDocuments(filter).exec(),
    ]);
    return {
      items: docs.map((doc) => ({
        teacherId: doc.id,
        displayName: doc.displayName,
        email: doc.email,
        status: doc.tutorReviewStatus,
        revision: doc.tutorRevision,
        submittedAt: doc.tutorSubmittedAt?.toISOString(),
      })),
      total,
      page,
      limit: 20,
    };
  }
  async get(id: string) {
    return this.summary(await this.teacher(id));
  }
  async review(id: string, input: ReviewTutorDto, actor: AuthenticatedUser) {
    return this.catalog.withStablePolicy(() =>
      this.reviewApplication(id, input, actor),
    );
  }
  private async reviewApplication(
    id: string,
    input: ReviewTutorDto,
    actor: AuthenticatedUser,
  ) {
    if (actor.sub === id)
      throw new ForbiddenException('You cannot review your own application.');
    const doc = await this.teacher(id);
    const application = await this.summary(doc);
    if (input.revision !== application.revision)
      throw new ConflictException(
        'The application changed. Reload before reviewing.',
      );
    if (!input.note.trim() || input.note.trim().length < 10)
      throw new BadRequestException('Add a useful review note.');
    if (input.decision === 'approved') {
      if (!input.introVideoReviewed)
        throw new BadRequestException(
          'Watch the introduction video before approving.',
        );
      const results = input.assessmentResults ?? [];
      if (
        new Set(results.map((r) => r.categoryId + ':' + (r.levelId ?? '')))
          .size !== results.length ||
        application.requiredAssessments.some(
          (required) =>
            !results.some(
              (result) =>
                result.categoryId === required.categoryId &&
                result.levelId === required.levelId &&
                result.taskVersion === required.taskVersion &&
                result.version === required.version &&
                result.passed &&
                result.notes.trim().length >= 10,
            ),
        )
      )
        throw new BadRequestException(
          'Record a passed assessment with notes for each selected category and academic level. Reload if the category requirements changed.',
        );

      if (
        !application.verificationDocuments?.some(
          (d) => d.kind === 'identity' && d.status === 'verified',
        ) ||
        ((doc.credentials?.length || doc.education?.length) &&
          !application.verificationDocuments?.some(
            (d) => d.kind === 'qualification' && d.status === 'verified',
          ))
      )
        throw new BadRequestException(
          'Verify the identity and relevant qualification documents before approving this tutor.',
        );
      if (application.missing.length)
        throw new BadRequestException(
          'This profile is incomplete: ' + application.missing.join(' '),
        );
      if (
        !input.identityChecked ||
        !input.teachingSuitabilityChecked ||
        (application.learnerAgeGroups.includes('children') &&
          !input.safeguardingChecked)
      )
        throw new BadRequestException(
          'Complete the applicable identity, teaching, and safeguarding checks before approving.',
        );
    }
    const saved = await this.users
      .findOneAndUpdate(
        {
          _id: id,
          tutorReviewStatus: 'submitted',
          tutorRevision: input.revision,
        },
        {
          $set: {
            tutorReviewStatus: input.decision,
            tutorReviewNote: input.note.trim(),
            tutorReviewedAt: new Date(),
            tutorReviewerId: actor.sub,
            tutorAssessmentResults: input.assessmentResults ?? [],
            tutorReviewChecks: {
              introVideoReviewed: Boolean(input.introVideoReviewed),
              identityChecked: Boolean(input.identityChecked),
              teachingSuitabilityChecked: Boolean(
                input.teachingSuitabilityChecked,
              ),
              safeguardingChecked: Boolean(input.safeguardingChecked),
            },
            publicProfileEnabled: input.decision === 'approved',
          },
          $push: {
            tutorOnboardingNotices: {
              $each: [tutorStatusNotice(input.decision)],
              $slice: -50,
            },
          },
        },
        { new: true },
      )
      .exec();
    if (!saved)
      throw new ConflictException(
        'The application changed or has already been reviewed. Reload it before deciding.',
      );
    await this.audit.record({
      actor,
      action: 'tutor_application.' + input.decision,
      resourceType: 'tutor_application',
      resourceId: id,
      targetUserId: id,
      metadata: { revision: input.revision, decision: input.decision },
    });
    this.notices.kick();
    return this.summary(saved);
  }
}
