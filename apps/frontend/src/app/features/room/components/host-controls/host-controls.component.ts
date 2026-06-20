import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type {
  RoomIncidentState,
  RoomIncidentTimelineState,
  RoomMediaProfileId,
  RoomQualitySummaryState,
  RoomRecoveryActionType,
  RoomSnapshotHistoryState
} from '@native-sfu/contracts';

@Component({
  selector: 'sfu-host-controls',
  standalone: true,
  imports: [DatePipe],
  template: `
    <section class="host">
      <div class="host-header">
        <div>
          <p class="eyebrow">Operator autopilot</p>
          <h3>Room policy</h3>
        </div>
        <div class="host-toolbar">
          <label class="profile-field">
            <span>Profile</span>
            <select
              [value]="activeProfileId"
              [disabled]="!canManageRoom || profileUpdating"
              (change)="onProfileChange($event)"
            >
              <option value="meeting">Meeting</option>
              <option value="webinar">Webinar</option>
              <option value="classroom">Classroom</option>
              <option value="support">Support</option>
            </select>
          </label>
          <button type="button" (click)="lock.emit()" [disabled]="!canManageRoom">Lock</button>
          <button type="button" (click)="unlock.emit()" [disabled]="!canManageRoom">Unlock</button>
          <button type="button" class="danger" (click)="close.emit()" [disabled]="!canManageRoom">End</button>
        </div>
      </div>

      @if (summary; as currentSummary) {
        <div class="health-strip">
          <span class="pill" [class.warn]="currentSummary.health === 'degraded'" [class.critical]="currentSummary.health === 'critical'">
            {{ currentSummary.health }}
          </span>
          <span class="pill">{{ currentSummary.profile.label }}</span>
          <span class="pill">{{ currentSummary.congestionState }}</span>
          <span class="pill">{{ currentSummary.degradedConsumers }} degraded consumers</span>
          <span class="pill">{{ currentSummary.activeProducerCount }} live producers</span>
        </div>

        <div class="protections">
          @for (decision of protectionEntries(currentSummary); track decision.scope) {
            <div class="protection-row" [class.warn]="decision.action === 'warn' || decision.action === 'soft-throttle'" [class.critical]="decision.action === 'reject'">
              <div>
                <p class="row-title">{{ decision.label }}</p>
                <p class="row-detail">{{ decision.message }}</p>
              </div>
              <span class="status-chip" [class.warn]="decision.action === 'warn' || decision.action === 'soft-throttle'" [class.critical]="decision.action === 'reject'">
                {{ decision.action }}
              </span>
            </div>
          }
        </div>

        @if (currentSummary.recommendations.length > 0) {
          <div class="list-block">
            <p class="block-label">Recommendations</p>
            <ul>
              @for (recommendation of currentSummary.recommendations; track recommendation.code) {
                <li>
                  <span class="severity" [class.warn]="recommendation.severity === 'warn'" [class.critical]="recommendation.severity === 'critical'">
                    {{ recommendation.severity }}
                  </span>
                  <div>
                    <p class="row-title">{{ recommendation.title }}</p>
                    <p class="row-detail">{{ recommendation.detail }}</p>
                  </div>
                </li>
              }
            </ul>
          </div>
        }

        @if (currentSummary.warnings.length > 0) {
          <div class="list-block warnings">
            <p class="block-label">Warnings</p>
            <ul>
              @for (warning of currentSummary.warnings; track warning) {
                <li>{{ warning }}</li>
              }
            </ul>
          </div>
        }

        @if (incidentState; as incident) {
          <div class="incident-strip">
            <span class="pill" [class.warn]="incident.status === 'degraded' || incident.status === 'recovering'" [class.critical]="incident.status === 'critical' || incident.status === 'failed'">
              {{ incident.status }}
            </span>
            <span class="pill" [class.warn]="incident.protected">protected: {{ incident.protected ? 'on' : 'off' }}</span>
            <span class="pill" [class.warn]="incident.underRecovery">recovery: {{ incident.underRecovery ? 'active' : 'idle' }}</span>
            <span class="pill">snapshots: {{ incident.snapshotCount }}</span>
          </div>

          @if (incident.activeAlerts.length > 0) {
            <div class="list-block alerts">
              <p class="block-label">Active alerts</p>
              <ul>
                @for (alert of incident.activeAlerts; track alert.code) {
                  <li>
                    <span class="severity" [class.warn]="alert.severity === 'warn'" [class.critical]="alert.severity === 'critical'">
                      {{ alert.severity }}
                    </span>
                    <div>
                      <p class="row-title">{{ alert.title }}</p>
                      <p class="row-detail">{{ alert.detail }}</p>
                    </div>
                  </li>
                }
              </ul>
            </div>
          }

          @if (incident.workflows?.length) {
            <div class="list-block workflows">
              <p class="block-label">Recovery workflows</p>
              <ul>
                @for (workflow of incident.workflows; track workflow.id) {
                  <li>
                    <span class="status-chip" [class.warn]="workflow.status === 'recommended'" [class.critical]="workflow.status === 'blocked'">
                      {{ workflow.status }}
                    </span>
                    <div>
                      <p class="row-title">{{ workflow.title }}</p>
                      <p class="row-detail">{{ workflow.detail }}</p>
                      @if (workflow.blockedReason) {
                        <p class="row-detail muted">{{ workflow.blockedReason }}</p>
                      }
                    </div>
                  </li>
                }
              </ul>
            </div>
          }

          <div class="recovery-actions">
            <label class="reason-field">
              <span>Operator note</span>
              <textarea
                rows="3"
                [value]="actionReason"
                [disabled]="!canManageRoom"
                (input)="actionReason = $any($event.target).value"
                placeholder="Optional note for snapshots or recovery steps"
              ></textarea>
            </label>
            <div class="action-grid">
              @for (action of recoveryActions(incident); track action.type) {
                <button
                  type="button"
                  [class.danger]="action.emphasis === 'danger'"
                  [class.secondary]="action.emphasis === 'secondary'"
                  [disabled]="!canManageRoom"
                  (click)="emitRecoveryAction(action.type)"
                >
                  {{ action.label }}
                </button>
              }
            </div>
          </div>
        }

        @if (incidentTimeline?.events?.length) {
          <div class="list-block timeline">
            <p class="block-label">Incident timeline</p>
            <ul>
              @for (event of timelineEvents(); track event.id) {
                <li>
                  <span class="severity" [class.warn]="event.severity === 'warn'" [class.critical]="event.severity === 'critical'">
                    {{ event.severity }}
                  </span>
                  <div>
                    <p class="row-title">{{ event.summary }}</p>
                    @if (event.detail) {
                      <p class="row-detail">{{ event.detail }}</p>
                    }
                    <p class="row-meta">{{ event.createdAt | date: 'MMM d, HH:mm:ss' }}</p>
                  </div>
                </li>
              }
            </ul>
          </div>
        }

        @if (snapshotHistory?.bundles?.length) {
          <div class="list-block snapshots">
            <p class="block-label">Snapshot bundles</p>
            <ul>
              @for (bundle of snapshotBundles(); track bundle.bundleId) {
                <li>
                  <span class="status-chip" [class.warn]="bundle.health === 'degraded'" [class.critical]="bundle.health === 'critical'">
                    {{ bundle.triggerReason }}
                  </span>
                  <div>
                    <p class="row-title">{{ bundle.status }} | {{ bundle.degradedEntityCount }} degraded entities</p>
                    <p class="row-detail">
                      {{ bundle.generatedAt | date: 'MMM d, HH:mm:ss' }}
                      @if (bundle.automatic) { <span> | automatic</span> }
                    </p>
                  </div>
                </li>
              }
            </ul>
          </div>
        }
      } @else {
        <p class="empty-state">Waiting for live room quality data.</p>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .host {
        display: grid;
        gap: 12px;
      }

      .host-header {
        display: grid;
        gap: 12px;
      }

      .host-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: end;
      }

      .eyebrow,
      .row-title,
      .row-detail,
      .block-label,
      h3,
      p {
        margin: 0;
      }

      .eyebrow,
      .block-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--success);
      }

      h3 {
        font-size: 17px;
      }

      .profile-field {
        display: grid;
        gap: 4px;
        min-width: 160px;
        font-size: 12px;
        color: var(--muted);
      }

      .profile-field select,
      button {
        min-height: 34px;
      }

      .health-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .pill,
      .status-chip,
      .severity {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 700;
        border: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel-elevated) 85%, white 15%);
      }

      .pill.warn,
      .status-chip.warn,
      .severity.warn {
        border-color: var(--warning);
        background: color-mix(in srgb, var(--warning) 22%, var(--panel-elevated) 78%);
      }

      .pill.critical,
      .status-chip.critical,
      .severity.critical {
        border-color: var(--danger);
        background: color-mix(in srgb, var(--danger) 18%, var(--panel-elevated) 82%);
      }

      .protections,
      .list-block,
      .recovery-actions {
        display: grid;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--line-soft);
      }

      .protection-row,
      .list-block li {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: start;
        padding: 8px 0;
        border-bottom: 1px solid var(--line-soft);
      }

      .protection-row:last-child,
      .list-block li:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }

      .row-title {
        font-weight: 700;
      }

      .row-detail {
        margin-top: 4px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.35;
      }

      .list-block ul {
        list-style: none;
        display: grid;
        gap: 8px;
        padding: 0;
        margin: 0;
      }

      .list-block li {
        grid-template-columns: auto 1fr;
      }

      .warnings li {
        grid-template-columns: 1fr;
        color: var(--muted);
      }

      .incident-strip,
      .action-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .recovery-actions {
        gap: 10px;
      }

      .reason-field {
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
      }

      .reason-field textarea {
        min-height: 72px;
        resize: vertical;
      }

      .action-grid button.secondary {
        background: color-mix(in srgb, var(--panel) 82%, white 18%);
        color: var(--text);
      }

      .row-meta {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }

      .muted {
        color: var(--muted);
      }

      .empty-state {
        color: var(--muted);
        font-size: 13px;
      }
    `
  ]
})
export class HostControlsComponent {
  @Input() canManageRoom = false;
  @Input() activeProfileId: RoomMediaProfileId = 'meeting';
  @Input() profileUpdating = false;
  @Input() summary: RoomQualitySummaryState | null = null;
  @Input() incidentState: RoomIncidentState | null = null;
  @Input() incidentTimeline: RoomIncidentTimelineState | null = null;
  @Input() snapshotHistory: RoomSnapshotHistoryState | null = null;

