import { EventEmitter } from 'events';
import dgram, { RemoteInfo, Socket } from 'dgram';
import { createHash, randomBytes } from 'crypto';
import { networkInterfaces } from 'os';
import type { IceCandidate, IceParameters } from '@native-sfu/contracts';
import { computeCandidateFoundation, computeCandidatePriority, createCandidatePair, isCompatiblePair, pairId } from './candidate';
import {
  createTransactionId,
  decodeXorMappedAddress,
  encodeDataAttribute,
  encodeEmptyAttribute,
  encodeRequestedTransport,
  encodeStunMessage,
  encodeStringAttribute,
  encodeUInt32Attribute,
  encodeUInt64Attribute,
  encodeXorMappedAddress,
  encodeXorPeerAddress,
  getAttribute,
  getUsername,
  hasUseCandidate,
  isStunMessage,
  parseStunMessage,
  readUInt64Attribute,
  type StunAttribute,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS_RESPONSE,
  STUN_ALLOCATE_REQUEST,
  STUN_ALLOCATE_SUCCESS_RESPONSE,
  STUN_ALLOCATE_ERROR_RESPONSE,
  STUN_CREATE_PERMISSION_REQUEST,
  STUN_CREATE_PERMISSION_SUCCESS_RESPONSE,
  STUN_DATA_INDICATION,
  STUN_SEND_INDICATION,
  StunAttributeType,
  verifyFingerprint,
  verifyMessageIntegrity
} from './stun-message';
import { UdpPortAllocator } from './udp-port-allocator';
import type { IceAgentOptions, IceAgentSnapshot, IceAgentState, IceCandidatePair, IceRole, LocalIceCandidate, RemoteIceCandidate, TurnRelayAllocation, TurnServerOptions } from './ice.types';

interface IceSocketContext {
  id: string;
  socket: Socket;
  candidate: LocalIceCandidate;
}

interface PendingTransaction {
  pair: IceCandidatePair;
  transactionIdHex: string;
  useCandidate: boolean;
  sentAt: number;
  consent: boolean;
  timeout: NodeJS.Timeout;
}

interface ServerTransaction {
  timeout: NodeJS.Timeout;
  resolve: (response: StunServerResponse) => void;
  reject: (error: Error) => void;
}

interface StunServerResponse {
  raw: Buffer;
  message: ReturnType<typeof parseStunMessage>;
  remote: RemoteInfo;
}

interface RelayIngressContext {
  localCandidate: LocalIceCandidate;
}

export class IceAgent extends EventEmitter {
  readonly transportId: string;
  readonly roomId: string;
  readonly participantId: string;
  readonly localParameters: IceParameters;
  readonly role: IceRole;
  readonly tieBreaker: bigint;

