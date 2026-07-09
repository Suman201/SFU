import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { AdminDashboardIssue, AdminDashboardLiveSession, AdminDashboardSummary } from '@native-sfu/contracts';
import { Model } from 'mongoose';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  BatchDocument,
  BatchMongoDocument,
  ClassSessionActivityEventDocument,
  ClassSessionActivityEventMongoDocument,
  ClassSessionAttendanceSnapshotDocument,
  ClassSessionAttendanceSnapshotMongoDocument,
  ClassSessionDocument,
  ClassSessionMongoDocument,
  RecordingDocument,
  RecordingMongoDocument,
  StudentEnrollmentDocument,
  StudentEnrollmentMongoDocument,
  SupportRequestDocument,
  SupportRequestMongoDocument,
  UserDocument,
  UserMongoDocument
} from '../database/schemas';

@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectModel(ClassSessionDocument.name) private readonly classSessions: Model<ClassSessionMongoDocument>,
    @InjectModel(ClassSessionAttendanceSnapshotDocument.name)
    private readonly attendanceSnapshots: Model<ClassSessionAttendanceSnapshotMongoDocument>,
    @InjectModel(RecordingDocument.name) private readonly recordings: Model<RecordingMongoDocument>,
    @InjectModel(StudentEnrollmentDocument.name) private readonly enrollments: Model<StudentEnrollmentMongoDocument>,
    @InjectModel(UserDocument.name) private readonly users: Model<UserMongoDocument>,
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(SupportRequestDocument.name) private readonly supportRequests: Model<SupportRequestMongoDocument>,
    @InjectModel(ClassSessionActivityEventDocument.name) private readonly activityEvents: Model<ClassSessionActivityEventMongoDocument>
  ) {}

  async getSummary(user: AuthenticatedUser): Promise<AdminDashboardSummary> {
    this.assertAdmin(user);
    const generatedAt = new Date();
    const { todayStart, todayEnd } = this.utcDayBounds(generatedAt);

    const [
      liveSessions,
      scheduledToday,
      completedToday,
      activeRecordings,
      failedRecordings,
      newEnrollmentsToday,
      pendingEnrollments,
      activeEnrollments,
      activeUsers,
      teachers,
      students,
      admins,
      activeBatches,
      cancelledBatches,
      disabledUsers,
      suspendedEnrollments,
      activeCourses,
      attendanceCounts,
      liveSessionItems,
      teacherReconnectGraceSessions,
      unresolvedSupportRequests,
      recentJoinDenials,
      recentMediaFailures
    ] = await Promise.all([
      this.classSessions.countDocuments({ status: 'live' }).exec(),
      this.classSessions.countDocuments({ scheduledAt: { $gte: todayStart, $lt: todayEnd } }).exec(),
      this.classSessions.countDocuments({ status: 'completed', completedAt: { $gte: todayStart, $lt: todayEnd } }).exec(),
      this.recordings.countDocuments({ status: { $in: ['starting', 'recording', 'stopping'] } }).exec(),
      this.recordings.countDocuments({ status: 'failed' }).exec(),
      this.enrollments.countDocuments({ deletedAt: { $exists: false }, createdAt: { $gte: todayStart, $lt: todayEnd } }).exec(),
      this.enrollments.countDocuments({ deletedAt: { $exists: false }, status: 'pending' }).exec(),
      this.enrollments.countDocuments({ deletedAt: { $exists: false }, status: 'active' }).exec(),
      this.users.countDocuments({ deletedAt: { $exists: false }, disabled: false, status: 'active' }).exec(),
      this.users.countDocuments({ deletedAt: { $exists: false }, roles: 'TEACHER' }).exec(),
      this.users.countDocuments({ deletedAt: { $exists: false }, roles: 'STUDENT' }).exec(),
      this.users.countDocuments({ deletedAt: { $exists: false }, roles: { $in: ['ADMIN', 'SUPER_ADMIN'] } }).exec(),
      this.batches.countDocuments({ deletedAt: { $exists: false }, status: 'ACTIVE' }).exec(),
      this.batches.countDocuments({ deletedAt: { $exists: false }, status: 'CANCELLED' }).exec(),
      this.users.countDocuments({ deletedAt: { $exists: false }, disabled: true }).exec(),
      this.enrollments.countDocuments({ deletedAt: { $exists: false }, status: 'suspended' }).exec(),
      this.countActiveCourses(),
      this.todayAttendanceCounts(todayStart, todayEnd),
      this.liveSessionRows(),
      this.classSessions.countDocuments({ status: 'live', teacherReconnectDeadlineAt: { $exists: true } }).exec(),
      this.supportRequests.countDocuments({ deletedAt: { $exists: false }, status: { $in: ['open', 'in_review', 'waiting_for_student'] } }).exec(),
      this.activityEvents
        .countDocuments({
          eventType: 'participant.join_denied',
          createdAt: { $gte: new Date(generatedAt.getTime() - 30 * 60 * 1000) }
        })
        .exec(),
      this.activityEvents
        .countDocuments({
          category: 'media',
          eventType: { $regex: /failed$/ },
          createdAt: { $gte: new Date(generatedAt.getTime() - 30 * 60 * 1000) }
        })
        .exec()
    ]);

    const issues = this.dashboardIssues({
      failedRecordings,
      liveSessions,
      pendingEnrollments,
      suspendedEnrollments,
      disabledUsers,
      cancelledBatches,
      teacherReconnectGraceSessions,
      unresolvedSupportRequests,
      recentJoinDenials,
      recentMediaFailures
    });

    return {
      generatedAt: generatedAt.toISOString(),
      todayStart: todayStart.toISOString(),
      todayEnd: todayEnd.toISOString(),
      liveSessions,
      scheduledToday,
      completedToday,
      todayAttendanceRate: attendanceCounts.enrolled ? Math.round((attendanceCounts.present / attendanceCounts.enrolled) * 100) : 0,
      activeRecordings,
      failedRecordings,
      newEnrollmentsToday,
      pendingEnrollments,
      activeEnrollments,
      activeUsers,
      teachers,
      students,
      admins,
      activeCourses,
      activeBatches,
      issues,
      liveSessionItems
    };
  }

  private async liveSessionRows(): Promise<AdminDashboardLiveSession[]> {
    const sessions = await this.classSessions.find({ status: 'live' }).sort({ startedAt: -1, scheduledAt: -1 }).limit(5).exec();
    if (!sessions.length) {
      return [];
    }
    const [batches, teachers] = await Promise.all([
      this.batches.find({ _id: { $in: sessions.map((session) => session.batchId) }, deletedAt: { $exists: false } }).exec(),
      this.users.find({ _id: { $in: sessions.map((session) => session.teacherId) }, deletedAt: { $exists: false } }).exec()
    ]);
    const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
    const teacherMap = new Map(teachers.map((teacher) => [teacher.id, teacher]));
    return sessions.map((session) => {
      const batch = batchMap.get(session.batchId);
      const teacher = teacherMap.get(session.teacherId);
      return {
        sessionId: session.id,
        title: session.title,
        batchId: session.batchId,
        ...(batch?.name ? { batchName: batch.name } : {}),
        teacherId: session.teacherId,
        ...(teacher?.displayName ? { teacherName: teacher.displayName } : {}),
        ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
        ...(session.roomId ? { roomId: session.roomId } : {}),
        teacherState: session.teacherReconnectDeadlineAt ? 'reconnecting' : 'connected'
      };
    });
  }

  private async todayAttendanceCounts(todayStart: Date, todayEnd: Date): Promise<{ enrolled: number; present: number }> {
    const rows = await this.attendanceSnapshots
      .aggregate<{ _id: string | null; count: number }>([
        { $match: { createdAt: { $gte: todayStart, $lt: todayEnd } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
      .exec();
    const enrolled = rows.reduce((total, row) => total + row.count, 0);
    const present = rows.find((row) => row._id === 'present')?.count ?? 0;
    return { enrolled, present };
  }

  private async countActiveCourses(): Promise<number> {
    const rows = await this.batches
      .aggregate<{ _id: string }>([
        {
          $match: {
            deletedAt: { $exists: false },
            status: 'ACTIVE'
          }
        },
        {
          $group: {
            _id: {
              $ifNull: ['$courseId', '$courseName']
            }
          }
        },
        {
          $match: {
            _id: { $ne: null }
          }
        }
      ])
      .exec();
    return rows.length;
  }

  private dashboardIssues(input: {
    failedRecordings: number;
    liveSessions: number;
    pendingEnrollments: number;
    suspendedEnrollments: number;
    disabledUsers: number;
    cancelledBatches: number;
    teacherReconnectGraceSessions: number;
    unresolvedSupportRequests: number;
    recentJoinDenials: number;
    recentMediaFailures: number;
  }): AdminDashboardIssue[] {
    const issues: AdminDashboardIssue[] = [];
    if (input.teacherReconnectGraceSessions > 0) {
      issues.push({
        severity: 'critical',
        label: 'Teachers reconnecting in live sessions',
        count: input.teacherReconnectGraceSessions,
        link: '/class-sessions?status=live'
      });
    }
    if (input.failedRecordings > 0) {
      issues.push({ severity: 'critical', label: 'Failed recordings need review', count: input.failedRecordings, link: '/recordings?status=failed' });
    }
    if (input.recentMediaFailures > 0) {
      issues.push({
        severity: 'warning',
        label: 'Recent live media failures',
        count: input.recentMediaFailures,
        link: '/class-sessions?status=live'
      });
    }
    if (input.recentJoinDenials > 0) {
      issues.push({
        severity: 'warning',
        label: 'Recent class join denials',
        count: input.recentJoinDenials,
        link: '/class-sessions?status=live'
      });
    }
    if (input.unresolvedSupportRequests > 0) {
      issues.push({
        severity: 'warning',
        label: 'Unresolved support requests',
        count: input.unresolvedSupportRequests,
        link: '/support'
      });
    }
    if (input.suspendedEnrollments > 0) {
      issues.push({ severity: 'warning', label: 'Suspended enrollments', count: input.suspendedEnrollments, link: '/enrollments?status=suspended' });
    }
    if (input.pendingEnrollments > 0) {
      issues.push({ severity: 'info', label: 'Pending enrollments', count: input.pendingEnrollments, link: '/enrollments?status=pending' });
    }
    if (input.disabledUsers > 0) {
      issues.push({ severity: 'warning', label: 'Disabled user accounts', count: input.disabledUsers, link: '/users?status=inactive' });
    }
    if (input.cancelledBatches > 0) {
      issues.push({ severity: 'info', label: 'Cancelled batches in catalog', count: input.cancelledBatches, link: '/batches?status=CANCELLED' });
    }
    if (input.liveSessions > 0) {
      issues.push({ severity: 'info', label: 'Live sessions active now', count: input.liveSessions, link: '/class-sessions?status=live' });
    }
    return issues;
  }

  private utcDayBounds(now: Date): { todayStart: Date; todayEnd: Date } {
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    return { todayStart, todayEnd };
  }

  private assertAdmin(user: AuthenticatedUser): void {
    if (!user.roles.includes('ADMIN') && !user.roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Admin access required.');
    }
  }
}
