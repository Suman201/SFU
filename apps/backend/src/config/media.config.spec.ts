import { buildIceTurnServers, isSupportedStunUri, isSupportedTurnUri, parseIceServerUrl, resolveAnnouncedAddress } from './media.config';

describe('media.config helpers', () => {
  it('parses ICE server URLs with explicit transport details', () => {
    expect(parseIceServerUrl('stun:stun.example.com:3478')).toEqual({
      scheme: 'stun',
      secure: false,
      host: 'stun.example.com',
      port: 3478,
      transport: 'udp',
      explicitTransport: false
    });
    expect(parseIceServerUrl('turn:turn.example.com:3478?transport=udp')).toEqual({
      scheme: 'turn',
      secure: false,
      host: 'turn.example.com',
      port: 3478,
      transport: 'udp',
      explicitTransport: true
    });
  });

  it('distinguishes supported STUN and TURN transports', () => {
    expect(isSupportedStunUri('stun:stun.example.com:3478')).toBe(true);
    expect(isSupportedStunUri('stuns:stun.example.com:5349')).toBe(false);
    expect(isSupportedTurnUri('turn:turn.example.com:3478?transport=udp')).toBe(true);
    expect(isSupportedTurnUri('turns:turn.example.com:5349?transport=tcp')).toBe(false);
  });

  it('builds shared-secret TURN server credentials for the media plane', () => {
    const servers = buildIceTurnServers(['turn:turn.example.com:3478?transport=udp'], {
      turnSecret: 'turn-secret-valid-length-32chars',
      turnRealm: 'native-sfu.local',
      usernameSubject: 'node-a',
      now: () => 1_700_000_000_000
    });

    expect(servers.length).toBe(1);
    expect(servers[0]?.url).toBe('turn:turn.example.com:3478?transport=udp');
    expect(servers[0]?.realm).toBe('native-sfu.local');
    expect(servers[0]?.username).toContain(':node-a');
    expect(servers[0]?.credential).toBeTruthy();
  });

  it('resolves the announced-address alias consistently', () => {
    expect(resolveAnnouncedAddress('203.0.113.10', '203.0.113.20')).toBe('203.0.113.10');
    expect(resolveAnnouncedAddress('', '203.0.113.20')).toBe('203.0.113.20');
    expect(resolveAnnouncedAddress(undefined, undefined)).toBeUndefined();
  });
});
