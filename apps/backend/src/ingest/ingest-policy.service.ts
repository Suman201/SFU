import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AttachIngestRequest,
  CreateIngestRequest,
  IngestAuthConfig,
  IngestHeaderAuth,
  IngestRestartPolicy,
  IngestSourceType,
  UpdateIngestRequest
} from '@native-sfu/contracts';

const HTTP_SOURCE_TYPES = new Set<IngestSourceType>(['mp4', 'hls']);
const RTSP_SCHEMES = new Set(['rtsp:', 'rtsps:']);
const RTMP_SCHEMES = new Set(['rtmp:', 'rtmps:']);
const HTTP_SCHEMES = new Set(['http:', 'https:']);
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

@Injectable()
export class IngestPolicyService {
  constructor(private readonly config: ConfigService) {}

  normalizeCreateRequest(request: CreateIngestRequest): CreateIngestRequest {
    const sourceType = this.normalizeSourceType(request.sourceType);
    const auth = request.auth ? this.normalizeAuthConfig(request.auth) : undefined;
    const restartPolicy = request.restartPolicy ? this.normalizeRestartPolicy(request.restartPolicy) : undefined;
    return {
      ...(this.cleanOptionalText(request.name, 160) ? { name: this.cleanOptionalText(request.name, 160) } : {}),
      ...(this.cleanOptionalText(request.displayName, 120) ? { displayName: this.cleanOptionalText(request.displayName, 120) } : {}),
      sourceType,
      sourceUrl: this.normalizeSourceUrl(sourceType, request.sourceUrl),
      ...(auth && Object.keys(auth).length > 0 ? { auth } : {}),
      ...(restartPolicy ? { restartPolicy } : {})
    };
  }

  normalizeUpdateRequest(request: UpdateIngestRequest): UpdateIngestRequest {
    const next: UpdateIngestRequest = {};
    if (request.name !== undefined) {
      next.name = this.cleanOptionalText(request.name, 160);
    }
    if (request.displayName !== undefined) {
      next.displayName = this.cleanOptionalText(request.displayName, 120);
    }
    if (request.sourceUrl !== undefined) {
      next.sourceUrl = this.cleanRequiredText(request.sourceUrl, 'Source URL', 4096);
    }
    if (request.auth !== undefined) {
      next.auth = this.normalizeAuthConfig(request.auth);
    }
    if (request.restartPolicy !== undefined) {
      next.restartPolicy = this.normalizeRestartPolicy(request.restartPolicy);
    }
    return next;
  }

  normalizeAttachRequest(roomId: string, request: Omit<AttachIngestRequest, 'roomId'>): AttachIngestRequest {
    return {
      roomId: this.cleanRequiredText(roomId, 'Room id', 160),
      ...(this.cleanOptionalText(request.displayName, 120) ? { displayName: this.cleanOptionalText(request.displayName, 120) } : {}),
      ...(request.startIfStopped !== undefined ? { startIfStopped: Boolean(request.startIfStopped) } : {})
    };
  }

