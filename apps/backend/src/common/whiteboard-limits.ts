import { BadRequestException } from '@nestjs/common';
import type { WhiteboardMemorySnapshot } from '@native-sfu/contracts';

export const WHITEBOARD_MEMORY_MAX_BYTES = 1_500_000;
export const WHITEBOARD_MEMORY_MAX_PAGES = 80;
export const WHITEBOARD_MEMORY_MAX_ELEMENTS = 2_500;

/** Live commands and HTTP saves must produce boards with the same limits. */
export function assertWhiteboardSnapshotWithinLimits(snapshot: WhiteboardMemorySnapshot): void {
  if (snapshot.pages.length > WHITEBOARD_MEMORY_MAX_PAGES) {
    throw new BadRequestException(`Whiteboard snapshot cannot exceed ${WHITEBOARD_MEMORY_MAX_PAGES} pages.`);
  }
  if (snapshot.pages.reduce((total, page) => total + page.elements.length, 0) > WHITEBOARD_MEMORY_MAX_ELEMENTS) {
    throw new BadRequestException(`Whiteboard snapshot cannot exceed ${WHITEBOARD_MEMORY_MAX_ELEMENTS} elements.`);
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > WHITEBOARD_MEMORY_MAX_BYTES) {
    throw new BadRequestException('Whiteboard snapshot is too large. Remove content or start a new board.');
  }
}
