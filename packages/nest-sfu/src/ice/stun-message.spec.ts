import {
  createTransactionId,
  encodeStunMessage,
  encodeStringAttribute,
  encodeUInt32Attribute,
  getUsername,
  parseStunMessage,
  STUN_BINDING_REQUEST,
  StunAttributeType,
  verifyFingerprint,
  verifyMessageIntegrity
} from './stun-message';

describe('STUN message codec', () => {
  it('encodes and verifies ICE binding requests', () => {
    const transactionId = createTransactionId();
    const packet = encodeStunMessage(
      {
        type: STUN_BINDING_REQUEST,
        transactionId,
        attributes: [
          encodeStringAttribute(StunAttributeType.USERNAME, 'remote:local'),
          encodeUInt32Attribute(StunAttributeType.PRIORITY, 1234)
        ]
      },
      'remote-password',
      true
    );

    const parsed = parseStunMessage(packet);

    expect(parsed.type).toBe(STUN_BINDING_REQUEST);
    expect(parsed.transactionId.equals(transactionId)).toBe(true);
    expect(getUsername(parsed)).toBe('remote:local');
    expect(verifyMessageIntegrity(packet, 'remote-password')).toBe(true);
    expect(verifyMessageIntegrity(packet, 'wrong-password')).toBe(false);
    expect(verifyFingerprint(packet)).toBe(true);
  });
});
