import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { crc32 } from './crc32';

export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_SUCCESS_RESPONSE = 0x0101;
export const STUN_BINDING_ERROR_RESPONSE = 0x0111;
export const STUN_ALLOCATE_REQUEST = 0x0003;
export const STUN_ALLOCATE_SUCCESS_RESPONSE = 0x0103;
export const STUN_ALLOCATE_ERROR_RESPONSE = 0x0113;
export const STUN_CREATE_PERMISSION_REQUEST = 0x0008;
export const STUN_CREATE_PERMISSION_SUCCESS_RESPONSE = 0x0108;
export const STUN_CREATE_PERMISSION_ERROR_RESPONSE = 0x0118;
export const STUN_SEND_INDICATION = 0x0016;
export const STUN_DATA_INDICATION = 0x0017;
export const STUN_MAGIC_COOKIE = 0x2112a442;

export const enum StunAttributeType {
  USERNAME = 0x0006,
  MESSAGE_INTEGRITY = 0x0008,
  LIFETIME = 0x000d,
  ERROR_CODE = 0x0009,
  XOR_PEER_ADDRESS = 0x0012,
  DATA = 0x0013,
  REALM = 0x0014,
  NONCE = 0x0015,
  XOR_RELAYED_ADDRESS = 0x0016,
  REQUESTED_TRANSPORT = 0x0019,
  XOR_MAPPED_ADDRESS = 0x0020,
  PRIORITY = 0x0024,
  USE_CANDIDATE = 0x0025,
  FINGERPRINT = 0x8028,
  ICE_CONTROLLED = 0x8029,
  ICE_CONTROLLING = 0x802a
}

export interface StunAttribute {
  type: number;
  value: Buffer;
}

export interface StunMessage {
  type: number;
  transactionId: Buffer;
  attributes: StunAttribute[];
}

export interface StunAddress {
  family: 'IPv4' | 'IPv6';
  address: string;
  port: number;
}

export function createTransactionId(): Buffer {
  return randomBytes(12);
}

export function isStunMessage(buffer: Buffer): boolean {
  return buffer.length >= 20 && (buffer[0]! & 0xc0) === 0 && buffer.readUInt32BE(4) === STUN_MAGIC_COOKIE;
}

export function parseStunMessage(buffer: Buffer): StunMessage {
  if (!isStunMessage(buffer)) {
    throw new Error('Invalid STUN message header');
  }
  const length = buffer.readUInt16BE(2);
  if (buffer.length < 20 + length) {
    throw new Error('Truncated STUN message');
  }
  const attributes: StunAttribute[] = [];
  let offset = 20;
  const end = 20 + length;
  while (offset + 4 <= end) {
    const type = buffer.readUInt16BE(offset);
    const attributeLength = buffer.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + attributeLength;
    if (valueEnd > end) {
      throw new Error('Truncated STUN attribute');
    }
    attributes.push({ type, value: buffer.subarray(valueStart, valueEnd) });
    offset = valueEnd + paddingLength(attributeLength);
  }
  return {
    type: buffer.readUInt16BE(0),
    transactionId: buffer.subarray(8, 20),
    attributes
  };
}

export type StunIntegrityKey = string | Buffer;

export function encodeStunMessage(message: StunMessage, integrityKey?: StunIntegrityKey, fingerprint = true): Buffer {
  const encodedAttributes = message.attributes.map(encodeAttribute);
  let attributes = Buffer.concat(encodedAttributes);

  if (integrityKey) {
    const lengthWithIntegrity = attributes.length + 24;
    const header = encodeHeader(message.type, lengthWithIntegrity, message.transactionId);
    const digest = createHmac('sha1', integrityKey).update(Buffer.concat([header, attributes])).digest();
    attributes = Buffer.concat([attributes, encodeAttribute({ type: StunAttributeType.MESSAGE_INTEGRITY, value: digest })]);
  }

  if (fingerprint) {
    const lengthWithFingerprint = attributes.length + 8;
    const header = encodeHeader(message.type, lengthWithFingerprint, message.transactionId);
    const withoutFingerprint = Buffer.concat([header, attributes]);
    const value = Buffer.alloc(4);
    value.writeUInt32BE((crc32(withoutFingerprint) ^ 0x5354554e) >>> 0, 0);
    attributes = Buffer.concat([attributes, encodeAttribute({ type: StunAttributeType.FINGERPRINT, value })]);
  }

  return Buffer.concat([encodeHeader(message.type, attributes.length, message.transactionId), attributes]);
}

export function getAttribute(message: StunMessage, type: StunAttributeType): Buffer | undefined {
  return message.attributes.find((attribute) => attribute.type === type)?.value;
}

export function getUsername(message: StunMessage): string | undefined {
  return getAttribute(message, StunAttributeType.USERNAME)?.toString('utf8');
}

export function hasUseCandidate(message: StunMessage): boolean {
  return Boolean(getAttribute(message, StunAttributeType.USE_CANDIDATE));
}

export function readUInt32Attribute(message: StunMessage, type: StunAttributeType): number | undefined {
  const value = getAttribute(message, type);
  return value && value.length >= 4 ? value.readUInt32BE(0) : undefined;
}

export function readUInt64Attribute(message: StunMessage, type: StunAttributeType): bigint | undefined {
  const value = getAttribute(message, type);
  return value && value.length >= 8 ? value.readBigUInt64BE(0) : undefined;
}

export function encodeStringAttribute(type: StunAttributeType, value: string): StunAttribute {
  return { type, value: Buffer.from(value, 'utf8') };
}

