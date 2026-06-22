# Student Enrollments Migration

`student_enrollments` is now the source of truth for batch roster and class-session access.
The previous temporary `batch_enrollments` collection should not be used by application code.

For environments that already contain `batch_enrollments`, run a one-time backfill before removing or archiving the old collection:

```javascript
db.batch_enrollments.find({ deletedAt: { $exists: false } }).forEach((oldEnrollment) => {
  const batch = db.batches.findOne({ _id: oldEnrollment.batchId });
  const student = db.users.findOne({ _id: oldEnrollment.studentId });
  db.student_enrollments.updateOne(
    {
      studentId: oldEnrollment.studentId,
      batchId: oldEnrollment.batchId,
      status: 'active',
      deletedAt: { $exists: false }
    },
    {
      $setOnInsert: {
        _id: oldEnrollment._id,
        studentId: oldEnrollment.studentId,
        studentName: student && student.displayName,
        studentEmail: student && student.email,
        courseId: batch && batch.courseId,
        batchId: oldEnrollment.batchId,
        batchName: batch && batch.name,
        teacherId: batch && batch.teacherId,
        status: oldEnrollment.status === 'cancelled' ? 'cancelled' : 'active',
        enrolledAt: oldEnrollment.enrolledAt || oldEnrollment.createdAt || new Date(),
        cancelledAt: oldEnrollment.cancelledAt,
        createdBy: oldEnrollment.createdBy,
        updatedBy: oldEnrollment.updatedBy,
        createdAt: oldEnrollment.createdAt || new Date(),
        updatedAt: oldEnrollment.updatedAt || new Date()
      }
    },
    { upsert: true }
  );
});
```

After backfill, verify:

```javascript
db.student_enrollments.countDocuments({ status: 'active', deletedAt: { $exists: false } });
db.student_enrollments.getIndexes();
```

Keep `batch_enrollments` read-only until production access logs confirm no legacy callers remain, then archive it.
