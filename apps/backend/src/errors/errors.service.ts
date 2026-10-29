import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ERROR_CATALOG,
  errorFrames,
  errorPath,
  errorReason,
  publicErrorCode,
  type ApiErrorBody,
  type ErrorIncident,
  type ErrorIncidentPage,
} from '@native-sfu/contracts';
import { ErrorIncidentDocument } from './error-incident.schema';
import { ListErrorsDto, ReportErrorDto } from './errors.dto';

@Injectable()
export class ErrorsService {
  private readonly logger = new Logger(ErrorsService.name);
  private pending = 0;
  constructor(
    @InjectModel(ErrorIncidentDocument.name)
    private readonly incidents: Model<ErrorIncidentDocument>,
  ) {}

  /** Recording must never delay or replace the original error response. No request payloads. */
  capture(
    body: ApiErrorBody,
    exception: unknown,
    request: {
      method?: string;
      user?: { sub?: string };
      route?: { path?: string };
    },
  ): void {
    const error = exception instanceof Error ? exception : undefined;
    const exceptionName = /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(error?.name ?? '')
      ? error!.name
      : 'Error';
    // Only frame lines: error.message, source excerpts and arbitrary stack contents are excluded.
    const frames = errorFrames(error?.stack);
    const entry = {
      reference: body.requestId,
      requestId: body.requestId,
      code: body.code,
      reason: body.reason,
      source: 'server',
      statusCode: body.statusCode,
      method: request.method,
      path: errorPath(request.route?.path ?? body.path),
      title: body.title,
      message: ERROR_CATALOG[body.reason].message,
      nextStep: body.nextStep,
      exceptionName,
      frames,
      ...developerDiagnosis(exception),
      userId: request.user?.sub,
      status: 'open',
      createdAt: new Date(),
    };
    this.logger.error({ event: 'application_error', ...entry });
    // Bound pending writes during a database outage; structured logs still contain the reference.
    if (this.pending >= 50) return;
    this.pending++;
    void this.incidents
      .create(entry)
      .catch(() => {
        this.logger.warn({
          event: 'error_incident_store_unavailable',
          requestId: body.requestId,
        });
      })
      .finally(() => {
        this.pending--;
      });
  }

  async report(
    input: ReportErrorDto,
    userId: string,
  ): Promise<{ reference: string }> {
    // This is client-reported metadata, never a trusted statement about a server exception.
    const reason = errorReason(input.code);
    if (!reason || (input.reason && input.reason !== reason))
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: 'The error code and reason do not match.',
      });
    const text = ERROR_CATALOG[reason];
    await this.incidents.findOneAndUpdate(
      { source: input.source, userId, reference: input.reference },
      {
        $setOnInsert: {
          ...input,
          ...text,
          reason,
          frames: errorFrames(input.frames?.join('\n')),
          path: errorPath(input.path),
          userId,
          status: 'open',
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    return { reference: input.reference };
  }

  async list(query: ListErrorsDto): Promise<ErrorIncidentPage> {
    const filter: Record<string, unknown> = {};
    if (query.status !== 'all') filter.status = query.status;
    if (query.source !== 'all') filter.source = query.source;
    const reference = query.reference.trim();
    if (reference) filter.$or = [{ reference }, { requestId: reference }];
    const limit = 25;
    const [rows, total] = await Promise.all([
      this.incidents
        .find(filter)
        .select('-frames')
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * limit)
        .limit(limit)
        .lean(),
      this.incidents.countDocuments(filter),
    ]);
    return {
      items: rows.map((row) => this.serialize(row)),
      total,
      page: query.page,
      limit,
    };
  }
  async get(id: string): Promise<ErrorIncident> {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Error record not found.');
    const row = await this.incidents.findById(id).lean();
    if (!row) throw new NotFoundException('Error record not found.');
    return this.serialize(row);
  }
  async update(
    id: string,
    status: 'open' | 'resolved',
    userId: string,
  ): Promise<ErrorIncident> {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Error record not found.');
    const update =
      status === 'resolved'
        ? { $set: { status, resolvedAt: new Date(), resolvedBy: userId } }
        : { $set: { status }, $unset: { resolvedAt: 1, resolvedBy: 1 } };
    const row = await this.incidents
      .findByIdAndUpdate(id, update, { new: true })
      .lean();
    if (!row) throw new NotFoundException('Error record not found.');
    return this.serialize(row);
  }
  private serialize(
    row: ErrorIncidentDocument & { _id: Types.ObjectId },
  ): ErrorIncident {
    const { _id, createdAt, resolvedAt, ...data } = row;
    const reason =
      errorReason(data.code) ?? errorReason(data.reason) ?? 'INTERNAL_ERROR';
    return {
      ...data,
      code: publicErrorCode(reason),
      reason,
      source: data.source as ErrorIncident['source'],
      status: data.status as ErrorIncident['status'],
      id: String(_id),
      createdAt: new Date(createdAt).toISOString(),
      ...(resolvedAt ? { resolvedAt: new Date(resolvedAt).toISOString() } : {}),
    };
  }
}

/** Known failure classes only: never infer from or retain an arbitrary exception message. */
export function developerDiagnosis(exception: unknown): {
  diagnosticKind: string;
  developerHint: string;
} {
  const error =
    exception && typeof exception === 'object'
      ? (exception as { name?: string; code?: unknown })
      : {};
  if (error.name === 'MongoServerError' && error.code === 121)
    return {
      diagnosticKind: 'database_validation',
      developerHint:
        'The database rejected the record against its validation rules. Check the collection validator and the server data schema.',
    };
  if (error.name === 'MongoServerError' && error.code === 11000)
    return {
      diagnosticKind: 'database_conflict',
      developerHint:
        'A database uniqueness constraint rejected this write. Check duplicate handling and the relevant unique index.',
    };
  if (
    [
      'MongoNetworkError',
      'MongoServerSelectionError',
      'MongooseServerSelectionError',
    ].includes(error.name ?? '') ||
    ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(String(error.code))
  )
    return {
      diagnosticKind: 'dependency_unreachable',
      developerHint:
        'The server could not reach a required dependency. Check service health, connection configuration and network access.',
    };
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(String(error.code)))
    return {
      diagnosticKind: 'dependency_timeout',
      developerHint:
        'A dependency did not respond before its timeout. Check dependency latency and resource use.',
    };
  if (['ValidationError', 'CastError'].includes(error.name ?? ''))
    return {
      diagnosticKind: 'invalid_data',
      developerHint:
        'The server could not validate or convert the data. Inspect the indicated code location and stored record format.',
    };
  return {
    diagnosticKind: 'application_exception',
    developerHint:
      'The server raised an unexpected exception. Inspect the file and line references, and correlate the request ID with server logs.',
  };
}
