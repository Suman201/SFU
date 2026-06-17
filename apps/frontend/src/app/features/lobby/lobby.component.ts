import { Component, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { RoomStore } from '../../core/services/room.store';
import { SocketService } from '../../core/services/socket.service';

@Component({
  selector: 'sfu-lobby',
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    <main class="lobby-shell">
      <section class="brand-band">
        <div>
          <p class="eyebrow">Native WebRTC SFU</p>
          <h1>Room console</h1>
        </div>
        <button type="button" (click)="logout()" [disabled]="!auth.authenticated()">Sign out</button>
      </section>

      <section class="workspace">
        <form class="panel" [formGroup]="authForm" (ngSubmit)="submitAuth()">
          <header>
            <h2>{{ authMode() === 'login' ? 'Sign in' : 'Create account' }}</h2>
            <button type="button" (click)="toggleAuthMode()">{{ authMode() === 'login' ? 'Register' : 'Use login' }}</button>
          </header>
          @if (authMode() === 'register') {
            <label>
              Display name
              <input formControlName="displayName" autocomplete="name">
            </label>
          }
          <label>
            Email
            <input formControlName="email" autocomplete="email">
          </label>
          <label>
            Password
            <input type="password" formControlName="password" autocomplete="current-password">
          </label>
          <button class="primary" type="submit" [disabled]="authForm.invalid || busy()">
            {{ authMode() === 'login' ? 'Sign in' : 'Register' }}
          </button>
        </form>

        <form class="panel" [formGroup]="roomForm" (ngSubmit)="createRoom()">
          <header>
            <h2>Create room</h2>
            <span class="status" [class.ready]="auth.authenticated()">{{ auth.authenticated() ? 'Authenticated' : 'Auth required' }}</span>
          </header>
          <label>
            Room name
            <input formControlName="name">
          </label>
          <div class="grid-two">
            <label>
              Visibility
              <select formControlName="visibility">
                <option value="public">Public</option>
                <option value="private">Private</option>
                <option value="invite-only">Invite only</option>
              </select>
            </label>
            <label>
              Capacity
              <input type="number" formControlName="maxParticipants" min="1" max="1000">
            </label>
          </div>
          <div class="toggles">
            <label><input type="checkbox" formControlName="waitingRoomEnabled"> Waiting room</label>
            <label><input type="checkbox" formControlName="joinApprovalRequired"> Join approval</label>
          </div>
          <button class="primary" type="submit" [disabled]="roomForm.invalid || !auth.authenticated() || busy()">Create</button>
        </form>

        <form class="panel" [formGroup]="joinForm" (ngSubmit)="joinRoom()">
          <header>
            <h2>Join room</h2>
          </header>
          <label>
            Room ID
            <input formControlName="roomId">
          </label>
          <label>
            Display name
            <input formControlName="displayName" autocomplete="name">
          </label>
          <label class="toggle-row"><input type="checkbox" formControlName="asViewer"> Join as viewer</label>
          <button class="primary" type="submit" [disabled]="joinForm.invalid || !auth.authenticated() || busy()">Join</button>
        </form>
      </section>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .lobby-shell {
        min-height: 100vh;
        padding: 32px;
        display: grid;
        align-content: start;
        gap: 24px;
      }

      .brand-band {
        display: flex;
        justify-content: space-between;
        align-items: end;
        gap: 16px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 18px;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      h1 {
        font-size: clamp(30px, 4vw, 48px);
        font-weight: 760;
      }

      .eyebrow {
        color: var(--accent);
        font-weight: 700;
        text-transform: uppercase;
        font-size: 12px;
      }

      .workspace {
        display: grid;
        grid-template-columns: repeat(3, minmax(240px, 1fr));
        gap: 16px;
        align-items: start;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 18px;
        display: grid;
        gap: 14px;
      }

      header,
      .grid-two,
      .toggles {
        display: flex;
        gap: 10px;
      }

      header {
        justify-content: space-between;
        align-items: center;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
      }

      .grid-two > label {
        flex: 1;
      }

      .toggles,
      .toggle-row {
        color: var(--text);
        font-size: 14px;
      }

      .toggles input,
      .toggle-row input {
        width: auto;
      }

      .status {
        color: var(--warning);
        font-size: 12px;
      }

      .status.ready {
        color: var(--accent);
      }

      .error {
        color: var(--danger);
        font-weight: 600;
      }

      @media (max-width: 860px) {
        .lobby-shell {
          padding: 18px;
        }

        .workspace {
          grid-template-columns: 1fr;
        }
      }
    `
  ]
})
export class LobbyComponent {
  readonly authMode = signal<'login' | 'register'>('register');
  readonly busy = signal(false);
  readonly error = signal('');

  readonly authForm = this.fb.nonNullable.group({
    displayName: ['Host', [Validators.required, Validators.maxLength(120)]],
    email: ['host@example.com', [Validators.required, Validators.email]],
    password: ['Password@12345', [Validators.required, Validators.minLength(10)]]
  });

  readonly roomForm = this.fb.nonNullable.group({
    name: ['Daily Standup', [Validators.required, Validators.maxLength(160)]],
    visibility: ['public' as 'public' | 'private' | 'invite-only'],
    maxParticipants: [100, [Validators.required, Validators.min(1), Validators.max(1000)]],
    waitingRoomEnabled: [false],
    joinApprovalRequired: [false]
  });

  readonly joinForm = this.fb.nonNullable.group({
    roomId: ['', Validators.required],
    displayName: ['Guest', Validators.required],
    asViewer: [false]
  });

  constructor(
    readonly auth: AuthService,
    private readonly fb: FormBuilder,
    private readonly socket: SocketService,
    private readonly store: RoomStore,
    private readonly router: Router
  ) {}

  toggleAuthMode(): void {
    this.authMode.set(this.authMode() === 'login' ? 'register' : 'login');
  }

  submitAuth(): void {
    this.busy.set(true);
    this.error.set('');
    const value = this.authForm.getRawValue();
    const request =
      this.authMode() === 'login'
        ? this.auth.login(value.email, value.password)
        : this.auth.register(value.displayName, value.email, value.password);
    request.subscribe({
      next: () => this.busy.set(false),
      error: (error: Error) => {
        this.error.set(error.message);
        this.busy.set(false);
      }
    });
  }

  async createRoom(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const room = await this.socket.emitAck('room:create', this.roomForm.getRawValue());
      this.store.setRoom(room);
      this.store.setLocalParticipant(room.hostId);
      await this.router.navigate(['/rooms', room.id]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to create room');
    } finally {
      this.busy.set(false);
    }
  }

  async joinRoom(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await this.socket.emitAck('room:join', this.joinForm.getRawValue());
      this.store.setRoom(response.room);
      this.store.setLocalParticipant(response.participantId);
      await this.router.navigate(['/rooms', response.room.id]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to join room');
    } finally {
      this.busy.set(false);
    }
  }

  logout(): void {
    this.auth.logout();
    this.socket.disconnect();
  }
}
