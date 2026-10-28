import { randomUUID } from 'node:crypto';
import {
  STARTER_ASSESSMENTS,
  STARTER_BRANCHES,
  STARTER_ACADEMIC_LEVELS,
  STARTER_LEVEL_TASKS,
  STARTER_TEACHING_LANGUAGES,
  STARTER_CURRICULA,
  STARTER_SUBJECTS,
} from './starter-catalog';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import {
  EUROPEAN_MARKETS,
  teachingCategoryPath,
  type TeachingCatalogEntry,
  type TeachingCatalogKind,
  type TeachingCatalogSnapshot,
} from '@native-sfu/contracts';
import {
  TeachingCatalogDocument,
  TeachingCatalogMongo,
} from './catalog.schema';
import { CatalogWriteDto } from './catalog.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
@Injectable()
export class TeachingCatalogService {
  constructor(
    @InjectModel(TeachingCatalogDocument.name)
    private readonly entries: Model<TeachingCatalogMongo>,
    private readonly audit: AuditLogsService,
  ) {}
  private kind(value: string): TeachingCatalogKind {
    if (
      !['category', 'subject', 'curriculum', 'level', 'language'].includes(
        value,
      )
    )
      throw new BadRequestException(
        'Choose categories, subjects, curricula, academic levels or teaching languages.',
      );
    return value as TeachingCatalogKind;
  }
  private map(doc: TeachingCatalogMongo): TeachingCatalogEntry {
    return {
      id: doc.id,
      kind: doc.kind as TeachingCatalogKind,
      name: doc.name,
      description: doc.description,
      ...(doc.parentId ? { parentId: doc.parentId } : {}),
      countryCodes: doc.countryCodes,
      aliases: doc.aliases,
      status: doc.status as TeachingCatalogEntry['status'],
      sortOrder: doc.sortOrder,
      version: doc.__v ?? 0,
      ...(doc.kind === 'category' || doc.kind === 'level'
        ? {
            assessmentType:
              doc.assessmentType as TeachingCatalogEntry['assessmentType'],
            assessmentInstructions: doc.assessmentInstructions,
            ...(doc.kind === 'category'
              ? { assessmentTasks: doc.assessmentTasks ?? [] }
              : {}),
          }
        : {}),
    };
  }
  async snapshot(): Promise<TeachingCatalogSnapshot> {
    const all = (
      await this.entries
        .find({ status: 'active' })
        .sort({ sortOrder: 1, name: 1, _id: 1 })
        .exec()
    ).map((row) => this.map(row));
    const candidates = all.filter((row) => row.kind === 'category');
    const categories = candidates.filter((row) => {
      const path = teachingCategoryPath(candidates, row.id);
      return path.length > 0 && !path[0]!.parentId;
    });
    const ids = new Set(categories.map((row) => row.id));
    return {
      categories,
      subjects: all.filter(
        (row) => row.kind === 'subject' && ids.has(row.parentId!),
      ),
      curricula: all.filter((row) => row.kind === 'curriculum'),
      levels: all.filter((row) => row.kind === 'level'),
      languages: all.filter((row) => row.kind === 'language'),
    };
  }
  async list(query: Record<string, string>) {
    const kind = this.kind(query.kind ?? 'category');
    const page = Number(query.page ?? 1),
      limit = Number(query.limit ?? 25);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid pagination.');
    const filter: Record<string, unknown> = { kind };
    if (query.status && query.status !== 'all') {
      if (!['active', 'archived'].includes(query.status))
        throw new BadRequestException('Invalid status.');
      filter.status = query.status;
    }
    if (query.parentId) {
      if (!isValidObjectId(query.parentId))
        throw new BadRequestException('Invalid category.');
      filter.parentId = query.parentId;
    }
    if (query.q?.trim()) {
      const escaped = query.q
        .trim()
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { aliases: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.entries
        .find(filter)
        .sort({ sortOrder: 1, name: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.entries.countDocuments(filter).exec(),
    ]);
    return { items: items.map((row) => this.map(row)), total, page, limit };
  }
  private async withCatalogLock<T>(work: () => Promise<T>): Promise<T> {
    const locks = this.entries.db.collection<{
      _id: string;
      owner: string;
      expiresAt: Date;
    }>('teaching_catalog_locks');
    const owner = randomUUID();
    try {
      await locks.findOneAndUpdate(
        { _id: 'catalogue', expiresAt: { $lte: new Date() } },
        { $set: { owner, expiresAt: new Date(Date.now() + 300_000) } },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new ConflictException(
          'Another catalogue update is in progress. Please try again shortly.',
        );
      throw error;
    }
    try {
      return await work();
    } finally {
      await locks.deleteOne({ _id: 'catalogue', owner });
    }
  }
  async withStablePolicy<T>(work: () => Promise<T>): Promise<T> {
    return this.withCatalogLock(work);
  }
  async write(
    kindInput: string,
    id: string | null,
    input: CatalogWriteDto,
    actor: AuthenticatedUser,
  ) {
    return this.withCatalogLock(() =>
      this.writeEntry(kindInput, id, input, actor),
    );
  }
  private async writeEntry(
    kindInput: string,
    id: string | null,
    input: CatalogWriteDto,
    actor: AuthenticatedUser,
  ) {
    const kind = this.kind(kindInput);
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (!name) throw new BadRequestException('Name is required.');
    if (id && !isValidObjectId(id))
      throw new BadRequestException('Invalid catalogue entry.');
    const current = id
      ? await this.entries.findOne({ _id: id, kind }).exec()
      : null;
    if (id && !current)
      throw new NotFoundException('Catalogue entry not found.');
    if (current && input.version !== current.__v)
      throw new ConflictException('This entry changed. Reload before saving.');
    const parentId = ['subject', 'category'].includes(kind)
      ? (input.parentId ?? current?.parentId ?? '')
      : '';
    const status = input.status ?? current?.status ?? 'active';
    if (kind === 'subject' && !parentId)
      throw new BadRequestException('Choose a category for this subject.');
    if (parentId) {
      const categories = (
        await this.entries.find({ kind: 'category' }).exec()
      ).map((c) => this.map(c));
      const parent = categories.find((c) => c.id === parentId);
      const ancestors = teachingCategoryPath(categories, parentId);
      if (
        !isValidObjectId(parentId) ||
        !parent ||
        (status === 'active' && ancestors.some((c) => c.status !== 'active'))
      )
        throw new BadRequestException('Choose an active parent category.');
      if (
        kind === 'category' &&
        (id === parentId || ancestors.some((c) => c.id === id))
      )
        throw new BadRequestException(
          'A category cannot be moved under itself or one of its descendants.',
        );
    }
    if (
      kind === 'category' &&
      status === 'archived' &&
      id &&
      (await this.entries.exists({
        kind: { $in: ['category', 'subject'] },
        parentId: id,
        status: 'active',
      }))
    )
      throw new ConflictException(
        'Archive or move the active subcategories and subjects first.',
      );
    const countryCodes = [
      ...new Set(input.countryCodes ?? current?.countryCodes ?? []),
    ];
    if (
      countryCodes.some(
        (code) => !(EUROPEAN_MARKETS as readonly string[]).includes(code),
      )
    )
      throw new BadRequestException('Choose supported European country codes.');
    if (kind !== 'curriculum' && countryCodes.length)
      throw new BadRequestException(
        'Country labels belong to curricula, not subjects.',
      );
    if (input.assessmentTasks !== undefined) {
      if (kind !== 'category')
        throw new BadRequestException(
          'Category-level task overrides belong to a category.',
        );
      if (
        new Set(input.assessmentTasks.map((t) => t.levelId)).size !==
        input.assessmentTasks.length
      )
        throw new BadRequestException(
          'Use one task per academic level in a category.',
        );
      const activeLevels = new Set(
        (await this.snapshot()).levels?.map((l) => l.id),
      );
      if (
        input.assessmentTasks.some(
          (t) =>
            !activeLevels.has(t.levelId) || t.instructions.trim().length < 20,
        )
      )
        throw new BadRequestException(
          'Choose active academic levels and provide useful assessment instructions.',
        );
    }
    if (
      input.assessmentInstructions !== undefined &&
      input.assessmentInstructions.trim().length < 20
    )
      throw new BadRequestException(
        'Assessment instructions need at least 20 characters.',
      );
    const update = {
      assessmentTasks:
        input.assessmentTasks?.map((t) => ({
          ...t,
          instructions: t.instructions.trim(),
        })) ??
        current?.assessmentTasks ??
        [],
      assessmentType:
        input.assessmentType ?? current?.assessmentType ?? 'knowledge_review',
      assessmentInstructions:
        input.assessmentInstructions?.trim() ??
        current?.assessmentInstructions ??
        'Explain a concept from your selected subjects, include a worked example and describe how you would check understanding.',
      kind,
      name,
      normalizedName: name.normalize('NFKC').toLocaleLowerCase('en'),
      description: input.description?.trim() ?? current?.description ?? '',
      parentId,
      countryCodes,
      aliases: [
        ...new Set(
          (input.aliases ?? current?.aliases ?? [])
            .map((a) => a.trim())
            .filter(Boolean),
        ),
      ],
      status,
      sortOrder: input.sortOrder ?? current?.sortOrder ?? 0,
    };
    let saved: TeachingCatalogMongo | null;
    try {
      saved = id
        ? await this.entries
            .findOneAndUpdate(
              { _id: id, kind, __v: input.version },
              { $set: update, $inc: { __v: 1 } },
              { new: true, runValidators: true },
            )
            .exec()
        : await this.entries.create(update);
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new ConflictException(
          'This name already exists in this category, including archived entries.',
        );
      throw error;
    }
    if (!saved)
      throw new ConflictException('This entry changed. Reload before saving.');
    await this.audit.record({
      actor,
      action: id ? 'teaching_catalog.updated' : 'teaching_catalog.created',
      resourceType: kind,
      resourceId: saved.id,
      resourceLabel: name,
      before: current
        ? {
            name: current.name,
            status: current.status,
            parentId: current.parentId,
            assessmentTasks: current.assessmentTasks,
            assessmentInstructions: current.assessmentInstructions,
          }
        : undefined,
      after: {
        name,
        status,
        parentId,
        assessmentTasks: update.assessmentTasks,
        assessmentInstructions: update.assessmentInstructions,
      },
    });
    return this.map(saved);
  }
  async starter(actor: AuthenticatedUser) {
    return this.withCatalogLock(() => this.seedStarter(actor));
  }
  private async seedStarter(actor: AuthenticatedUser) {
    // Add missing defaults only; never rename or reactivate administrator edits.
    const ensure = async (
      kind: string,
      name: string,
      parentId = '',
      countryCodes: string[] = [],
      assessmentType = 'knowledge_review',
      assessmentInstructions = 'Explain a concept from your selected subjects, include a worked example and describe how you would check understanding.',
    ) => {
      const normalizedName = name.normalize('NFKC').toLocaleLowerCase('en');
      const seedKey = [kind, parentId, normalizedName].join(':');
      return this.entries
        .findOneAndUpdate(
          {
            $or: [
              { seedKey },
              { seedKey: { $exists: false }, kind, parentId, normalizedName },
            ],
          },
          {
            $set: { seedKey },
            $setOnInsert: {
              kind,
              parentId,
              normalizedName,
              name,
              countryCodes,
              assessmentType,
              assessmentInstructions,
              status: 'active',
              description: '',
              aliases: [],
              sortOrder: 0,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .exec();
    };
    for (const [name, subjects] of Object.entries(STARTER_SUBJECTS)) {
      const policy =
        STARTER_ASSESSMENTS[name] ?? STARTER_ASSESSMENTS['default']!;
      const category = await ensure(
        'category',
        name,
        '',
        [],
        policy.type,
        policy.instructions,
      );
      for (const subject of subjects)
        await ensure('subject', subject, category!.id);
    }
    for (const branch of STARTER_BRANCHES) {
      let parentId = '';
      for (const part of branch.path) {
        const policy =
          STARTER_ASSESSMENTS[branch.path[0]!] ??
          STARTER_ASSESSMENTS['default']!;
        const category = await ensure(
          'category',
          part,
          parentId,
          [],
          policy.type,
          policy.instructions,
        );
        parentId = category!.id;
      }
      const root = await this.entries
        .findOne({
          seedKey:
            'category::' +
            branch.path[0]!.normalize('NFKC').toLocaleLowerCase('en'),
        })
        .exec();
      for (const name of branch.subjects) {
        const oldKey = [
          'subject',
          root!.id,
          name.normalize('NFKC').toLocaleLowerCase('en'),
        ].join(':');
        const existing = await this.entries.findOne({ seedKey: oldKey }).exec();
        if (existing) {
          // Move untouched defaults once, preserving both IDs and administrator edits.
          await this.entries
            .updateOne(
              {
                _id: existing.id,
                parentId: root!.id,
                __v: 0,
                status: 'active',
              },
              { $set: { parentId }, $inc: { __v: 1 } },
            )
            .exec();
        } else await ensure('subject', name, parentId);
      }
    }
    for (const [index, name] of STARTER_ACADEMIC_LEVELS.entries()) {
      const level = await ensure(
        'level',
        name,
        '',
        [],
        'knowledge_review',
        STARTER_LEVEL_TASKS[name]!,
      );
      // Upgrade untouched level defaults from the earlier generic instructions.
      await this.entries
        .updateOne(
          {
            _id: level!.id,
            __v: 0,
            assessmentInstructions:
              'Explain a concept from your selected subjects, include a worked example and describe how you would check understanding.',
          },
          {
            $set: { assessmentInstructions: STARTER_LEVEL_TASKS[name]! },
            $inc: { __v: 1 },
          },
        )
        .exec();
      await this.entries
        .updateOne(
          { _id: level!.id, __v: 0, sortOrder: 0 },
          { $set: { sortOrder: index } },
        )
        .exec();
    }
    for (const name of STARTER_TEACHING_LANGUAGES)
      await ensure('language', name);
    for (const curriculum of STARTER_CURRICULA)
      await ensure('curriculum', curriculum.name, '', curriculum.countryCodes);
    await this.audit.record({
      actor,
      action: 'teaching_catalog.starter_added',
      resourceType: 'teaching_catalog',
    });
    return this.snapshot();
  }
  async validateSelections(
    subjectIds: string[],
    curriculumIds: string[],
    previousSubjects: string[] = [],
    previousCurricula: string[] = [],
  ) {
    const snapshot = await this.snapshot();
    const subjects = new Set([
      ...snapshot.subjects.map((x) => x.id),
      ...previousSubjects,
    ]);
    const curricula = new Set([
      ...snapshot.curricula.map((x) => x.id),
      ...previousCurricula,
    ]);
    if (subjectIds.some((id) => !subjects.has(id)))
      throw new BadRequestException(
        'Choose active subjects from the catalogue.',
      );
    if (curriculumIds.some((id) => !curricula.has(id)))
      throw new BadRequestException(
        'Choose active curricula from the catalogue.',
      );
  }
}
