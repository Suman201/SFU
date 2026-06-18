import dgram, { type Socket } from 'dgram';
import { IceAgent } from './ice-agent';
import { computeCandidatePriority } from './candidate';
import {
  createTransactionId,
  encodeEmptyAttribute,
  encodeStunMessage,
  encodeStringAttribute,
  encodeUInt32Attribute,
  encodeUInt64Attribute,
  encodeXorMappedAddress,
  hasUseCandidate,
  isStunMessage,
  parseStunMessage,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS_RESPONSE,
  StunAttributeType
} from './stun-message';

describe('IceAgent integration', () => {
  jest.setTimeout(10_000);

  it('connects two RFC 8445 full agents over localhost and refreshes consent', async () => {
    const controlling = new IceAgent({
      transportId: 'a',
      roomId: 'room',
      participantId: 'alice',
      role: 'controlling',
      includeLoopbackCandidates: true,
      consentIntervalMs: 1000,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });
    const controlled = new IceAgent({
      transportId: 'b',
      roomId: 'room',
      participantId: 'bob',
      role: 'controlled',
      includeLoopbackCandidates: true,
      consentIntervalMs: 1000,
      transactionTimeoutMs: 500,
      maxConsentFailures: 2,
      taMs: 10
    });

    try {
      const [controllingCandidates, controlledCandidates] = await Promise.all([controlling.gatherCandidates(), controlled.gatherCandidates()]);

      controlling.setRemoteParameters(controlled.localParameters);
      controlled.setRemoteParameters(controlling.localParameters);
      controlledCandidates.forEach((candidate) => controlling.addRemoteCandidate(candidate));
      controllingCandidates.forEach((candidate) => controlled.addRemoteCandidate(candidate));

      controlling.startConnectivityChecks();
      controlled.startConnectivityChecks();

      await waitFor(() => controlling.snapshot().state === 'connected' || controlling.snapshot().state === 'completed');
      await waitFor(() => controlled.snapshot().state === 'connected' || controlled.snapshot().state === 'completed');

      expect(controlling.selectedCandidatePair()).toBeDefined();
      expect(controlled.selectedCandidatePair()).toBeDefined();
      const consentRefreshed = await controlling.refreshConsentOnce();
      expect(consentRefreshed).toBe(true);
    } finally {
      controlling.close();
      controlled.close();
    }
  });

  it('accepts aggressive nomination on the controlled side', async () => {
    const controlled = new IceAgent({
      transportId: 'controlled',
      roomId: 'room',
      participantId: 'bob',
      role: 'controlled',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500
    });
    const socket = dgram.createSocket('udp4');

    try {
      const [candidate] = await controlled.gatherCandidates();
      expect(candidate).toBeDefined();
      const selectedCandidate = candidate!;
      await bindSocket(socket);
      const local = socket.address();
      if (typeof local === 'string') {
        throw new Error('Expected UDP socket address');
      }

      const request = encodeStunMessage(
        {
          type: STUN_BINDING_REQUEST,
          transactionId: createTransactionId(),
          attributes: [
            encodeStringAttribute(StunAttributeType.USERNAME, `${controlled.localParameters.usernameFragment}:remote-peer`),
            encodeUInt32Attribute(StunAttributeType.PRIORITY, computeCandidatePriority({ type: 'prflx', component: 1 })),
            encodeUInt64Attribute(StunAttributeType.ICE_CONTROLLING, 1n),
            encodeEmptyAttribute(StunAttributeType.USE_CANDIDATE)
          ]
        },
        controlled.localParameters.password,
        true
      );

      await sendUdp(socket, request, selectedCandidate.port, selectedCandidate.ip);

      await waitFor(() => controlled.snapshot().selectedPair?.remote.port === local.port);

      expect(controlled.snapshot().state).toBe('connected');
      const selected = controlled.selectedCandidatePair();
      expect(selected).toBeDefined();
      expect(selected?.nominated).toBe(true);
      expect(selected?.remote.type).toBe('prflx');
      expect(selected?.remote.port).toBe(local.port);
    } finally {
      socket.close();
      controlled.close();
    }
  });

  it('re-nominates a newly discovered tuple after selected pair switching', async () => {
    const controlling = new IceAgent({
      transportId: 'a',
      roomId: 'room',
      participantId: 'alice',
      role: 'controlling',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      taMs: 10
    });
    const controlled = new IceAgent({
      transportId: 'b',
      roomId: 'room',
      participantId: 'bob',
      role: 'controlled',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      taMs: 10
    });
    const migratedSocket = dgram.createSocket('udp4');
    let sawTriggeredNomination = false;

    try {
      const [controllingCandidates, controlledCandidates] = await Promise.all([controlling.gatherCandidates(), controlled.gatherCandidates()]);

      controlling.setRemoteParameters(controlled.localParameters);
      controlled.setRemoteParameters(controlling.localParameters);
      controlledCandidates.forEach((candidate) => controlling.addRemoteCandidate(candidate));
      controllingCandidates.forEach((candidate) => controlled.addRemoteCandidate(candidate));

      controlling.startConnectivityChecks();
      controlled.startConnectivityChecks();

      await waitFor(() => controlling.snapshot().state === 'connected' || controlling.snapshot().state === 'completed');
      await waitFor(() => controlled.snapshot().state === 'connected' || controlled.snapshot().state === 'completed');

      const beforeSwitch = controlling.selectedCandidatePair();
      expect(beforeSwitch).toBeDefined();

      await bindSocket(migratedSocket);
      const migratedAddress = migratedSocket.address();
      if (typeof migratedAddress === 'string') {
        throw new Error('Expected migrated UDP socket address');
      }

      migratedSocket.on('message', (message, remote) => {
        if (!isStunMessage(message)) {
          return;
        }
        const stun = parseStunMessage(message);
        if (stun.type !== STUN_BINDING_REQUEST) {
          return;
        }
        sawTriggeredNomination = hasUseCandidate(stun);
        const response = encodeStunMessage(
          {
            type: STUN_BINDING_SUCCESS_RESPONSE,
            transactionId: stun.transactionId,
            attributes: [
              encodeXorMappedAddress(
                {
                  family: remote.family === 'IPv6' ? 'IPv6' : 'IPv4',
                  address: remote.address,
                  port: remote.port
                },
                stun.transactionId
              )
            ]
          },
          controlled.localParameters.password,
          true
        );
        void sendUdp(migratedSocket, response, remote.port, remote.address);
      });

      const switchRequest = encodeStunMessage(
        {
          type: STUN_BINDING_REQUEST,
          transactionId: createTransactionId(),
          attributes: [
            encodeStringAttribute(
              StunAttributeType.USERNAME,
              `${controlling.localParameters.usernameFragment}:${controlled.localParameters.usernameFragment}`
            ),
            encodeUInt32Attribute(StunAttributeType.PRIORITY, computeCandidatePriority({ type: 'prflx', component: 1 })),
            encodeUInt64Attribute(StunAttributeType.ICE_CONTROLLED, controlled.tieBreaker)
          ]
        },
        controlling.localParameters.password,
        true
      );

      await sendUdp(migratedSocket, switchRequest, beforeSwitch!.local.port, beforeSwitch!.local.ip);

      await waitFor(() => {
        const selected = controlling.selectedCandidatePair();
        return Boolean(
          sawTriggeredNomination
            && selected
            && selected.remote.port === migratedAddress.port
            && selected.remote.type === 'prflx'
        );
      });

      const afterSwitch = controlling.selectedCandidatePair();
      expect(afterSwitch).toBeDefined();
      expect(afterSwitch?.remote.port).toBe(migratedAddress.port);
      expect(afterSwitch?.remote.type).toBe('prflx');
      expect(afterSwitch?.nominated).toBe(true);
      expect(afterSwitch?.id).not.toBe(beforeSwitch?.id);
    } finally {
      migratedSocket.close();
      controlling.close();
      controlled.close();
    }
  });

  it('reconnects after an ICE restart with fresh credentials', async () => {
    const controlling = new IceAgent({
      transportId: 'a',
      roomId: 'room',
      participantId: 'alice',
      role: 'controlling',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      taMs: 10
    });
    const controlled = new IceAgent({
      transportId: 'b',
      roomId: 'room',
      participantId: 'bob',
      role: 'controlled',
      includeLoopbackCandidates: true,
      transactionTimeoutMs: 500,
      taMs: 10
    });

    try {
      const [controllingCandidates, controlledCandidates] = await Promise.all([controlling.gatherCandidates(), controlled.gatherCandidates()]);
      const initialControllingUfrag = controlling.localParameters.usernameFragment;
      const initialControlledUfrag = controlled.localParameters.usernameFragment;

      controlling.setRemoteParameters(controlled.localParameters);
      controlled.setRemoteParameters(controlling.localParameters);
      controlledCandidates.forEach((candidate) => controlling.addRemoteCandidate(candidate));
      controllingCandidates.forEach((candidate) => controlled.addRemoteCandidate(candidate));
      controlling.startConnectivityChecks();
      controlled.startConnectivityChecks();

      await waitFor(() => controlling.snapshot().state === 'connected' || controlling.snapshot().state === 'completed');
      await waitFor(() => controlled.snapshot().state === 'connected' || controlled.snapshot().state === 'completed');

      await Promise.all([controlling.restart(), controlled.restart()]);

      expect(controlling.localParameters.usernameFragment).not.toBe(initialControllingUfrag);
      expect(controlled.localParameters.usernameFragment).not.toBe(initialControlledUfrag);
      expect(controlling.selectedCandidatePair()).toBeUndefined();
      expect(controlled.selectedCandidatePair()).toBeUndefined();

      controlling.setRemoteParameters(controlled.localParameters);
      controlled.setRemoteParameters(controlling.localParameters);
      controlledCandidates.forEach((candidate) => controlling.addRemoteCandidate(candidate));
      controllingCandidates.forEach((candidate) => controlled.addRemoteCandidate(candidate));
      controlling.startConnectivityChecks();
      controlled.startConnectivityChecks();

      await waitFor(() => controlling.snapshot().state === 'connected' || controlling.snapshot().state === 'completed');
      await waitFor(() => controlled.snapshot().state === 'connected' || controlled.snapshot().state === 'completed');

      expect(controlling.selectedCandidatePair()).toBeDefined();
      expect(controlled.selectedCandidatePair()).toBeDefined();
    } finally {
      controlling.close();
      controlled.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for ICE state');
}

async function bindSocket(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

async function sendUdp(socket: Socket, packet: Buffer, port: number, address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(packet, port, address, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
