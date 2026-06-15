import { test, expect } from '@playwright/test';
import { parseFir, parseNack, parsePli, parseReceiverReport, parseRemb, parseRtcpCompound, parseSenderReport } from '../../packages/sfu-core/src/rtcp/rtcp-packet';

test('browser-created RTCP wire packets parse in the SFU core', async ({ page }) => {
  const packets = await page.evaluate(() => {
    const senderReport = rtcpPacket(200, 0, (view) => {
      writeU32(view, 0, 111);
      view.setBigUint64(4, 0x1020304050607080n);
      writeU32(view, 12, 90);
      writeU32(view, 16, 12);
      writeU32(view, 20, 2048);
    }, 24);
    const receiverReport = rtcpPacket(201, 1, (view) => {
      writeU32(view, 0, 999);
      writeU32(view, 4, 111);
      view.setUint8(8, 64);
      view.setUint8(9, 0);
      view.setUint8(10, 0);
      view.setUint8(11, 3);
      writeU32(view, 12, 1234);
      writeU32(view, 16, 9);
      writeU32(view, 20, 10);
      writeU32(view, 24, 11);
    }, 28);
    const nack = rtcpPacket(205, 1, (view) => {
      writeU32(view, 0, 999);
      writeU32(view, 4, 111);
      view.setUint16(8, 77);
      view.setUint16(10, 0b11);
    }, 12);
    const pli = feedbackPacket(1, 999, 111);
    const fir = rtcpPacket(206, 4, (view) => {
      writeU32(view, 0, 999);
      writeU32(view, 4, 0);
      writeU32(view, 8, 111);
      view.setUint8(12, 5);
    }, 16);
    const remb = rtcpPacket(206, 15, (view) => {
      writeU32(view, 0, 999);
      writeU32(view, 4, 0);
      view.setUint8(8, 'R'.charCodeAt(0));
      view.setUint8(9, 'E'.charCodeAt(0));
      view.setUint8(10, 'M'.charCodeAt(0));
      view.setUint8(11, 'B'.charCodeAt(0));
      view.setUint8(12, 1);
      const encoded = encodeRembBitrate(1_500_000);
      view.setUint8(13, (encoded.exponent << 2) | ((encoded.mantissa >> 16) & 0x03));
      view.setUint16(14, encoded.mantissa & 0xffff);
      writeU32(view, 16, 111);
    }, 20);
    return {
      senderReport: Array.from(senderReport),
      receiverReport: Array.from(receiverReport),
      nack: Array.from(nack),
      pli: Array.from(pli),
      fir: Array.from(fir),
      remb: Array.from(remb)
    };

    function feedbackPacket(count: number, senderSsrc: number, mediaSsrc: number): Uint8Array {
      return rtcpPacket(206, count, (view) => {
        writeU32(view, 0, senderSsrc);
        writeU32(view, 4, mediaSsrc);
      }, 8);
    }

    function rtcpPacket(type: number, count: number, writePayload: (view: DataView) => void, payloadLength: number): Uint8Array {
      const bytes = new Uint8Array(payloadLength + 4);
      const view = new DataView(bytes.buffer);
      view.setUint8(0, 0x80 | count);
      view.setUint8(1, type);
      view.setUint16(2, bytes.length / 4 - 1);
      writePayload(new DataView(bytes.buffer, 4, payloadLength));
      return bytes;
    }

    function writeU32(view: DataView, offset: number, value: number): void {
      view.setUint32(offset, value >>> 0);
    }

    function encodeRembBitrate(bitrateBps: number): { exponent: number; mantissa: number } {
      let exponent = 0;
      let mantissa = Math.ceil(bitrateBps);
      while (mantissa > 0x3ffff) {
        exponent += 1;
        mantissa = Math.ceil(bitrateBps / 2 ** exponent);
      }
      return { exponent, mantissa };
    }
  });

  expect(parseSenderReport(parseRtcpCompound(Buffer.from(packets.senderReport))[0]!)?.senderSsrc).toBe(111);
  expect(parseReceiverReport(parseRtcpCompound(Buffer.from(packets.receiverReport))[0]!)?.reports[0]?.ssrc).toBe(111);
  expect(parseNack(parseRtcpCompound(Buffer.from(packets.nack))[0]!)?.lostPacketIds).toEqual([77, 78, 79]);
  expect(parsePli(parseRtcpCompound(Buffer.from(packets.pli))[0]!)?.mediaSsrc).toBe(111);
  expect(parseFir(parseRtcpCompound(Buffer.from(packets.fir))[0]!)?.entries).toEqual([{ ssrc: 111, sequenceNumber: 5 }]);
  expect(parseRemb(parseRtcpCompound(Buffer.from(packets.remb))[0]!)?.bitrateBps).toBe(1_500_000);
});