export function encodeUInt32Attribute(type: StunAttributeType, value: number): StunAttribute {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return { type, value: buffer };
}

export function encodeUInt64Attribute(type: StunAttributeType, value: bigint): StunAttribute {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value, 0);
  return { type, value: buffer };
}

export function encodeEmptyAttribute(type: StunAttributeType): StunAttribute {
  return { type, value: Buffer.alloc(0) };
}

export function encodeXorMappedAddress(address: StunAddress, transactionId: Buffer): StunAttribute {
  return encodeXorAddress(StunAttributeType.XOR_MAPPED_ADDRESS, address, transactionId);
}

export function encodeXorPeerAddress(address: StunAddress, transactionId: Buffer): StunAttribute {
  return encodeXorAddress(StunAttributeType.XOR_PEER_ADDRESS, address, transactionId);
}

export function encodeRequestedTransport(protocol = 17): StunAttribute {
  const value = Buffer.alloc(4);
  value[0] = protocol & 0xff;
  return { type: StunAttributeType.REQUESTED_TRANSPORT, value };
}

export function encodeDataAttribute(data: Buffer): StunAttribute {
  return { type: StunAttributeType.DATA, value: data };
}

function encodeXorAddress(type: StunAttributeType, address: StunAddress, transactionId: Buffer): StunAttribute {
  if (address.family !== 'IPv4') {
    throw new Error('Only IPv4 XOR-MAPPED-ADDRESS is currently supported');
  }
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(address.port ^ (STUN_MAGIC_COOKIE >>> 16), 2);
  const parts = address.address.split('.').map((part) => Number(part));
  for (let index = 0; index < 4; index += 1) {
    value[4 + index] = (parts[index] ?? 0) ^ ((STUN_MAGIC_COOKIE >>> ((3 - index) * 8)) & 0xff);
  }
  return { type, value };
}

export function decodeXorMappedAddress(value: Buffer, transactionId: Buffer): StunAddress {
  if (value.length < 8) {
    throw new Error('Invalid XOR-MAPPED-ADDRESS');
  }
  const family = value[1] === 0x01 ? 'IPv4' : 'IPv6';
  const port = value.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16);
  if (family === 'IPv4') {
    const parts: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      parts.push(value[4 + index]! ^ ((STUN_MAGIC_COOKIE >>> ((3 - index) * 8)) & 0xff));
    }
    return { family, address: parts.join('.'), port };
  }
  if (value.length < 20) {
    throw new Error('Invalid IPv6 XOR-MAPPED-ADDRESS');
  }
  const cookieAndTransaction = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), transactionId]);
  const parts = Buffer.alloc(16);
  for (let index = 0; index < 16; index += 1) {
    parts[index] = value[4 + index]! ^ cookieAndTransaction[index]!;
  }
  return {
    family,
    address: parts.toString('hex').match(/.{1,4}/g)?.join(':') ?? '::',
    port
  };
}

export function verifyMessageIntegrity(buffer: Buffer, integrityKey: StunIntegrityKey): boolean {
  const message = parseStunMessage(buffer);
  const messageIntegrityOffset = findAttributeOffset(buffer, StunAttributeType.MESSAGE_INTEGRITY);
  if (messageIntegrityOffset < 0) {
    return false;
  }
  const value = getAttribute(message, StunAttributeType.MESSAGE_INTEGRITY);
  if (!value || value.length !== 20) {
    return false;
  }
  const lengthForIntegrity = messageIntegrityOffset - 20 + 24;
  const header = Buffer.from(buffer.subarray(0, 20));
  header.writeUInt16BE(lengthForIntegrity, 2);
  const signed = Buffer.concat([header, buffer.subarray(20, messageIntegrityOffset)]);
  const expected = createHmac('sha1', integrityKey).update(signed).digest();
  return timingSafeEqual(expected, value);
}

export function verifyFingerprint(buffer: Buffer): boolean {
  const fingerprintOffset = findAttributeOffset(buffer, StunAttributeType.FINGERPRINT);
  if (fingerprintOffset < 0 || fingerprintOffset + 8 > buffer.length) {
    return false;
  }
  const expected = buffer.readUInt32BE(fingerprintOffset + 4);
  const header = Buffer.from(buffer.subarray(0, 20));
  header.writeUInt16BE(fingerprintOffset - 20 + 8, 2);
  const computed = (crc32(Buffer.concat([header, buffer.subarray(20, fingerprintOffset)])) ^ 0x5354554e) >>> 0;
  return computed === expected;
}

function encodeHeader(type: number, length: number, transactionId: Buffer): Buffer {
  if (transactionId.length !== 12) {
    throw new Error('STUN transaction ID must be 12 bytes');
  }
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(length, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return header;
}

function encodeAttribute(attribute: StunAttribute): Buffer {
  const padding = paddingLength(attribute.value.length);
  const buffer = Buffer.alloc(4 + attribute.value.length + padding);
  buffer.writeUInt16BE(attribute.type, 0);
  buffer.writeUInt16BE(attribute.value.length, 2);
  attribute.value.copy(buffer, 4);
  return buffer;
}

function paddingLength(length: number): number {
  return (4 - (length % 4)) % 4;
}

function findAttributeOffset(buffer: Buffer, type: StunAttributeType): number {
  const length = buffer.readUInt16BE(2);
  let offset = 20;
  const end = 20 + length;
  while (offset + 4 <= end) {
    const attributeType = buffer.readUInt16BE(offset);
    const attributeLength = buffer.readUInt16BE(offset + 2);
    if (attributeType === type) {
      return offset;
    }
    offset += 4 + attributeLength + paddingLength(attributeLength);
  }
  return -1;
}