  normalizeSourceUrl(sourceType: IngestSourceType, sourceUrl: string): string {
    const normalizedType = this.normalizeSourceType(sourceType);
    const trimmed = this.cleanRequiredText(sourceUrl, 'Source URL', 4096);
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('Source URL must be a valid absolute URL.');
    }
    this.assertAllowedScheme(normalizedType, parsed);
    if (parsed.username || parsed.password) {
      throw new BadRequestException('Source URL must not embed credentials; use auth secret references instead.');
    }
    this.assertAllowedHost(parsed.hostname);
    return trimmed;
  }

  private normalizeSourceType(sourceType: IngestSourceType): IngestSourceType {
    const normalized = String(sourceType).trim().toLowerCase();
    if (normalized === 'mp4' || normalized === 'hls' || normalized === 'rtsp' || normalized === 'rtmp') {
      return normalized;
    }
    throw new BadRequestException(`Unsupported ingest source type: ${sourceType}`);
  }

  private normalizeAuthConfig(config: IngestAuthConfig): IngestAuthConfig {
    const next: IngestAuthConfig = {};
    const basicUsername = this.cleanOptionalText(config.basicUsername, 120);
    const basicPasswordSecretRef = this.cleanOptionalText(config.basicPasswordSecretRef, 500);
    const bearerTokenSecretRef = this.cleanOptionalText(config.bearerTokenSecretRef, 500);
    if ((basicUsername && !basicPasswordSecretRef) || (!basicUsername && basicPasswordSecretRef)) {
      throw new BadRequestException('Basic auth requires both basicUsername and basicPasswordSecretRef.');
    }
    if (basicUsername) {
      next.basicUsername = basicUsername;
      next.basicPasswordSecretRef = basicPasswordSecretRef;
    }
    if (bearerTokenSecretRef) {
      next.bearerTokenSecretRef = bearerTokenSecretRef;
    }
    if (config.headers?.length) {
      next.headers = this.normalizeHeaders(config.headers);
    }
    return next;
  }

  private normalizeHeaders(headers: IngestHeaderAuth[]): IngestHeaderAuth[] {
    const seen = new Set<string>();
    return headers.map((header) => {
      const name = this.cleanRequiredText(header.name, 'Header name', 120);
      if (!HEADER_NAME_PATTERN.test(name)) {
        throw new BadRequestException(`Header name ${name} is not valid.`);
      }
      const normalizedName = name.toLowerCase();
      if (seen.has(normalizedName)) {
        throw new BadRequestException(`Duplicate auth header ${name} is not allowed.`);
      }
      seen.add(normalizedName);
      return {
        name,
        valueSecretRef: this.cleanRequiredText(header.valueSecretRef, `Header secret ref for ${name}`, 500)
      };
    });
  }

  private normalizeRestartPolicy(policy: IngestRestartPolicy): IngestRestartPolicy {
    const mode = String(policy.mode).trim().toLowerCase();
    if (mode !== 'never' && mode !== 'always' && mode !== 'on_failure') {
      throw new BadRequestException(`Unsupported ingest restart mode: ${policy.mode}`);
    }
    const next: IngestRestartPolicy = { mode };
    if (policy.maxAttempts !== undefined) {
      next.maxAttempts = this.requireInteger(policy.maxAttempts, 'maxAttempts', 1, 100);
    }
    if (policy.initialBackoffMs !== undefined) {
      next.initialBackoffMs = this.requireInteger(policy.initialBackoffMs, 'initialBackoffMs', 100, 3_600_000);
    }
    if (policy.maxBackoffMs !== undefined) {
      next.maxBackoffMs = this.requireInteger(policy.maxBackoffMs, 'maxBackoffMs', 100, 3_600_000);
    }
    if (
      next.initialBackoffMs !== undefined
      && next.maxBackoffMs !== undefined
      && next.maxBackoffMs < next.initialBackoffMs
    ) {
      throw new BadRequestException('maxBackoffMs must be greater than or equal to initialBackoffMs.');
    }
    return next;
  }

  private assertAllowedScheme(sourceType: IngestSourceType, parsed: URL): void {
    const protocol = parsed.protocol.toLowerCase();
    if (HTTP_SOURCE_TYPES.has(sourceType) && !HTTP_SCHEMES.has(protocol)) {
      throw new BadRequestException(`${sourceType} sources must use http or https URLs.`);
    }
    if (sourceType === 'rtsp' && !RTSP_SCHEMES.has(protocol)) {
      throw new BadRequestException('rtsp sources must use rtsp or rtsps URLs.');
    }
    if (sourceType === 'rtmp' && !RTMP_SCHEMES.has(protocol)) {
      throw new BadRequestException('rtmp sources must use rtmp or rtmps URLs.');
    }
  }

  private assertAllowedHost(hostname: string): void {
    const allowlist = [
      ...this.parseAllowlist(this.config.get<string[]>('ingest.allowedSourceHosts')),
      ...this.parseAllowlist(this.config.get<string>('INGEST_ALLOWED_SOURCE_HOSTS'))
    ];
    if (!allowlist.length) {
      return;
    }
    const normalizedHost = hostname.trim().toLowerCase();
    const allowed = allowlist.some((candidate) => normalizedHost === candidate || normalizedHost.endsWith(`.${candidate}`));
    if (!allowed) {
      throw new BadRequestException(`Source host ${hostname} is not in the ingest allowlist.`);
    }
  }

  private parseAllowlist(raw: string[] | string | undefined): string[] {
    if (Array.isArray(raw)) {
      return raw
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    }
    return String(raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  }

  private cleanRequiredText(value: string, label: string, maxLength: number): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException(`${label} is required.`);
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException(`${label} must be at most ${maxLength} characters.`);
    }
    return trimmed;
  }

  private cleanOptionalText(value: string | undefined, maxLength: number): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException(`Value must be at most ${maxLength} characters.`);
    }
    return trimmed;
  }

  private requireInteger(value: number, label: string, min: number, max: number): number {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
      throw new BadRequestException(`${label} must be an integer between ${min} and ${max}.`);
    }
    return normalized;
  }
}
