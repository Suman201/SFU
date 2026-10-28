import {
  STARTER_ASSESSMENTS,
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
    if (!['category', 'subject', 'curriculum'].includes(value))
      throw new BadRequestException(
        'Choose categories, subjects or curricula.',
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
      ...(doc.kind === 'category'
        ? {
            assessmentType:
              doc.assessmentType as TeachingCatalogEntry['assessmentType'],
            assessmentInstructions: doc.assessmentInstructions,
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
    const categories = all.filter((row) => row.kind === 'category');
    const ids = new Set(categories.map((row) => row.id));
    return {
      categories,
      subjects: all.filter(
        (row) => row.kind === 'subject' && ids.has(row.parentId!),
      ),
      curricula: all.filter((row) => row.kind === 'curriculum'),
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
  async write(
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
    const parentId =
      kind === 'subject' ? (input.parentId ?? current?.parentId ?? '') : '';
    if (
      kind === 'subject' &&
      (!isValidObjectId(parentId) ||
        !(await this.entries.exists({
          _id: parentId,
          kind: 'category',
          status: 'active',
        })))
    )
      throw new BadRequestException('Choose an active category.');
    const status = input.status ?? current?.status ?? 'active';
    if (
      kind === 'category' &&
      status === 'archived' &&
      id &&
      (await this.entries.exists({
        kind: 'subject',
        parentId: id,
        status: 'active',
      }))
    )
      throw new ConflictException(
        'Archive or move the active subjects in this category first.',
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
    const update = {
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
        ? { name: current.name, status: current.status }
        : undefined,
      after: { name, status },
    });
    return this.map(saved);
  }
  async starter(actor: AuthenticatedUser) {
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
