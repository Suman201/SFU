import dgram, { RemoteInfo, Socket } from 'dgram';
import {
  createTransactionId,
  decodeXorMappedAddress,
  encodeDataAttribute,
  encodeEmptyAttribute,
  encodeStunMessage,
  encodeStringAttribute,
  encodeUInt32Attribute,
  encodeXorMappedAddress,
  encodeXorPeerAddress,
  getAttribute,
  parseStunMessage,
  STUN_ALLOCATE_ERROR_RESPONSE,
  STUN_ALLOCATE_REQUEST,
  STUN_ALLOCATE_SUCCESS_RESPONSE,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS_RESPONSE,
  STUN_CREATE_PERMISSION_REQUEST,
  STUN_CREATE_PERMISSION_SUCCESS_RESPONSE,
  STUN_DATA_INDICATION,
  STUN_SEND_INDICATION,
  StunAttributeType
} from './stun-message';
import { IceAgent } from './ice-agent';

describe('ICE server candidate gathering', () => {
  it('gathers server reflexive candidates from a STUN server', async () => {
    const server = await createStunServer((request, remote, socket) => {
      if (request.type !== STUN_BINDING_REQUEST) {
        return;
      }
      const response = encodeStunMessage({
        type: STUN_BINDING_SUCCESS_RESPONSE,
        transactionId: request.transactionId,
        attributes: [encodeXorMappedAddress({ family: remote.family === 'IPv6' ? 'IPv6' : 'IPv4', address: remote.address, port: remote.port }, request.transactionId)]
      });
      socket.send(response, remote.port, remote.address);
    });
    const agent = new IceAgent({
      transportId: 'srflx-agent',
      roomId: 'room-1',
      participantId: 'participant-1',
      includeLoopbackCandidates: true,
      stunServers: [`stun:127.0.0.1:${server.port}`],
      transactionTimeoutMs: 500
    });

    try {
      const candidates = await agent.gatherCandidates();
      const srflx = candidates.find((candidate) => candidate.type === 'srflx');

      expect(srflx).toBeTruthy();
      expect(srflx?.relatedAddress).toBe('127.0.0.1');
      expect(srflx?.relatedPort).toBeGreaterThan(0);
      expect(srflx!.priority).toBeLessThan(candidates.find((candidate) => candidate.type === 'host')!.priority);
    } finally {
      agent.close();
      server.close();
    }
  });

  it('gathers relay candidates from a TURN allocation', async () => {
    const server = await createStunServer((request, remote, socket) => {
      if (request.type !== STUN_ALLOCATE_REQUEST) {
        return;
      }
      const username = request.attributes.find((attribute) => attribute.type === StunAttributeType.USERNAME);
      if (!username) {
        const response = encodeStunMessage({
          type: STUN_ALLOCATE_ERROR_RESPONSE,
          transactionId: request.transactionId,
          attributes: [
            encodeStringAttribute(StunAttributeType.REALM, 'test.local'),
            encodeStringAttribute(StunAttributeType.NONCE, 'nonce-1')
          ]
        });
        socket.send(response, remote.port, remote.address);
        return;
      }
      const relayed = encodeXorMappedAddress({ family: 'IPv4', address: '203.0.113.10', port: 55000 }, request.transactionId);
      relayed.type = StunAttributeType.XOR_RELAYED_ADDRESS;
      const response = encodeStunMessage({
        type: STUN_ALLOCATE_SUCCESS_RESPONSE,
        transactionId: request.transactionId,
        attributes: [relayed, encodeUInt32Attribute(StunAttributeType.LIFETIME, 600)]
      });
      socket.send(response, remote.port, remote.address);
    });
    const agent = new IceAgent({
      transportId: 'relay-agent',
      roomId: 'room-1',
      participantId: 'participant-1',
      includeLoopbackCandidates: true,
      turnServers: [{ url: `turn:127.0.0.1:${server.port}?transport=udp`, username: 'turn-user', credential: 'turn-pass' }],
      transactionTimeoutMs: 500
    });

    try {
      const candidates = await agent.gatherCandidates();
      const relay = candidates.find((candidate) => candidate.type === 'relay');

      expect(relay).toBeTruthy();
      expect(relay?.ip).toBe('203.0.113.10');
      expect(relay?.port).toBe(55000);
      expect(relay?.relatedAddress).toBe('127.0.0.1');
      expect(relay!.priority).toBeLessThan(candidates.find((candidate) => candidate.type === 'host')!.priority);
    } finally {
      agent.close();
      server.close();
    }
  });

  it('uses the relay candidate for ICE checks received through TURN data indications', async () => {
    let clientRemote: RemoteInfo | undefined;
    const sendIndications: ReturnType<typeof parseStunMessage>[] = [];
    const server = await createStunServer((request, remote, socket) => {
      if (request.type === STUN_ALLOCATE_REQUEST) {
        clientRemote = remote;
        const username = request.attributes.find((attribute) => attribute.type === StunAttributeType.USERNAME);
        if (!username) {
          const response = encodeStunMessage({
            type: STUN_ALLOCATE_ERROR_RESPONSE,
            transactionId: request.transactionId,
            attributes: [
              encodeStringAttribute(StunAttributeType.REALM, 'test.local'),
              encodeStringAttribute(StunAttributeType.NONCE, 'nonce-1')
            ]
          });
          socket.send(response, remote.port, remote.address);
          return;
        }
        const relayed = encodeXorMappedAddress({ family: 'IPv4', address: '203.0.113.11', port: 55001 }, request.transactionId);
        relayed.type = StunAttributeType.XOR_RELAYED_ADDRESS;
        const response = encodeStunMessage({
          type: STUN_ALLOCATE_SUCCESS_RESPONSE,
          transactionId: request.transactionId,
          attributes: [relayed, encodeUInt32Attribute(StunAttributeType.LIFETIME, 600)]
        });
        socket.send(response, remote.port, remote.address);
        return;
      }
      if (request.type === STUN_CREATE_PERMISSION_REQUEST) {
        const response = encodeStunMessage({
          type: STUN_CREATE_PERMISSION_SUCCESS_RESPONSE,
          transactionId: request.transactionId,
          attributes: []
        });
        socket.send(response, remote.port, remote.address);
        return;
      }
      if (request.type === STUN_SEND_INDICATION) {
        sendIndications.push(request);
      }
    });
    const agent = new IceAgent({
      transportId: 'relay-selected-agent',
      roomId: 'room-1',
      participantId: 'participant-1',
      includeLoopbackCandidates: true,
      turnServers: [{ url: `turn:127.0.0.1:${server.port}?transport=udp`, username: 'turn-user', credential: 'turn-pass' }],
      transactionTimeoutMs: 500
    });

    try {
      await agent.gatherCandidates();
      expect(agent.snapshot().localCandidates.some((candidate) => candidate.type === 'relay')).toBe(true);
      expect(clientRemote).toBeDefined();

      const connected = onceState(agent, 'connected');
      const requestTransactionId = createTransactionId();
      const bindingRequest = encodeStunMessage(
        {
          type: STUN_BINDING_REQUEST,
          transactionId: requestTransactionId,
          attributes: [
            encodeStringAttribute(StunAttributeType.USERNAME, `${agent.localParameters.usernameFragment}:remoteUfrag`),
            encodeUInt32Attribute(StunAttributeType.PRIORITY, 1862270975),
            encodeEmptyAttribute(StunAttributeType.USE_CANDIDATE)
          ]
        },
        agent.localParameters.password,
        true
      );
      const dataTransactionId = createTransactionId();
      const dataIndication = encodeStunMessage({
        type: STUN_DATA_INDICATION,
        transactionId: dataTransactionId,
        attributes: [
          encodeXorPeerAddress({ family: 'IPv4', address: '198.51.100.20', port: 49000 }, dataTransactionId),
          encodeDataAttribute(bindingRequest)
        ]
      });
      server.send(dataIndication, clientRemote!.port, clientRemote!.address);

      await connected;
      expect(agent.selectedCandidatePair()?.local.type).toBe('relay');
      await waitFor(() => sendIndications.length > 0);

      const selected = agent.selectedCandidatePair();
      expect(selected?.remote.ip).toBe('198.51.100.20');
      const responseData = getAttribute(sendIndications[0]!, StunAttributeType.DATA);
      expect(responseData).toBeDefined();
      expect(parseStunMessage(responseData!).type).toBe(STUN_BINDING_SUCCESS_RESPONSE);
    } finally {
      agent.close();
      server.close();
    }
  });
});

async function createStunServer(handler: (request: ReturnType<typeof parseStunMessage>, remote: RemoteInfo, socket: Socket) => void): Promise<{ port: number; send: (message: Buffer, port: number, address: string) => void; close: () => void }> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, remote) => {
    const request = parseStunMessage(message);
    const mapped = request.attributes.find((attribute) => attribute.type === StunAttributeType.XOR_MAPPED_ADDRESS);
    if (mapped) {
      decodeXorMappedAddress(mapped.value, request.transactionId);
    }
    handler(request, remote, socket);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('listening', () => resolve());
    socket.bind(0, '127.0.0.1');
  });
  const address = socket.address();
  if (typeof address === 'string') {
    throw new Error('Unexpected unix socket address');
  }
  return {
    port: address.port,
    send: (message: Buffer, port: number, remoteAddress: string) => socket.send(message, port, remoteAddress),
    close: () => socket.close()
  };
}

function onceState(agent: IceAgent, state: string): Promise<void> {
  if (agent.snapshot().state === state) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const listener = (nextState: string) => {
      if (nextState === state) {
        agent.off('stateChange', listener);
        resolve();
      }
    };
    agent.on('stateChange', listener);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