  @Output() lock = new EventEmitter<void>();
  @Output() unlock = new EventEmitter<void>();
  @Output() close = new EventEmitter<void>();
  @Output() profileChange = new EventEmitter<RoomMediaProfileId>();
  @Output() recoveryAction = new EventEmitter<{ action: RoomRecoveryActionType; reason?: string }>();

  protected actionReason = '';

  protected protectionEntries(summary: RoomQualitySummaryState): Array<{
    scope: 'join' | 'publish' | 'screenShare';
    label: string;
    action: string;
    message: string;
  }> {
    return [
      {
        scope: 'join',
        label: 'Join admission',
        action: summary.protections.join.action,
        message: summary.protections.join.message
      },
      {
        scope: 'publish',
        label: 'New publishing',
        action: summary.protections.publish.action,
        message: summary.protections.publish.message
      },
      {
        scope: 'screenShare',
        label: 'Screen share',
        action: summary.protections.screenShare.action,
        message: summary.protections.screenShare.message
      }
    ];
  }

  protected recoveryActions(incident: RoomIncidentState): Array<{ type: RoomRecoveryActionType; label: string; emphasis?: 'default' | 'secondary' | 'danger' }> {
    return [
      { type: incident.protected ? 'unprotect_room' : 'protect_room', label: incident.protected ? 'Unprotect room' : 'Protect room' },
      {
        type: incident.admissionsState === 'reopened' ? 'protect_room' : 'reopen_admissions',
        label: incident.admissionsState === 'reopened' ? 'Re-protect admissions' : 'Reopen admissions',
        emphasis: 'secondary'
      },
      {
        type: incident.publishingState === 'paused' ? 'resume_new_publishing' : 'pause_new_publishing',
        label: incident.publishingState === 'paused' ? 'Resume publishing' : 'Pause publishing',
        emphasis: 'secondary'
      },
      { type: 'force_incident_snapshot', label: 'Capture snapshot', emphasis: 'secondary' },
      {
        type: incident.underRecovery ? 'clear_recovery' : 'mark_operator_recovery',
        label: incident.underRecovery ? 'Clear recovery' : 'Mark recovery',
        emphasis: incident.underRecovery ? 'secondary' : 'danger'
      }
    ];
  }

  protected emitRecoveryAction(action: RoomRecoveryActionType): void {
    this.recoveryAction.emit({
      action,
      reason: this.actionReason.trim() || undefined
    });
  }

  protected onProfileChange(event: Event): void {
    const value = (event.target as HTMLSelectElement | null)?.value;
    this.profileChange.emit((value ?? 'meeting') as RoomMediaProfileId);
  }

  protected timelineEvents() {
    return this.incidentTimeline?.events.slice(0, 8) ?? [];
  }

  protected snapshotBundles() {
    return this.snapshotHistory?.bundles.slice(0, 6) ?? [];
  }
}
