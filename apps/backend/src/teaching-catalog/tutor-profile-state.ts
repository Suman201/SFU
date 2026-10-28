import { ConflictException } from '@nestjs/common';
import type { UserMongoDocument } from '../database/schemas';
export function invalidateTutorReview(doc: UserMongoDocument): void {
  // A review may only approve the exact profile revision it inspected.
  const revision = doc.tutorRevision ?? 0;
  doc.$where =
    revision === 0
      ? { $or: [{ tutorRevision: 0 }, { tutorRevision: { $exists: false } }] }
      : { tutorRevision: revision };
  doc.tutorRevision = revision + 1;
  doc.tutorReviewStatus = 'draft';
  doc.publicProfileEnabled = false;
}
export async function saveTutorProfile(doc: UserMongoDocument): Promise<void> {
  try {
    await doc.save();
  } catch (error) {
    if (
      ['DocumentNotFoundError', 'VersionError'].includes((error as Error).name)
    )
      throw new ConflictException(
        'Your profile changed in another session. Reload and try again.',
      );
    throw error;
  }
}