  private state: IceAgentState = 'new';
  private remoteParameters?: IceParameters;
  private readonly localCandidates: LocalIceCandidate[] = [];
  private readonly remoteCandidates = new Map<string, RemoteIceCandidate>();
  private readonly pairs = new Map<string, IceCandidatePair>();
  private readonly sockets = new Map<string, IceSocketContext>();
  private readonly transactions = new Map<string, PendingTransaction>();
  private readonly serverTransactions = new Map<string, ServerTransaction>();
  private selectedPair?: IceCandidatePair;
  private checkTimer?: NodeJS.Timeout;
  private consentTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly options: IceAgentOptions,
    private readonly portAllocator?: UdpPortAllocator
  ) {
    super();
    this.transportId = options.transportId;
    this.roomId = options.roomId;
    this.participantId = options.participantId;
    this.role = options.role ?? 'controlled';
    this.tieBreaker = options.tieBreaker ?? randomTieBreaker();
    this.localParameters = {
      usernameFragment: randomBytes(12).toString('base64url'),
      password: randomBytes(24).toString('base64url'),
      iceLite: false
    };
  }

  snapshot(): IceAgentSnapshot {
    return {
      transportId: this.transportId,
      state: this.state,
      role: this.role,
      localParameters: this.localParameters,
      remoteParameters: this.remoteParameters,
      localCandidates: [...this.localCandidates],
      remoteCandidates: [...this.remoteCandidates.values()],
      selectedPair: this.selectedPair
    };
  }

  async gatherCandidates(): Promise<LocalIceCandidate[]> {
    this.assertOpen();
    if (this.localCandidates.length > 0) {
      return [...this.localCandidates];
    }
    this.setState('gathering');
    const interfaces = gatherInterfaceAddresses(this.options.includeLoopbackCandidates ?? false, this.options.gatherInterfaces);
    for (const address of interfaces) {
      await this.bindHostCandidate(address);
    }
    await this.gatherServerReflexiveCandidates();
    await this.gatherRelayCandidates();
    this.setState('new');
    return [...this.localCandidates];
  }

  setRemoteParameters(parameters: IceParameters): void {
    this.assertOpen();
    if (!parameters.usernameFragment || !parameters.password) {
      throw new Error('Remote ICE parameters require usernameFragment and password');
    }
    this.remoteParameters = parameters;
    this.formCandidatePairs();
  }

  addRemoteCandidate(candidate: IceCandidate): RemoteIceCandidate {
    this.assertOpen();
    validateRemoteCandidate(candidate);
    const remote: RemoteIceCandidate = {
      ...candidate,
      transportId: this.transportId,
      foundation: candidate.foundation || computeCandidateFoundation(candidate),
      priority: candidate.priority || computeCandidatePriority(candidate)
    };
    this.remoteCandidates.set(remoteCandidateKey(remote), remote);
    this.formCandidatePairs();
    return remote;
  }

  startConnectivityChecks(): void {
    this.assertOpen();
    if (!this.remoteParameters || this.remoteCandidates.size === 0 || this.localCandidates.length === 0) {
      return;
    }
    this.setState('checking');
    this.scheduleNextCheck(0);
  }

  async restart(): Promise<LocalIceCandidate[]> {
    this.assertOpen();
    this.remoteParameters = undefined;
    this.remoteCandidates.clear();
    this.pairs.clear();
    this.selectedPair = undefined;
    for (const transaction of this.transactions.values()) {
      clearTimeout(transaction.timeout);
    }
    this.transactions.clear();
    for (const transaction of this.serverTransactions.values()) {
      clearTimeout(transaction.timeout);
      transaction.reject(new Error('ICE agent closed'));
    }
    this.serverTransactions.clear();
    this.localParameters.usernameFragment = randomBytes(12).toString('base64url');
    this.localParameters.password = randomBytes(24).toString('base64url');
    this.stopCheckTimer();
    this.stopConsentFreshness();
    this.setState('new');
    return [...this.localCandidates];
  }

  startConsentFreshness(): void {
    this.assertOpen();
    this.stopConsentFreshness();
    const interval = this.options.consentIntervalMs ?? 15_000;
    this.consentTimer = setInterval(() => {
      void this.refreshConsentOnce();
    }, interval);
    this.consentTimer.unref?.();
  }

  stopConsentFreshness(): void {
    if (this.consentTimer) {
      clearInterval(this.consentTimer);
      this.consentTimer = undefined;
    }
  }

  async refreshConsentOnce(): Promise<boolean> {
    this.assertOpen();
    if (!this.selectedPair || !this.remoteParameters) {
      return false;
    }
    try {
      await this.sendBindingRequest(this.selectedPair, false, true);
      return true;
    } catch {
      this.selectedPair.failures += 1;
      if (this.selectedPair.failures >= (this.options.maxConsentFailures ?? 6)) {
        this.setState('disconnected');
      }
      return false;
    }
  }

  selectedCandidatePair(): IceCandidatePair | undefined {
    return this.selectedPair;
  }

  async sendSelectedDatagram(packet: Buffer): Promise<void> {
    this.assertOpen();
    if (!this.selectedPair) {
      throw new Error('ICE selected candidate pair is required before sending media datagrams');
    }
    const socketContext = this.sockets.get(this.selectedPair.local.socketId);
    if (!socketContext) {
      throw new Error('Local ICE socket not found');
    }
    if (this.selectedPair.local.relay) {
      await this.sendViaTurnRelay(socketContext, this.selectedPair, packet);
      return;
    }
    await sendUdp(socketContext.socket, packet, this.selectedPair.remote.port, this.selectedPair.remote.ip);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopCheckTimer();
    this.stopConsentFreshness();
    for (const transaction of this.transactions.values()) {
      clearTimeout(transaction.timeout);
    }
    this.transactions.clear();
    for (const transaction of this.serverTransactions.values()) {
      clearTimeout(transaction.timeout);
      transaction.reject(new Error('ICE agent closed'));
    }
    this.serverTransactions.clear();
    for (const context of this.sockets.values()) {
      context.socket.close();
      this.portAllocator?.release(context.candidate.port);
    }
    this.sockets.clear();
    this.setState('closed');
  }

  private async bindHostCandidate(address: string): Promise<void> {
    const socket = dgram.createSocket('udp4');
    const port = this.options.hostPortRange ? this.portAllocator?.acquire() ?? 0 : 0;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off('listening', onListening);
        if (port) {
          this.portAllocator?.release(port);
        }
        reject(error);
      };
      const onListening = () => {
        socket.off('error', onError);
        resolve();
      };
      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(port, address);
    });
    const bound = socket.address();
    if (typeof bound === 'string') {
      socket.close();
      return;
    }
    const announcedAddress = this.options.announcedAddress?.trim() || address;
    const candidate: LocalIceCandidate = {
      transportId: this.transportId,
      socketId: `${address}:${bound.port}`,
      foundation: computeCandidateFoundation({ type: 'host', protocol: 'udp', ip: announcedAddress }),
      component: 1,
      protocol: 'udp',
      priority: computeCandidatePriority({ type: 'host', component: 1 }),
      ip: announcedAddress,
      port: bound.port,
      type: 'host',
      baseAddress: address,
      basePort: bound.port
    };
    socket.on('message', (message, remote) => {
      void this.handleSocketMessage(candidate.socketId, message, remote);
    });
    socket.on('error', (error) => this.emit('error', error));
    this.localCandidates.push(candidate);
    this.sockets.set(candidate.socketId, { id: candidate.socketId, socket, candidate });
  }

  private async gatherServerReflexiveCandidates(): Promise<void> {
    for (const url of this.options.stunServers ?? []) {
      const server = parseIceServerUrl(url, 'stun');
      if (!server || server.transport !== 'udp') {
        continue;
      }
      for (const context of [...this.sockets.values()]) {
        try {
          const response = await this.sendServerRequest(context, server, STUN_BINDING_REQUEST, []);
          if (response.message.type !== STUN_BINDING_SUCCESS_RESPONSE) {
            continue;
          }
          const mapped = getAttribute(response.message, StunAttributeType.XOR_MAPPED_ADDRESS);
          if (!mapped) {
            continue;
          }
          const address = decodeXorMappedAddress(mapped, response.message.transactionId);
          this.addLocalCandidate({
            transportId: this.transportId,
            socketId: context.candidate.socketId,
            foundation: computeCandidateFoundation({ type: 'srflx', protocol: 'udp', ip: address.address }, context.candidate.baseAddress),
            component: 1,
            protocol: 'udp',
            priority: computeCandidatePriority({ type: 'srflx', component: 1 }),
            ip: address.address,
            port: address.port,
            type: 'srflx',
            relatedAddress: context.candidate.baseAddress,
            relatedPort: context.candidate.basePort,
            baseAddress: context.candidate.baseAddress,
            basePort: context.candidate.basePort
          });
        } catch (error) {
          this.emit('warning', error);
        }
      }
    }
  }

  private async gatherRelayCandidates(): Promise<void> {
    for (const serverOptions of this.options.turnServers ?? []) {
      const server = parseIceServerUrl(serverOptions.url, 'turn');
      if (!server || server.transport !== 'udp') {
        continue;
      }
      for (const context of [...this.sockets.values()]) {
        try {
          const allocation = await this.allocateTurnRelay(context, server, serverOptions);
          if (!allocation) {
            continue;
          }
          this.addLocalCandidate({
            transportId: this.transportId,
            socketId: context.candidate.socketId,
            foundation: computeCandidateFoundation({ type: 'relay', protocol: 'udp', ip: allocation.address.address }, context.candidate.baseAddress),
            component: 1,
            protocol: 'udp',
            priority: computeCandidatePriority({ type: 'relay', component: 1 }),
            ip: allocation.address.address,
            port: allocation.address.port,
            type: 'relay',
            relatedAddress: context.candidate.baseAddress,
            relatedPort: context.candidate.basePort,
            baseAddress: context.candidate.baseAddress,
            basePort: context.candidate.basePort,
            relay: allocation.relay
          });
        } catch (error) {
          this.emit('warning', error);
        }
      }
    }
  }

  private addLocalCandidate(candidate: LocalIceCandidate): void {
    if (this.localCandidates.some((existing) => existing.type === candidate.type && existing.ip === candidate.ip && existing.port === candidate.port && existing.component === candidate.component)) {
      return;
    }
    this.localCandidates.push(candidate);
    this.formCandidatePairs();
  }

  private async allocateTurnRelay(
    context: IceSocketContext,
    server: IceServerAddress,
    serverOptions: TurnServerOptions
  ): Promise<{ address: { address: string; port: number }; relay: TurnRelayAllocation } | undefined> {
    const unauthenticated = await this.sendServerRequest(context, server, STUN_ALLOCATE_REQUEST, [encodeRequestedTransport()]);
    let realm = serverOptions.realm ?? getAttribute(unauthenticated.message, StunAttributeType.REALM)?.toString('utf8') ?? '';
    let nonce = getAttribute(unauthenticated.message, StunAttributeType.NONCE)?.toString('utf8') ?? '';
    if (unauthenticated.message.type === STUN_ALLOCATE_SUCCESS_RESPONSE) {
      const relayed = getAttribute(unauthenticated.message, StunAttributeType.XOR_RELAYED_ADDRESS);
      if (!relayed) {
        return undefined;
      }
      const address = decodeXorMappedAddress(relayed, unauthenticated.message.transactionId);
      return {
        address,
        relay: {
          server: { host: server.host, port: server.port },
          username: serverOptions.username,
          credential: serverOptions.credential,
          realm,
          nonce,
          permissions: new Set<string>()
        }
      };
    }
    if (unauthenticated.message.type !== STUN_ALLOCATE_ERROR_RESPONSE || !realm || !nonce) {
      return undefined;
    }
    const key = turnLongTermKey(serverOptions.username, realm, serverOptions.credential);
    const authenticated = await this.sendServerRequest(
      context,
      server,
      STUN_ALLOCATE_REQUEST,
      [
        encodeRequestedTransport(),
        encodeStringAttribute(StunAttributeType.USERNAME, serverOptions.username),
        encodeStringAttribute(StunAttributeType.REALM, realm),
        encodeStringAttribute(StunAttributeType.NONCE, nonce)
      ],
      key
    );
    if (authenticated.message.type !== STUN_ALLOCATE_SUCCESS_RESPONSE) {
      return undefined;
    }
    const relayed = getAttribute(authenticated.message, StunAttributeType.XOR_RELAYED_ADDRESS);
    if (!relayed) {
      return undefined;
    }
    const address = decodeXorMappedAddress(relayed, authenticated.message.transactionId);
    const lifetime = readUInt32AttributeSafe(authenticated.message, StunAttributeType.LIFETIME);
    return {
      address,
      relay: {
        server: { host: server.host, port: server.port },
        username: serverOptions.username,
        credential: serverOptions.credential,
        realm,
        nonce,
        lifetimeSeconds: lifetime,
        permissions: new Set<string>()
      }
    };
  }

  private formCandidatePairs(): void {
    for (const local of this.localCandidates) {
      for (const remote of this.remoteCandidates.values()) {
        if (!isCompatiblePair(local, remote)) {
          continue;
        }
        const id = pairId(local, remote);
        if (!this.pairs.has(id)) {
          this.pairs.set(id, createCandidatePair(local, remote, this.role === 'controlling'));
        }
      }
    }
  }

  private scheduleNextCheck(delay = this.options.taMs ?? 50): void {
    this.stopCheckTimer();
    if (this.state === 'closed') {
      return;
    }
    if (this.state === 'completed' && !this.hasPendingConnectivityChecks()) {
      return;
    }
    this.checkTimer = setTimeout(() => {
      void this.performNextCheck();
    }, delay);
    this.checkTimer.unref?.();
  }

  private stopCheckTimer(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  private async performNextCheck(): Promise<void> {
    if (!this.remoteParameters) {
      return;
    }
    const pair = this.nextPairToCheck();
    if (!pair) {
      if ([...this.pairs.values()].some((candidatePair) => candidatePair.state === 'succeeded')) {
        this.setState(this.selectedPair ? 'completed' : 'connected');
      } else if ([...this.pairs.values()].every((candidatePair) => candidatePair.state === 'failed')) {
        this.setState('failed');
      }
      return;
    }
    pair.state = 'in-progress';
    try {
      await this.sendBindingRequest(pair, this.role === 'controlling', false);
    } catch {
      pair.state = 'failed';
      pair.failures += 1;
    }
    this.scheduleNextCheck();
  }

  private nextPairToCheck(): IceCandidatePair | undefined {
    return [...this.pairs.values()]
      .filter((pair) => pair.state === 'waiting')
      .sort((left, right) => (left.priority > right.priority ? -1 : left.priority < right.priority ? 1 : 0))[0];
  }

  private async sendBindingRequest(pair: IceCandidatePair, useCandidate: boolean, consent: boolean): Promise<void> {
    if (!this.remoteParameters) {
      throw new Error('Remote ICE parameters are required for connectivity checks');
    }
    const socketContext = this.sockets.get(pair.local.socketId);
    if (!socketContext) {
      throw new Error('Local ICE socket not found');
    }
    const transactionId = createTransactionId();
    const attributes = [
      encodeStringAttribute(StunAttributeType.USERNAME, `${this.remoteParameters.usernameFragment}:${this.localParameters.usernameFragment}`),
      encodeUInt32Attribute(StunAttributeType.PRIORITY, computeCandidatePriority({ type: 'prflx', component: pair.local.component })),
      encodeUInt64Attribute(this.role === 'controlling' ? StunAttributeType.ICE_CONTROLLING : StunAttributeType.ICE_CONTROLLED, this.tieBreaker)
    ];
    if (useCandidate) {
      attributes.push(encodeEmptyAttribute(StunAttributeType.USE_CANDIDATE));
    }
    const packet = encodeStunMessage({ type: STUN_BINDING_REQUEST, transactionId, attributes }, this.remoteParameters.password, true);
    const transactionIdHex = transactionId.toString('hex');
    const timeout = setTimeout(() => {
      this.transactions.delete(transactionIdHex);
      pair.state = 'failed';
      pair.failures += 1;
      if (consent && pair.failures >= (this.options.maxConsentFailures ?? 6)) {
        this.setState('disconnected');
      }
    }, this.options.transactionTimeoutMs ?? this.options.consentTimeoutMs ?? 5000);
    timeout.unref?.();
    this.transactions.set(transactionIdHex, {
      pair,
      transactionIdHex,
      useCandidate,
      sentAt: Date.now(),
      consent,
      timeout
    });
    pair.lastRequestAt = Date.now();
    if (pair.local.relay) {
      await this.sendViaTurnRelay(socketContext, pair, packet);
      return;
    }
    await sendUdp(socketContext.socket, packet, pair.remote.port, pair.remote.ip);
  }

  private async handleSocketMessage(socketId: string, message: Buffer, remote: RemoteInfo, relayIngress?: RelayIngressContext): Promise<void> {
    if (!isStunMessage(message)) {
      this.emit('data', { socketId, message, remote });
      return;
    }
    const stun = parseStunMessage(message);
    if (stun.type === STUN_DATA_INDICATION) {
      await this.handleTurnDataIndication(socketId, stun, remote);
      return;
    }
    const serverTransaction = this.serverTransactions.get(stun.transactionId.toString('hex'));
    if (serverTransaction) {
      clearTimeout(serverTransaction.timeout);
      this.serverTransactions.delete(stun.transactionId.toString('hex'));
      serverTransaction.resolve({ raw: message, message: stun, remote });
      return;
    }
    if (stun.type === STUN_BINDING_REQUEST) {
      await this.handleBindingRequest(socketId, message, stun, remote, relayIngress);
      return;
    }
    if (stun.type === STUN_BINDING_SUCCESS_RESPONSE) {
      this.handleBindingSuccess(message, stun);
    }
  }

  private async handleTurnDataIndication(socketId: string, indication: ReturnType<typeof parseStunMessage>, turnRemote: RemoteInfo): Promise<void> {
    const data = getAttribute(indication, StunAttributeType.DATA);
    const peer = getAttribute(indication, StunAttributeType.XOR_PEER_ADDRESS);
    if (!data || !peer) {
      return;
    }
    const peerAddress = decodeXorMappedAddress(peer, indication.transactionId);
    const remote: RemoteInfo = {
      address: peerAddress.address,
      port: peerAddress.port,
      family: peerAddress.family === 'IPv6' ? 'IPv6' : 'IPv4',
      size: data.length
    };
    const relayCandidate = this.relayCandidateForDataIndication(socketId, turnRemote);
    if (isStunMessage(data)) {
      await this.handleSocketMessage(socketId, data, remote, relayCandidate ? { localCandidate: relayCandidate } : undefined);
      return;
    }
    this.emit('data', { socketId, message: data, remote });
  }

  private async handleBindingRequest(socketId: string, raw: Buffer, request: ReturnType<typeof parseStunMessage>, remote: RemoteInfo, relayIngress?: RelayIngressContext): Promise<void> {
    const username = getUsername(request);
    if (!username?.startsWith(`${this.localParameters.usernameFragment}:`)) {
      return;
    }
    if (!verifyMessageIntegrity(raw, this.localParameters.password) || !verifyFingerprint(raw)) {
      return;
    }
    const socketContext = this.sockets.get(socketId);
    if (!socketContext) {
      return;
    }
    const localCandidate = relayIngress?.localCandidate ?? socketContext.candidate;
    const remoteCandidate = this.ensurePeerReflexiveCandidate(remote, readUInt32AttributeSafe(request, StunAttributeType.PRIORITY));
    const pair = this.ensurePair(localCandidate, remoteCandidate);
    pair.state = 'succeeded';
    pair.lastResponseAt = Date.now();
    pair.failures = 0;
    if (hasUseCandidate(request)) {
      pair.nominated = true;
      this.selectedPair = pair;
      this.setState('connected');
      this.startConsentFreshness();
    }
    const response = encodeStunMessage(
      {
        type: STUN_BINDING_SUCCESS_RESPONSE,
        transactionId: request.transactionId,
        attributes: [encodeXorMappedAddress({ family: remote.family === 'IPv6' ? 'IPv6' : 'IPv4', address: remote.address, port: remote.port }, request.transactionId)]
      },
      this.localParameters.password,
      true
    );
    if (localCandidate.relay) {
      await this.ensureTurnPermission(socketContext, localCandidate.relay, remoteCandidate);
      await this.sendTurnIndication(socketContext, localCandidate.relay, remoteCandidate, response);
    } else {
      await sendUdp(socketContext.socket, response, remote.port, remote.address);
    }
    this.queueTriggeredConnectivityCheck(pair, hasUseCandidate(request));
  }

  private handleBindingSuccess(raw: Buffer, response: ReturnType<typeof parseStunMessage>): void {
    const transaction = this.transactions.get(response.transactionId.toString('hex'));
    if (!transaction || !this.remoteParameters) {
      return;
    }
    if (!verifyMessageIntegrity(raw, this.remoteParameters.password) || !verifyFingerprint(raw)) {
      return;
    }
    clearTimeout(transaction.timeout);
    this.transactions.delete(transaction.transactionIdHex);
    const mapped = getAttribute(response, StunAttributeType.XOR_MAPPED_ADDRESS);
    if (mapped) {
      decodeXorMappedAddress(mapped, response.transactionId);
    }
    transaction.pair.state = 'succeeded';
    transaction.pair.failures = 0;
    transaction.pair.lastResponseAt = Date.now();
    if (transaction.useCandidate || transaction.consent) {
      transaction.pair.nominated = true;
      this.selectedPair = transaction.pair;
      this.setState(transaction.consent ? this.state : 'connected');
      this.startConsentFreshness();
    }
  }

  private async sendServerRequest(
    context: IceSocketContext,
    server: IceServerAddress,
    type: number,
    attributes: StunAttribute[],
    integrityKey?: Buffer
  ): Promise<StunServerResponse> {
    const transactionId = createTransactionId();
    const packet = encodeStunMessage({ type, transactionId, attributes }, integrityKey, true);
    const transactionIdHex = transactionId.toString('hex');
    const timeoutMs = this.options.transactionTimeoutMs ?? 5000;
    const response = new Promise<StunServerResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.serverTransactions.delete(transactionIdHex);
        reject(new Error(`Timed out waiting for STUN/TURN response from ${server.host}:${server.port}`));
      }, timeoutMs);
      timeout.unref?.();
      this.serverTransactions.set(transactionIdHex, { timeout, resolve, reject });
    });
    await sendUdp(context.socket, packet, server.port, server.host);
    return response;
  }

  private async sendViaTurnRelay(context: IceSocketContext, pair: IceCandidatePair, packet: Buffer): Promise<void> {
    const relay = pair.local.relay;
    if (!relay) {
      throw new Error('TURN relay allocation is required for relay candidate send');
    }
    await this.ensureTurnPermission(context, relay, pair.remote);
    await this.sendTurnIndication(context, relay, pair.remote, packet);
  }

  private async sendTurnIndication(context: IceSocketContext, relay: TurnRelayAllocation, remote: Pick<RemoteIceCandidate, 'ip' | 'port'>, packet: Buffer): Promise<void> {
    const transactionId = createTransactionId();
    const indication = encodeStunMessage(
      {
        type: STUN_SEND_INDICATION,
        transactionId,
        attributes: [
          encodeXorPeerAddress({ family: 'IPv4', address: remote.ip, port: remote.port }, transactionId),
          encodeDataAttribute(packet)
        ]
      },
      undefined,
      true
    );
    await sendUdp(context.socket, indication, relay.server.port, relay.server.host);
  }

  private relayCandidateForDataIndication(socketId: string, turnRemote: RemoteInfo): LocalIceCandidate | undefined {
    const relays = this.localCandidates.filter((candidate) => candidate.relay);
    const sameSocketRelays = relays.filter((candidate) => candidate.socketId === socketId);
    const sameServer = (candidate: LocalIceCandidate): boolean => candidate.relay?.server.port === turnRemote.port && candidate.relay.server.host === turnRemote.address;
    return sameSocketRelays.find(sameServer) ?? sameSocketRelays[0] ?? relays.find(sameServer) ?? relays[0];
  }

  private async ensureTurnPermission(context: IceSocketContext, relay: TurnRelayAllocation, remote: RemoteIceCandidate): Promise<void> {
    const permissionKey = `${remote.ip}:${remote.port}`;
    if (relay.permissions.has(permissionKey)) {
      return;
    }
    const transactionId = createTransactionId();
    const attributes = [
      encodeStringAttribute(StunAttributeType.USERNAME, relay.username),
      encodeStringAttribute(StunAttributeType.REALM, relay.realm),
      encodeStringAttribute(StunAttributeType.NONCE, relay.nonce),
      encodeXorPeerAddress({ family: 'IPv4', address: remote.ip, port: remote.port }, transactionId)
    ];
    const key = turnLongTermKey(relay.username, relay.realm, relay.credential);
    const packet = encodeStunMessage({ type: STUN_CREATE_PERMISSION_REQUEST, transactionId, attributes }, key, true);
    const transactionIdHex = transactionId.toString('hex');
    const timeoutMs = this.options.transactionTimeoutMs ?? 5000;
    const response = new Promise<StunServerResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.serverTransactions.delete(transactionIdHex);
        reject(new Error(`Timed out waiting for TURN permission response from ${relay.server.host}:${relay.server.port}`));
      }, timeoutMs);
      timeout.unref?.();
      this.serverTransactions.set(transactionIdHex, { timeout, resolve, reject });
    });
    await sendUdp(context.socket, packet, relay.server.port, relay.server.host);
    const result = await response;
    if (result.message.type === STUN_CREATE_PERMISSION_SUCCESS_RESPONSE) {
      relay.permissions.add(permissionKey);
    }
  }

  private ensurePeerReflexiveCandidate(remote: RemoteInfo, priority?: number): RemoteIceCandidate {
    const candidate: RemoteIceCandidate = {
      transportId: this.transportId,
      foundation: computeCandidateFoundation({ type: 'prflx', protocol: 'udp', ip: remote.address }),
      component: 1,
      protocol: 'udp',
      priority: priority ?? computeCandidatePriority({ type: 'prflx', component: 1 }),
      ip: remote.address,
      port: remote.port,
      type: 'prflx'
    };
    const key = remoteCandidateKey(candidate);
    const existing = this.remoteCandidates.get(key);
    if (existing) {
      return existing;
    }
    this.remoteCandidates.set(key, candidate);
    return candidate;
  }

  private ensurePair(local: LocalIceCandidate, remote: RemoteIceCandidate): IceCandidatePair {
    const id = pairId(local, remote);
    const existing = this.pairs.get(id);
    if (existing) {
      return existing;
    }
    const pair = createCandidatePair(local, remote, this.role === 'controlling');
    this.pairs.set(id, pair);
    return pair;
  }

  private hasPendingConnectivityChecks(): boolean {
    return [...this.pairs.values()].some((pair) => pair.state === 'waiting');
  }

  private queueTriggeredConnectivityCheck(pair: IceCandidatePair, requestHadUseCandidate: boolean): void {
    if (!this.shouldTriggerConnectivityCheck(pair, requestHadUseCandidate)) {
      return;
    }
    pair.state = 'waiting';
    this.scheduleNextCheck(0);
  }

  private shouldTriggerConnectivityCheck(pair: IceCandidatePair, requestHadUseCandidate: boolean): boolean {
    return this.role === 'controlling'
      && Boolean(this.remoteParameters)
      && !requestHadUseCandidate
      && pair.state !== 'in-progress'
      && this.selectedPair?.id !== pair.id;
  }

  private setState(state: IceAgentState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.emit('stateChange', state);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('ICE agent is closed');
    }
  }
}

