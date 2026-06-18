import { BeforeApplicationShutdown, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaService } from '@native-sfu/nest-sfu';
import type { ClusterNodeCapacity, ClusterNodeInfo, RoomOwnerInfo, RoomOwnerLookupResponse, RoomOwnerRedirect } from '@native-sfu/contracts';
import { hostname } from 'node:os';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';

const NODE_SET_KEY = 'sfu:nodes';
const ROOM_OWNER_CHANNEL = 'sfu:room-owner-events';

export class RoomOwnerRedirectException extends Error {
  override readonly name = 'ROOM_REDIRECT';

  constructor(readonly details: RoomOwnerRedirect) {
    super(`Room is owned by node ${details.ownerNodeId}`);
  }
}

export class RoomOwnerUnavailableException extends ServiceUnavailableException {
  constructor(roomId: string, reason: string) {
    super({ message: `Room owner is unavailable: ${reason}`, roomId, reason }, 'Room owner unavailable');
  }
}

interface SelectNodeOptions {
  region?: string;
  zone?: string;
  preferLocal?: boolean;
}

@Injectable()
export class NodeRegistryService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(NodeRegistryService.name);
  private readonly nodeId: string;
  private readonly publicUrl: string;
  private readonly region?: string;
  private readonly zone?: string;
  private readonly heartbeatIntervalMs: number;
  private readonly ttlMs: number;
  private readonly preferLocalNode: boolean;
  private readonly maxRooms: number;
  private readonly maxTransports: number;
  private readonly registeredAt = new Date().toISOString();
  private readonly ownedRooms = new Set<string>();
  private runtimeDraining = false;
  private runtimeDrainReason?: string;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly media: MediaService,
    private readonly metrics: MetricsService
  ) {
    this.nodeId = config.get<string>('cluster.nodeId') ?? `node-${hostname()}`;
    this.publicUrl = config.get<string>('cluster.publicUrl') ?? config.get<string>('publicUrl', 'http://localhost:3000');
    this.region = optionalString(config.get<string>('cluster.region'));
    this.zone = optionalString(config.get<string>('cluster.zone'));
    this.heartbeatIntervalMs = config.get<number>('cluster.heartbeatIntervalMs', 5000);
    this.ttlMs = config.get<number>('cluster.ttlMs', 15000);
    this.preferLocalNode = config.get<boolean>('cluster.preferLocalNode', true);
    this.maxRooms = config.get<number>('cluster.maxRooms', 1000);
    this.maxTransports = config.get<number>('cluster.maxTransports', 5000);
  }

  async onModuleInit(): Promise<void> {
    await this.heartbeatNow();
    this.heartbeat = setInterval(() => {
      void this.heartbeatNow().catch((error) => {
        this.logger.warn(`Node heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.heartbeatIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    await this.beginDraining('module_destroy').catch((error) => {
      this.logger.warn(`Failed to publish final draining heartbeat: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.runtimeDraining = true;
    this.runtimeDrainReason = signal ? `shutdown:${signal}` : 'shutdown';
  }

  localNodeId(): string {
    return this.nodeId;
  }

  localPublicUrl(): string {
    return this.publicUrl;
  }

  async beginDraining(reason = 'manual'): Promise<ClusterNodeInfo> {
    if (!this.runtimeDraining) {
      this.logger.warn(`Node ${this.nodeId} entering draining mode: ${reason}`);
    }
    this.runtimeDraining = true;
    this.runtimeDrainReason = reason;
    const node = await this.heartbeatNow();
    await this.redis.publish(ROOM_OWNER_CHANNEL, { type: 'node-draining', nodeId: this.nodeId, reason, node });
    return node;
  }

  async endDraining(): Promise<ClusterNodeInfo> {
    this.runtimeDraining = false;
    this.runtimeDrainReason = undefined;
    const node = await this.heartbeatNow();
    await this.redis.publish(ROOM_OWNER_CHANNEL, { type: 'node-undrained', nodeId: this.nodeId, node });
    return node;
  }

  localDrainReason(): string | undefined {
    return this.runtimeDrainReason;
  }

  async heartbeatNow(): Promise<ClusterNodeInfo> {
    const startedAt = Date.now();
    const node = this.localNodeSnapshot();
    await this.redis.raw.sadd(NODE_SET_KEY, this.nodeId);
    await this.redis.raw.set(nodeKey(this.nodeId), JSON.stringify(node), 'PX', this.ttlMs);
    for (const roomId of this.ownedRooms) {
      await this.renewRoomOwner(roomId, node);
    }
    this.metrics.clusterNodeHeartbeatLatency.observe(Date.now() - startedAt);
    return node;
  }

  localNodeSnapshot(): ClusterNodeInfo {
    const now = new Date();
    const capacity = this.localCapacity();
    const draining = this.isDraining();
    const overloaded = capacity.capacityScore >= 1;
    return {
      nodeId: this.nodeId,
      publicUrl: this.publicUrl,
      region: this.region,
      zone: this.zone,
      health: draining ? 'draining' : overloaded ? 'overloaded' : 'healthy',
      draining,
      capacity,
      registeredAt: this.registeredAt,
      lastHeartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
    };
  }

  async listNodes(): Promise<ClusterNodeInfo[]> {
    const ids = await this.redis.raw.smembers(NODE_SET_KEY);
    const nodes: ClusterNodeInfo[] = [];
    for (const id of ids) {
      const node = await this.redis.getJson<ClusterNodeInfo>(nodeKey(id));
      if (!node || this.isExpired(node.expiresAt)) {
        await this.redis.raw.srem(NODE_SET_KEY, id);
        continue;
      }
      nodes.push(node);
    }
    return nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  async selectNode(options: SelectNodeOptions = {}): Promise<ClusterNodeInfo | undefined> {
    const nodes = await this.listNodes();
    const candidates = nodes
      .filter((node) => node.health === 'healthy' && !node.draining && node.capacity.capacityScore < 1)
      .filter((node) => !options.region || node.region === options.region)
      .sort((left, right) => nodeScore(left, options) - nodeScore(right, options));
    if (options.preferLocal ?? this.preferLocalNode) {
      const local = candidates.find((node) => node.nodeId === this.nodeId);
      if (local) {
        return local;
      }
    }
    return candidates[0];
  }

  async assertLocalCanOwnNewRoom(): Promise<void> {
    await this.heartbeatNow();
    const local = this.localNodeSnapshot();
    if (local.draining) {
      this.metrics.remoteRoomJoinAttempts.labels('create_on_draining').inc();
      throw new RoomOwnerRedirectException({
        ownerNodeId: local.nodeId,
        ownerUrl: local.publicUrl,
        region: local.region,
        zone: local.zone,
        reason: 'local_node_draining'
      });
    }
    if (local.capacity.capacityScore >= 1) {
      this.metrics.roomAdmissionRejections.labels('node_overloaded').inc();
      throw new RoomOwnerRedirectException({
        ownerNodeId: local.nodeId,
        ownerUrl: local.publicUrl,
        region: local.region,
        zone: local.zone,
        reason: 'local_node_overloaded'
      });
    }
  }

  async claimRoom(roomId: string): Promise<RoomOwnerInfo> {
    await this.assertLocalCanOwnNewRoom();
    const node = this.localNodeSnapshot();
    const owner = this.ownerFromNode(roomId, node);
    const result = await this.redis.raw.set(roomOwnerKey(roomId), JSON.stringify(owner), 'PX', this.ttlMs, 'NX');
    if (result === 'OK') {
      await this.redis.raw.sadd(nodeRoomsKey(this.nodeId), roomId);
      this.ownedRooms.add(roomId);
      this.metrics.roomOwnershipClaims.labels('ok').inc();
      await this.redis.publish(ROOM_OWNER_CHANNEL, { type: 'claimed', owner });
      return owner;
    }
    const existing = await this.getRoomOwner(roomId);
    if (existing?.nodeId === this.nodeId) {
      await this.renewRoomOwner(roomId, node);
      return existing;
    }
    this.metrics.roomOwnershipClaims.labels('conflict').inc();
    this.metrics.roomOwnershipConflicts.inc();
    if (existing) {
      throw new RoomOwnerRedirectException({
        roomId,
        ownerNodeId: existing.nodeId,
        ownerUrl: existing.publicUrl,
        region: existing.region,
        zone: existing.zone,
        reason: 'room_owned_by_remote_node'
      });
    }
    throw new RoomOwnerUnavailableException(roomId, 'claim_conflict');
  }

  async getRoomOwner(roomId: string): Promise<RoomOwnerInfo | undefined> {
    const startedAt = Date.now();
    const owner = await this.redis.getJson<RoomOwnerInfo>(roomOwnerKey(roomId));
    this.metrics.roomOwnerLookupLatency.observe(Date.now() - startedAt);
    if (!owner) {
      return undefined;
    }
    if (this.isExpired(owner.expiresAt)) {
      this.metrics.staleRoomOwners.inc();
      return undefined;
    }
    return owner;
  }

  async lookupRoomOwner(roomId: string): Promise<RoomOwnerLookupResponse> {
    const owner = await this.getRoomOwner(roomId);
    if (!owner) {
      return { roomId, local: false, available: false, reason: 'missing' };
    }
    const ownerNode = await this.redis.getJson<ClusterNodeInfo>(nodeKey(owner.nodeId));
    if (!ownerNode || this.isExpired(ownerNode.expiresAt)) {
      this.metrics.staleRoomOwners.inc();
      return { roomId, owner, local: owner.nodeId === this.nodeId, available: false, reason: 'owner_expired' };
    }
    if (ownerNode.draining) {
      return { roomId, owner, local: owner.nodeId === this.nodeId, available: true, reason: 'owner_draining' };
    }
    if (ownerNode.health !== 'healthy' && ownerNode.health !== 'overloaded') {
      return { roomId, owner, local: owner.nodeId === this.nodeId, available: false, reason: 'owner_unhealthy' };
    }
    return { roomId, owner, local: owner.nodeId === this.nodeId, available: true };
  }

  async assertLocalRoomOwner(roomId: string): Promise<void> {
    const lookup = await this.lookupRoomOwner(roomId);
    if (!lookup.owner) {
      this.metrics.staleRoomOwners.inc();
      throw new RoomOwnerUnavailableException(roomId, lookup.reason ?? 'missing');
    }
    if (!lookup.available) {
      throw new RoomOwnerUnavailableException(roomId, lookup.reason ?? 'unavailable');
    }
    if (lookup.owner.nodeId !== this.nodeId) {
      this.metrics.remoteRoomJoinAttempts.labels('non_owner_command').inc();
      this.metrics.roomOwnerRedirects.labels('non_owner_command').inc();
      throw new RoomOwnerRedirectException({
        roomId,
        ownerNodeId: lookup.owner.nodeId,
        ownerUrl: lookup.owner.publicUrl,
        region: lookup.owner.region,
        zone: lookup.owner.zone,
        reason: 'room_owned_by_remote_node'
      });
    }
  }

  async releaseRoom(roomId: string): Promise<void> {
    const owner = await this.getRoomOwner(roomId);
    if (owner?.nodeId === this.nodeId) {
      await this.redis.del(roomOwnerKey(roomId));
      await this.redis.raw.srem(nodeRoomsKey(this.nodeId), roomId);
      await this.redis.publish(ROOM_OWNER_CHANNEL, { type: 'released', owner });
    }
    this.ownedRooms.delete(roomId);
  }

  async snapshot(): Promise<{
    localNode: ClusterNodeInfo;
    nodes: ClusterNodeInfo[];
    ownedRoomCount: number;
  }> {
    const nodes = await this.listNodes();
    const localNode = this.localNodeSnapshot();
    this.metrics.clusterRegisteredNodes.set(nodes.length);
    this.metrics.clusterHealthyNodes.set(nodes.filter((node) => node.health === 'healthy').length);
    this.metrics.clusterDrainingNodes.set(nodes.filter((node) => node.draining).length);
    this.metrics.clusterOwnedRooms.set(this.ownedRooms.size);
    this.metrics.clusterNodeInfo.labels(localNode.nodeId, localNode.region ?? 'unknown', localNode.zone ?? 'unknown').set(1);
    return {
      localNode,
      nodes,
      ownedRoomCount: this.ownedRooms.size
    };
  }

  private async renewRoomOwner(roomId: string, node: ClusterNodeInfo): Promise<void> {
    const owner = await this.getRoomOwner(roomId);
    if (owner && owner.nodeId !== this.nodeId) {
      this.metrics.roomOwnershipConflicts.inc();
      return;
    }
    const next = this.ownerFromNode(roomId, node, owner?.claimedAt);
    await this.redis.raw.set(roomOwnerKey(roomId), JSON.stringify(next), 'PX', this.ttlMs);
  }

  private ownerFromNode(roomId: string, node: ClusterNodeInfo, claimedAt = new Date().toISOString()): RoomOwnerInfo {
    return {
      roomId,
      nodeId: node.nodeId,
      publicUrl: node.publicUrl,
      region: node.region,
      zone: node.zone,
      claimedAt,
      lastHeartbeatAt: node.lastHeartbeatAt,
      expiresAt: node.expiresAt
    };
  }

  private localCapacity(): ClusterNodeCapacity {
    const snapshot = this.media.workerPoolSnapshot();
    const workerCount = Math.max(snapshot.workerCount, 1);
    const activeTransports = snapshot.workers.reduce((total, worker) => total + worker.activeTransports, 0);
    const activeProducers = snapshot.workers.reduce((total, worker) => total + worker.activeProducers, 0);
    const activeConsumers = snapshot.workers.reduce((total, worker) => total + worker.activeConsumers, 0);
    const averageIpcLatencyMs =
      snapshot.workers.length === 0 ? 0 : snapshot.workers.reduce((total, worker) => total + worker.averageIpcLatencyMs, 0) / snapshot.workers.length;
    const memoryRssBytes = snapshot.workers.reduce((total, worker) => total + (worker.memory?.rss ?? 0), 0) || undefined;
    const cpuUserMicros = snapshot.workers.reduce((total, worker) => total + (worker.cpu?.user ?? 0), 0) || undefined;
    const workerCapacityScore = snapshot.workers.reduce((score, worker) => Math.max(score, worker.capacityScore ?? 0), 0);
    const capacityScore = Math.max(workerCapacityScore, ratio(snapshot.activeRooms, this.maxRooms), ratio(activeTransports, this.maxTransports));
    return {
      activeRooms: snapshot.activeRooms,
      activeTransports,
      activeProducers,
      activeConsumers,
      workerCount,
      readyWorkers: snapshot.readyWorkers,
      drainingWorkers: snapshot.drainingWorkers,
      overloadedWorkers: snapshot.overloadedWorkers,
      averageIpcLatencyMs,
      memoryRssBytes,
      cpuUserMicros,
      capacityScore
    };
  }

  private isDraining(): boolean {
    return this.runtimeDraining || this.config.get<boolean>('cluster.draining', false);
  }

  private isExpired(expiresAt: string): boolean {
    return Date.parse(expiresAt) <= Date.now();
  }
}

function nodeKey(nodeId: string): string {
  return `sfu:node:${nodeId}`;
}

function nodeRoomsKey(nodeId: string): string {
  return `sfu:node:${nodeId}:rooms`;
}

function roomOwnerKey(roomId: string): string {
  return `sfu:room:${roomId}:owner`;
}

function optionalString(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function ratio(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return Math.max(0, value / max);
}

function nodeScore(node: ClusterNodeInfo, options: SelectNodeOptions): number {
  const regionPenalty = options.region && node.region !== options.region ? 1000 : 0;
  const zonePenalty = options.zone && node.zone !== options.zone ? 100 : 0;
  return regionPenalty + zonePenalty + node.capacity.capacityScore;
}
