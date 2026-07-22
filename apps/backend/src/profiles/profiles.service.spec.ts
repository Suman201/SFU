import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ProfilesService } from './profiles.service';

describe('ProfilesService', () => {
  it('loads and updates a teacher profile with public fields', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      publicProfileEnabled: false
    });
    const { service } = createHarness({ findUser: teacher });

    const updated = await service.updateMyProfile(authUser('teacher-1', ['TEACHER']), {
      displayName: 'Ada Lovelace',
      headline: 'Realtime systems mentor',
      languages: ['English', 'Bengali'],
      skills: ['WebRTC'],
      publicProfileEnabled: true
    });

    expect(teacher.save).toHaveBeenCalled();
    expect(teacher.displayName).toBe('Ada Lovelace');
    expect(teacher.headline).toBe('Realtime systems mentor');
    expect(teacher.publicProfileEnabled).toBe(true);
    expect(updated.displayName).toBe('Ada Lovelace');
    expect(updated.skills).toEqual(['WebRTC']);
    expect(updated.publicProfileEnabled).toBe(true);
  });

  it('rejects student attempts to update teacher-only fields', async () => {
    const student = userDoc({ id: 'student-1', roles: ['STUDENT'], displayName: 'Student One', email: 'student@example.test' });
    const { service } = createHarness({ findUser: student });

    let thrown: unknown;
    try {
      await service.updateMyProfile(authUser('student-1', ['STUDENT']), {
        displayName: 'Student One',
        publicProfileEnabled: true
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(student.save).not.toHaveBeenCalled();
  });

  it('allows students to update safe contact fields without changing enrollment data', async () => {
    const student = userDoc({ id: 'student-1', roles: ['STUDENT'], displayName: 'Student One', email: 'student@example.test' });
    const { service } = createHarness({ findUser: student });

    const updated = await service.updateMyProfile(authUser('student-1', ['STUDENT']), {
      displayName: 'Student One',
      phone: '+15551234567',
      location: 'Kolkata',
      learningGoals: ['WebRTC fundamentals']
    });

    expect(student.save).toHaveBeenCalled();
    expect(student.phone).toBe('+15551234567');
    expect(updated.phone).toBe('+15551234567');
    expect(updated.batches).toEqual([]);
  });

  it('persists normalized self settings with partial updates', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      settings: {
        theme: 'dark',
        locale: 'en-US',
        notifications: {
          email: true,
          classReminders: true,
          chatMessages: true,
          announcements: true,
          recordingReady: true
        },
        privacy: {
          showEmailOnPublicProfile: false,
          allowTeacherMessages: true
        }
      }
    });
    const { service } = createHarness({ findUser: teacher });

    const updated = await service.updateMySettings(authUser('teacher-1', ['TEACHER']), {
      theme: 'light',
      locale: 'en_GB',
      notifications: { chatMessages: false },
      privacy: { showEmailOnPublicProfile: true }
    });

    expect(teacher.save).toHaveBeenCalled();
    const { liveClassDefaults, ...settingsWithoutLiveDefaults } = updated.settings;
    expect(settingsWithoutLiveDefaults).toEqual({
      theme: 'light',
      locale: 'en-GB',
      notifications: {
        email: true,
        classReminders: true,
        chatMessages: false,
        announcements: true,
        recordingReady: true
      },
      privacy: {
        showEmailOnPublicProfile: true,
        allowTeacherMessages: true
      }
    });
    expect(liveClassDefaults).toBeDefined();
  });

  it('returns a safe published teacher profile without private contact fields', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      headline: 'Realtime mentor',
      bio: 'Production classroom systems.',
      publicProfileEnabled: true,
      skills: ['WebRTC'],
      credentials: [{ title: 'Certified SFU Mentor', issuer: 'Native SFU', year: '2026' }]
    });
    const batch = batchDoc({ id: 'batch-1', teacherId: 'teacher-1', name: 'WebRTC Foundations' });
    const { service } = createHarness({ publicTeacher: teacher, batches: [batch] });

    const profile = await service.getPublicTeacherProfile('teacher-1');

    expect(profile.id).toBe('teacher-1');
    expect(profile.displayName).toBe('Ada Teacher');
    expect(profile.skills).toEqual(['WebRTC']);
    expect(profile.credentials[0]?.title).toBe('Certified SFU Mentor');
    expect(profile.batches[0]?.title).toBe('WebRTC Foundations');
    expect(profile.batches[0]?.feeAmount).toBe(1200);
    expect((profile as unknown as { email?: string }).email).toBeUndefined();
  });

  it('returns only published gallery and demo content on public teacher profiles', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      publicProfileEnabled: true
    });
    const { service } = createHarness({
      publicTeacher: teacher,
      publicContents: [
        contentDoc({
          contentId: 'gallery-1',
          teacherId: 'teacher-1',
          itemType: 'gallery',
          title: 'Equation walkthrough',
          mediaType: 'image',
          publicUrl: '/api/v1/profile/public-content/teacher-1/gallery-1/gallery.png',
          publishStatus: 'published'
        }),
        contentDoc({
          contentId: 'demo-1',
          teacherId: 'teacher-1',
          itemType: 'demo_class',
          title: 'Demo class',
          mediaType: 'video',
          externalUrl: 'https://example.test/demo',
          publishStatus: 'published'
        }),
        contentDoc({
          contentId: 'draft-1',
          teacherId: 'teacher-1',
          itemType: 'gallery',
          title: 'Draft artifact',
          mediaType: 'image',
          publishStatus: 'draft'
        })
      ]
    });

    const profile = await service.getPublicTeacherProfile('teacher-1');

    expect(profile.gallery.map((item) => item.contentId)).toEqual(['gallery-1']);
    expect(profile.demoClasses.map((item) => item.contentId)).toEqual(['demo-1']);
  });

  it('allows teachers to publish their own public content draft', async () => {
    const teacher = userDoc({ id: 'teacher-1', roles: ['TEACHER'], displayName: 'Ada Teacher', email: 'ada@example.test' });
    const draft = contentDoc({
      contentId: 'content-1',
      teacherId: 'teacher-1',
      itemType: 'gallery',
      title: 'Matrix board',
      mediaType: 'image',
      publishStatus: 'draft'
    });
    const { service } = createHarness({ findUser: teacher, publicContentFindOne: draft });

    const published = await service.publishMyPublicContent(authUser('teacher-1', ['TEACHER']), 'content-1');

    expect(draft.publishStatus).toBe('published');
    expect(draft.publishedAt).toBeInstanceOf(Date);
    expect(draft.save).toHaveBeenCalled();
    expect(published.publishStatus).toBe('published');
  });

  it('rejects student public content management', async () => {
    const student = userDoc({ id: 'student-1', roles: ['STUDENT'], displayName: 'Student One', email: 'student@example.test' });
    const { service } = createHarness({ findUser: student });

    let thrown: unknown;
    try {
      await service.listMyPublicContent(authUser('student-1', ['STUDENT']));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
  });

  it('lists only active public teachers with safe marketplace fields and published content counts', async () => {
    const publicTeacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      phone: '+15551234567',
      headline: 'Math mentor',
      publicProfileEnabled: true,
      skills: ['Algebra', 'Geometry'],
      languages: ['English'],
      credentials: [{ title: 'Certified Math Mentor', issuer: 'Native SFU' }],
      avatarUrl: '/api/v1/profile/media/teacher-1/avatar.png'
    });
    const privateTeacher = userDoc({
      id: 'teacher-2',
      roles: ['TEACHER'],
      displayName: 'Private Teacher',
      email: 'private@example.test',
      publicProfileEnabled: false
    });
    const disabledTeacher = userDoc({
      id: 'teacher-3',
      roles: ['TEACHER'],
      displayName: 'Disabled Teacher',
      email: 'disabled@example.test',
      publicProfileEnabled: true,
      disabled: true
    });
    const { service } = createHarness({
      publicTeachers: [publicTeacher, privateTeacher, disabledTeacher],
      batches: [batchDoc({ id: 'batch-1', teacherId: 'teacher-1', name: 'Algebra Foundations', courseName: 'Mathematics' })],
      publicContents: [
        contentDoc({ contentId: 'gallery-1', teacherId: 'teacher-1', itemType: 'gallery', publishStatus: 'published' }),
        contentDoc({ contentId: 'demo-1', teacherId: 'teacher-1', itemType: 'demo_class', publishStatus: 'published' }),
        contentDoc({ contentId: 'draft-1', teacherId: 'teacher-1', itemType: 'demo_class', publishStatus: 'draft' })
      ]
    });

    const result = await service.listPublicTeachers({ q: 'ada', skill: 'algebra', page: 1, limit: 12 });

    expect(result.total).toBe(1);
    expect(result.teachers.length).toBe(1);
    expect(result.teachers[0]).toEqual({
      teacherId: 'teacher-1',
      displayName: 'Ada Teacher',
      headline: 'Math mentor',
      avatarUrl: '/api/v1/profile/media/teacher-1/avatar.png',
      skills: ['Algebra', 'Geometry'],
      languages: ['English'],
      highlightedCredential: { title: 'Certified Math Mentor', issuer: 'Native SFU' },
      activePublicBatchCount: 1,
      nextPublicBatchStartAt: '2026-06-24T00:00:00.000Z',
      galleryCount: 1,
      demoClassCount: 1,
      promoted: false
    });
    expect((result.teachers[0] as unknown as { email?: string; phone?: string; settings?: unknown }).email).toBeUndefined();
    expect((result.teachers[0] as unknown as { email?: string; phone?: string; settings?: unknown }).phone).toBeUndefined();
    expect((result.teachers[0] as unknown as { email?: string; phone?: string; settings?: unknown }).settings).toBeUndefined();
  });

  it('allows active public teachers to request profile promotion', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      publicProfileEnabled: true
    });
    const { service, promotions, auditLogs } = createHarness({ findUser: teacher });

    const promotion = await service.requestMyPromotion(authUser('teacher-1', ['TEACHER']), {
      placement: 'marketplace_featured',
      startsAt: '2026-06-25T00:00:00.000Z',
      endsAt: '2026-07-25T00:00:00.000Z',
      reason: 'Summer admissions campaign'
    });

    expect(promotions.create).toHaveBeenCalled();
    expect(auditLogs.record.mock.calls[0]?.[0]?.action).toBe('teacher_promotions.requested');
    expect(promotion.teacherId).toBe('teacher-1');
    expect(promotion.status).toBe('requested');
    expect(promotion.placement).toBe('marketplace_featured');
    expect(promotion.billingStatus).toBe('manual');
  });

  it('rejects promotion requests for private or non-teacher profiles', async () => {
    const privateTeacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Private Teacher',
      email: 'private@example.test',
      publicProfileEnabled: false
    });
    const { service: teacherService } = createHarness({ findUser: privateTeacher });

    let privateThrown: unknown;
    try {
      await teacherService.requestMyPromotion(authUser('teacher-1', ['TEACHER']), {
        placement: 'marketplace_featured',
        startsAt: '2026-06-25T00:00:00.000Z',
        endsAt: '2026-07-25T00:00:00.000Z'
      });
    } catch (error) {
      privateThrown = error;
    }

    const student = userDoc({ id: 'student-1', roles: ['STUDENT'], displayName: 'Student One', email: 'student@example.test' });
    const { service: studentService } = createHarness({ findUser: student });
    let studentThrown: unknown;
    try {
      await studentService.requestMyPromotion(authUser('student-1', ['STUDENT']), {
        placement: 'marketplace_featured',
        startsAt: '2026-06-25T00:00:00.000Z',
        endsAt: '2026-07-25T00:00:00.000Z'
      });
    } catch (error) {
      studentThrown = error;
    }

    expect(privateThrown).toBeInstanceOf(ForbiddenException);
    expect(studentThrown).toBeInstanceOf(ForbiddenException);
  });

  it('blocks overlapping promotion requests for the same placement', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      publicProfileEnabled: true
    });
    const { service } = createHarness({
      findUser: teacher,
      promotions: [
        promotionDoc({
          promotionId: 'promotion-existing',
          teacherId: 'teacher-1',
          placement: 'marketplace_featured',
          status: 'active',
          startsAt: new Date('2026-06-20T00:00:00.000Z'),
          endsAt: new Date('2026-07-20T00:00:00.000Z')
        })
      ]
    });

    let thrown: unknown;
    try {
      await service.requestMyPromotion(authUser('teacher-1', ['TEACHER']), {
        placement: 'marketplace_featured',
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-07-30T00:00:00.000Z'
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  it('lets admins approve promotions and boosts active promoted teachers in marketplace results', async () => {
    const promotedTeacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      publicProfileEnabled: true
    });
    const organicTeacher = userDoc({
      id: 'teacher-2',
      roles: ['TEACHER'],
      displayName: 'Grace Teacher',
      email: 'grace@example.test',
      publicProfileEnabled: true
    });
    const pendingPromotion = promotionDoc({
      promotionId: 'promotion-1',
      teacherId: 'teacher-1',
      teacherName: 'Ada Teacher',
      placement: 'marketplace_featured',
      status: 'requested',
      startsAt: new Date('2026-06-01T00:00:00.000Z'),
      endsAt: new Date('2027-06-01T00:00:00.000Z')
    });
    const { service } = createHarness({
      publicTeacher: promotedTeacher,
      publicTeachers: [organicTeacher, promotedTeacher],
      promotions: [pendingPromotion]
    });

    const approved = await service.approvePromotion('promotion-1', { billingStatus: 'manual' }, authUser('admin-1', ['ADMIN']));
    const result = await service.listPublicTeachers({ page: 1, limit: 12 });

    expect(approved.status).toBe('active');
    expect(pendingPromotion.save).toHaveBeenCalled();
    expect(result.teachers.map((teacher) => teacher.teacherId)).toEqual(['teacher-1', 'teacher-2']);
    expect(result.teachers[0]?.promoted).toBe(true);
    expect(result.teachers[0]?.promotionLabel).toBe('Featured');
  });

  it('does not expose expired or cancelled promotions in marketplace metadata', async () => {
    const teacher = userDoc({
      id: 'teacher-1',
      roles: ['TEACHER'],
      displayName: 'Ada Teacher',
      email: 'ada@example.test',
      publicProfileEnabled: true
    });
    const { service } = createHarness({
      publicTeachers: [teacher],
      promotions: [
        promotionDoc({
          promotionId: 'promotion-expired',
          teacherId: 'teacher-1',
          status: 'expired',
          startsAt: new Date('2026-01-01T00:00:00.000Z'),
          endsAt: new Date('2026-02-01T00:00:00.000Z')
        }),
        promotionDoc({
          promotionId: 'promotion-cancelled',
          teacherId: 'teacher-1',
          status: 'cancelled',
          startsAt: new Date('2026-06-01T00:00:00.000Z'),
          endsAt: new Date('2027-06-01T00:00:00.000Z')
        })
      ]
    });

    const result = await service.listPublicTeachers();

    expect(result.teachers[0]?.promoted).toBe(false);
    expect(result.teachers[0]?.promotionPlacement).toBeUndefined();
  });

  it('filters marketplace teachers by public active batch subject', async () => {
    const { service } = createHarness({
      publicTeachers: [
        userDoc({ id: 'teacher-1', roles: ['TEACHER'], displayName: 'Math Teacher', email: 'math@example.test', publicProfileEnabled: true }),
        userDoc({ id: 'teacher-2', roles: ['TEACHER'], displayName: 'Music Teacher', email: 'music@example.test', publicProfileEnabled: true })
      ],
      batches: [
        batchDoc({ id: 'batch-1', teacherId: 'teacher-1', name: 'Algebra Foundations', courseName: 'Mathematics' }),
        batchDoc({ id: 'batch-2', teacherId: 'teacher-2', name: 'Guitar Basics', courseName: 'Music' })
      ]
    });

    const result = await service.listPublicTeachers({ subject: 'math' });

    expect(result.teachers.map((teacher) => teacher.teacherId)).toEqual(['teacher-1']);
  });

  it('does not expose disabled, missing, or unpublished teacher profiles', async () => {
    const { service } = createHarness({ publicTeacher: null });

    let thrown: unknown;
    try {
      await service.getPublicTeacherProfile('teacher-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it('rejects invalid profile media uploads', async () => {
    const user = userDoc({ id: 'teacher-1', roles: ['TEACHER'], displayName: 'Ada Teacher', email: 'ada@example.test' });
    const { service } = createHarness({ findUser: user });

    let thrown: unknown;
    try {
      await service.uploadProfileMedia(authUser('teacher-1', ['TEACHER']), 'avatarUrl', {
        originalname: 'avatar.svg',
        mimetype: 'image/svg+xml',
        size: 128,
        buffer: Buffer.from('<svg />')
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Only JPEG, PNG, GIF, and WebP profile images are allowed.');
  });

  function createHarness(options: {
    findUser?: Record<string, unknown> | null;
    publicTeacher?: Record<string, unknown> | null;
    publicTeachers?: Array<Record<string, unknown>>;
    batches?: Record<string, unknown>[];
    publicContents?: Array<Record<string, unknown> & { save?: jest.Mock }>;
    publicContentFindOne?: (Record<string, unknown> & { save?: jest.Mock }) | null;
    promotions?: Array<Record<string, unknown> & { save?: jest.Mock }>;
  } = {}): { service: ProfilesService; promotions: Record<string, jest.Mock>; auditLogs: { record: jest.Mock } } {
    const publicTeachers = options.publicTeachers ?? (options.publicTeacher ? [options.publicTeacher] : []);
    const promotionValues = [...(options.promotions ?? [])];
    const users = {
      findOne: jest.fn((filter: Record<string, unknown>) => {
        const candidates = [
          ...(options.findUser ? [options.findUser] : []),
          ...publicTeachers
        ].filter(Boolean) as Record<string, unknown>[];
        const match = candidates.find((user) => matchesUserFilter(user, filter));
        if (match) {
          return queryResult(match);
        }
        return queryResult(null);
      }),
      find: jest.fn((filter: Record<string, unknown>) =>
        queryResult(publicTeachers.filter((user) => matchesUserFilter(user, filter)))
      ),
      countDocuments: jest.fn((filter: Record<string, unknown>) =>
        queryResult(publicTeachers.filter((user) => matchesUserFilter(user, filter)).length)
      )
    };
    const batches = {
      find: jest.fn((filter: Record<string, unknown>) => queryResult((options.batches ?? []).filter((batch) => matchesBatchFilter(batch, filter))))
    };
    const publicContents = {
      create: jest.fn(async (value: Record<string, unknown>) => contentDoc(value)),
      find: jest.fn((filter: Record<string, unknown>) => {
        const values = (options.publicContents ?? []).filter((item) => {
          if (!matchesIdFilter(item.teacherId, filter.teacherId)) return false;
          if (filter.publishStatus && item.publishStatus !== filter.publishStatus) return false;
          return !item.deletedAt;
        });
        return queryResult(values);
      }),
      findOne: jest.fn(() => queryResult(options.publicContentFindOne ?? null))
    };
    const promotions = {
      create: jest.fn(async (value: Record<string, unknown>) => {
        const doc = promotionDoc(value);
        promotionValues.push(doc);
        return doc;
      }),
      find: jest.fn((filter: Record<string, unknown>) => queryResult(promotionValues.filter((promotion) => matchesRecordFilter(promotion, filter)))),
      findOne: jest.fn((filter: Record<string, unknown>) => queryResult(promotionValues.find((promotion) => matchesRecordFilter(promotion, filter)) ?? null)),
      countDocuments: jest.fn((filter: Record<string, unknown>) =>
        queryResult(promotionValues.filter((promotion) => matchesRecordFilter(promotion, filter)).length)
      )
    };
    const schedules = {
      find: jest.fn(() => queryResult([]))
    };
    const enrollments = {
      find: jest.fn(() => queryResult([]))
    };
    const config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback)
    };
    const auditLogs = {
      record: jest.fn(async () => undefined)
    };

    return {
      service: new ProfilesService(
        users as never,
        publicContents as never,
        promotions as never,
        batches as never,
        schedules as never,
        enrollments as never,
        config as never,
        auditLogs as never
      ),
      promotions,
      auditLogs
    };
  }

  function userDoc(values: Record<string, unknown>): Record<string, unknown> & { save: jest.Mock } {
    return {
      name: values.displayName,
      disabled: false,
      status: 'active',
      deletedAt: undefined,
      languages: [],
      skills: [],
      credentials: [],
      education: [],
      experience: [],
      socialLinks: [],
      learningGoals: [],
      interests: [],
      settings: {
        theme: 'system',
        locale: 'en-US',
        notifications: {
          email: true,
          classReminders: true,
          chatMessages: true,
          announcements: true,
          recordingReady: true
        },
        privacy: {
          showEmailOnPublicProfile: false,
          allowTeacherMessages: true
        }
      },
      publicProfileEnabled: false,
      ...values,
      save: jest.fn(async () => undefined)
    };
  }

  function batchDoc(values: Record<string, unknown>): Record<string, unknown> {
    return {
      courseName: 'Native SFU',
      status: 'ACTIVE',
      maxCapacity: 20,
      feeAmount: 1200,
      startDate: new Date('2026-06-24T00:00:00.000Z'),
      ...values
    };
  }

  function contentDoc(values: Record<string, unknown>): Record<string, unknown> & { save: jest.Mock } {
    return {
      contentId: 'content-1',
      teacherId: 'teacher-1',
      itemType: 'gallery',
      title: 'Public content',
      mediaType: 'image',
      tags: [],
      topics: [],
      sortOrder: 0,
      publishStatus: 'draft',
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
      updatedAt: new Date('2026-06-24T00:00:00.000Z'),
      ...values,
      save: jest.fn(async () => undefined)
    };
  }

  function promotionDoc(values: Record<string, unknown>): Record<string, unknown> & { save: jest.Mock } {
    return {
      promotionId: 'promotion-1',
      teacherId: 'teacher-1',
      teacherName: 'Ada Teacher',
      status: 'requested',
      placement: 'marketplace_featured',
      startsAt: new Date('2026-06-24T00:00:00.000Z'),
      endsAt: new Date('2026-07-24T00:00:00.000Z'),
      requestedByUserId: 'teacher-1',
      billingStatus: 'manual',
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
      updatedAt: new Date('2026-06-24T00:00:00.000Z'),
      ...values,
      save: jest.fn(async () => undefined)
    };
  }

  function authUser(sub: string, roles: string[]): AuthenticatedUser {
    return {
      sub,
      email: `${sub}@example.test`,
      roles,
      permissions: [],
      tokenId: 'token-1'
    };
  }

  interface QueryResult<T> {
    exec: jest.Mock<Promise<T>, []>;
    sort: jest.Mock;
    select: jest.Mock;
    skip: jest.Mock;
    limit: jest.Mock;
  }

  function queryResult<T>(value: T): QueryResult<T> {
    const query: QueryResult<T> = {
      exec: jest.fn(async () => value),
      sort: jest.fn(() => query),
      select: jest.fn(() => query),
      skip: jest.fn(() => query),
      limit: jest.fn(() => query)
    };
    return query;
  }

  function matchesUserFilter(user: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    if (filter.publicProfileEnabled !== undefined && user.publicProfileEnabled !== filter.publicProfileEnabled) return false;
    if (filter.disabled !== undefined && !matchesValue(user.disabled, filter.disabled)) return false;
    if (filter.status !== undefined && !matchesValue(user.status, filter.status)) return false;
    if (filter.roles && !stringArray(user.roles).includes(String(filter.roles))) return false;
    if (!matchesIdFilter(user.id, filter._id)) return false;
    if (filter.deletedAt && !matchesValue(user.deletedAt, filter.deletedAt)) return false;
    const andFilters = Array.isArray(filter.$and) ? (filter.$and as Record<string, unknown>[]) : [];
    return andFilters.every((candidate) => matchesSearchFilter(user, candidate));
  }

  function matchesBatchFilter(batch: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    if (filter.status !== undefined && batch.status !== filter.status) return false;
    if (!matchesIdFilter(batch.teacherId, filter.teacherId)) return false;
    if (filter.deletedAt && !matchesValue(batch.deletedAt, filter.deletedAt)) return false;
    const alternatives = Array.isArray(filter.$or) ? (filter.$or as Record<string, unknown>[]) : [];
    if (!alternatives.length) return true;
    return alternatives.some((candidate) => matchesSearchFilter(batch, candidate));
  }

  function matchesRecordFilter(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    const alternatives = Array.isArray(filter.$or) ? (filter.$or as Record<string, unknown>[]) : [];
    if (alternatives.length && !alternatives.some((candidate) => matchesRecordFilter(record, candidate))) return false;
    const andFilters = Array.isArray(filter.$and) ? (filter.$and as Record<string, unknown>[]) : [];
    if (andFilters.length && !andFilters.every((candidate) => matchesRecordFilter(record, candidate))) return false;
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$or' || key === '$and') return true;
      return matchesValue(record[key], value);
    });
  }

  function matchesSearchFilter(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    const alternatives = Array.isArray(filter.$or) ? (filter.$or as Record<string, unknown>[]) : [];
    if (alternatives.length) {
      return alternatives.some((candidate) => matchesSearchFilter(record, candidate));
    }
    return Object.entries(filter).every(([key, value]) => matchesValue(record[key], value));
  }

  function matchesValue(value: unknown, matcher: unknown): boolean {
    if (matcher instanceof RegExp) {
      return Array.isArray(value)
        ? value.some((item) => typeof item === 'string' && matcher.test(item))
        : typeof value === 'string' && matcher.test(value);
    }
    if (matcher && typeof matcher === 'object' && !Array.isArray(matcher) && !(matcher instanceof Date)) {
      const operator = matcher as Record<string, unknown>;
      if ('$exists' in operator) {
        return Boolean(operator.$exists) ? value !== undefined : value === undefined;
      }
      if ('$in' in operator) {
        const values = Array.isArray(operator.$in) ? operator.$in : [];
        return Array.isArray(value) ? value.some((item) => values.includes(item)) : values.includes(value);
      }
      if ('$nin' in operator) {
        const values = Array.isArray(operator.$nin) ? operator.$nin : [];
        return Array.isArray(value) ? value.every((item) => !values.includes(item)) : !values.includes(value);
      }
      if ('$ne' in operator && value === operator.$ne) {
        return false;
      }
      if ('$lte' in operator && compareValue(value, operator.$lte) > 0) {
        return false;
      }
      if ('$lt' in operator && compareValue(value, operator.$lt) >= 0) {
        return false;
      }
      if ('$gte' in operator && compareValue(value, operator.$gte) < 0) {
        return false;
      }
      if ('$gt' in operator && compareValue(value, operator.$gt) <= 0) {
        return false;
      }
      return true;
    }
    return value === matcher;
  }

  function matchesIdFilter(value: unknown, filter: unknown): boolean {
    if (!filter) return true;
    if (typeof filter === 'object' && '$in' in (filter as Record<string, unknown>)) {
      const values = (filter as { $in?: unknown[] }).$in ?? [];
      return values.includes(value);
    }
    if (typeof filter === 'object' && '$nin' in (filter as Record<string, unknown>)) {
      const values = (filter as { $nin?: unknown[] }).$nin ?? [];
      return !values.includes(value);
    }
    return value === filter;
  }

  function compareValue(value: unknown, expected: unknown): number {
    const left = comparable(value);
    const right = comparable(expected);
    return left - right;
  }

  function comparable(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = new Date(value).getTime();
      return Number.isNaN(parsed) ? Number(value) : parsed;
    }
    return Number.NaN;
  }

  function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  }
});
