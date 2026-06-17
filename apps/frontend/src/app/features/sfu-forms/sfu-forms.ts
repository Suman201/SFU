import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { email, FormField, FormRoot, form as signalForm, max, maxLength, min, minLength, required } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { RoomStore } from '../../core/services/room.store';
import { SocketService } from '../../core/services/socket.service';
import { ThemeService } from '../../core/services/theme.service';

interface AuthFormModel {
  displayName: string;
  email: string;
  password: string;
}

interface RoomFormModel {
  name: string;
  visibility: 'public' | 'private' | 'invite-only';
  maxParticipants: number;
  waitingRoomEnabled: boolean;
  joinApprovalRequired: boolean;
}

interface JoinFormModel {
  roomId: string;
  displayName: string;
  asViewer: boolean;
}

@Component({
  selector: 'sfu-forms',
  standalone: true,
  imports: [FormField, FormRoot],
  templateUrl: './sfu-forms.html',
  styleUrl: './sfu-forms.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class SfuForms {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  private readonly socket = inject(SocketService);
  private readonly store = inject(RoomStore);
  private readonly router = inject(Router);

  protected readonly authMode = signal<'login' | 'register'>('register');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly authModel = signal<AuthFormModel>({
    displayName: 'Host',
    email: 'host@example.com',
    password: 'Password@12345'
  });
  protected readonly authForm = signalForm(this.authModel, (path) => {
    required(path.displayName, { when: () => this.authMode() === 'register' });
    maxLength(path.displayName, 120);
    required(path.email);
    email(path.email);
    required(path.password);
    minLength(path.password, 10);
  });

  protected readonly roomModel = signal<RoomFormModel>({
    name: 'Daily Standup',
    visibility: 'public',
    maxParticipants: 100,
    waitingRoomEnabled: false,
    joinApprovalRequired: false
  });
  protected readonly roomForm = signalForm(this.roomModel, (path) => {
    required(path.name);
    maxLength(path.name, 160);
    required(path.visibility);
    required(path.maxParticipants);
    min(path.maxParticipants, 1);
    max(path.maxParticipants, 1000);
  });

  protected readonly joinModel = signal<JoinFormModel>({
    roomId: '',
    displayName: 'Guest',
    asViewer: false
  });
  protected readonly joinForm = signalForm(this.joinModel, (path) => {
    required(path.roomId);
    required(path.displayName);
  });

  protected toggleAuthMode(): void {
    this.authMode.set(this.authMode() === 'login' ? 'register' : 'login');
  }

  protected submitAuth(event?: Event): void {
    event?.preventDefault();
    this.authForm().markAsTouched();

    if (this.authForm().invalid()) {
      return;
    }

    this.busy.set(true);
    this.error.set('');
    const value = this.authModel();
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

  protected async createRoom(event?: Event): Promise<void> {
    event?.preventDefault();
    this.roomForm().markAsTouched();

    if (this.roomForm().invalid()) {
      return;
    }

    this.busy.set(true);
    this.error.set('');
    try {
      const room = await this.socket.emitAck('room:create', this.normalizedRoomFormValue());
      this.store.setRoom(room);
      this.store.setLocalParticipant(room.hostId);
      await this.router.navigate(['/rooms', room.id]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to create room');
    } finally {
      this.busy.set(false);
    }
  }

  protected async joinRoom(event?: Event): Promise<void> {
    event?.preventDefault();
    this.joinForm().markAsTouched();

    if (this.joinForm().invalid()) {
      return;
    }

    this.busy.set(true);
    this.error.set('');
    try {
      const response = await this.socket.emitAck('room:join', this.joinModel());
      this.store.setRoom(response.room);
      this.store.setLocalParticipant(response.participantId);
      await this.router.navigate(['/rooms', response.room.id]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to join room');
    } finally {
      this.busy.set(false);
    }
  }

  protected logout(): void {
    this.auth.logout();
    this.socket.disconnect();
  }

  protected toggleTheme(): void {
    this.theme.toggle();
  }

  private normalizedRoomFormValue(): RoomFormModel {
    const value = this.roomModel();
    return {
      ...value,
      maxParticipants: Number(value.maxParticipants)
    };
  }
}