function randomTieBreaker(): bigint {
  return randomBytes(8).readBigUInt64BE(0);
}

interface IceServerAddress {
  scheme: 'stun' | 'turn';
  host: string;
  port: number;
  transport: 'udp' | 'tcp';
}

function parseIceServerUrl(url: string, expectedScheme: 'stun' | 'turn'): IceServerAddress | undefined {
  const trimmed = url.trim();
  const match = trimmed.match(/^(stun|stuns|turn|turns):(.+)$/i);
  if (!match) {
    return undefined;
  }
  const scheme = match[1]!.toLowerCase().replace(/s$/, '') as 'stun' | 'turn';
  if (scheme !== expectedScheme) {
    return undefined;
  }
  const rest = match[2]!.replace(/^\/\//, '');
  const [authority, query = ''] = rest.split('?');
  const transport = query
    .split('&')
    .map((part) => part.split('='))
    .find(([key]) => key?.toLowerCase() === 'transport')?.[1]?.toLowerCase();
  const hostPort = authority ?? '';
  const lastColon = hostPort.lastIndexOf(':');
  const defaultPort = scheme === 'turn' ? 3478 : 3478;
  const host = lastColon > 0 ? hostPort.slice(0, lastColon) : hostPort;
  const port = lastColon > 0 ? Number(hostPort.slice(lastColon + 1)) : defaultPort;
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return {
    scheme,
    host,
    port,
    transport: transport === 'tcp' ? 'tcp' : 'udp'
  };
}

function turnLongTermKey(username: string, realm: string, credential: string): Buffer {
  return createHash('md5').update(`${username}:${realm}:${credential}`).digest();
}

function gatherInterfaceAddresses(includeLoopback: boolean, allowList?: string[]): string[] {
  const addresses = new Set<string>();
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    if (allowList && !allowList.includes(name)) {
      continue;
    }
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4') {
        continue;
      }
      if (info.internal && !includeLoopback) {
        continue;
      }
      addresses.add(info.address);
    }
  }
  if (addresses.size === 0 && includeLoopback) {
    addresses.add('127.0.0.1');
  }
  return [...addresses];
}

function validateRemoteCandidate(candidate: IceCandidate): void {
  if (!candidate.ip || candidate.port <= 0 || candidate.port > 65535) {
    throw new Error('Invalid ICE candidate address');
  }
  if (!['host', 'srflx', 'prflx', 'relay'].includes(candidate.type)) {
    throw new Error('Invalid ICE candidate type');
  }
  if (candidate.protocol !== 'udp') {
    throw new Error('Only UDP ICE candidates are currently supported');
  }
}

function remoteCandidateKey(candidate: Pick<RemoteIceCandidate, 'ip' | 'port' | 'component' | 'protocol'>): string {
  return `${candidate.protocol}:${candidate.ip}:${candidate.port}:${candidate.component}`;
}

function readUInt32AttributeSafe(message: ReturnType<typeof parseStunMessage>, type: StunAttributeType): number | undefined {
  const attribute = getAttribute(message, type);
  return attribute && attribute.length >= 4 ? attribute.readUInt32BE(0) : undefined;
}

function sendUdp(socket: Socket, packet: Buffer, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, port, address, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
