import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketService } from '../../../core/services/socket.service';
import { ClassSessionService } from '../class-session.service';
import { SessionChat } from './session-chat';

describe('SessionChat delivery state', () => {
  let fixture: ComponentFixture<SessionChat>;
  let store: RoomStore;
  let classSessions: jasmine.SpyObj<{
    getChatHistory: ClassSessionService['getChatHistory'];
    getChatSummary: ClassSessionService['getChatSummary'];
    uploadChatAttachments: ClassSessionService['uploadChatAttachments'];
    downloadChatAttachment: ClassSessionService['downloadChatAttachment'];
  }> & { errorMessage: () => string };
  let socketService: {
    connect: () => { connected: boolean; on: jasmine.Spy; off: jasmine.Spy };
    on: jasmine.Spy;
    off: jasmine.Spy;
    emitAck: jasmine.Spy;
  };

  beforeEach(async () => {
    const realtimeSocket = {
      connected: true,
      on: jasmine.createSpy('on'),
      off: jasmine.createSpy('off')
    };
    classSessions = {
      getChatHistory: jasmine.createSpy('getChatHistory').and.returnValue(of({ messages: [] })),
      getChatSummary: jasmine.createSpy('getChatSummary').and.returnValue(of({ sessionId: 'session-1', roomId: 'room-1', threads: [] })),
      uploadChatAttachments: jasmine.createSpy('uploadChatAttachments').and.returnValue(of([])),
      downloadChatAttachment: jasmine.createSpy('downloadChatAttachment').and.returnValue(of(new Blob(['attachment']))),
      errorMessage: () => 'Unable to load chat.'
    };
    socketService = {
      connect: () => realtimeSocket,
      on: jasmine.createSpy('on'),
      off: jasmine.createSpy('off'),
      emitAck: jasmine.createSpy('emitAck').and.returnValue(Promise.resolve({}))
    };

    await TestBed.configureTestingModule({
      imports: [SessionChat],
      providers: [
        RoomStore,
        { provide: AuthService, useValue: { user: signal({ id: 'teacher-user', name: 'Teacher One' }) } },
        { provide: ClassSessionService, useValue: classSessions },
        { provide: SocketService, useValue: socketService }
      ]
    }).compileComponents();

    store = TestBed.inject(RoomStore);
    store.setLocalParticipant('teacher-participant');
    fixture = TestBed.createComponent(SessionChat);
    fixture.componentRef.setInput('currentRole', 'Teacher');
    fixture.componentRef.setInput('currentUser', 'Teacher One');
    fixture.componentRef.setInput('sessionId', 'session-1');
    fixture.componentRef.setInput('roomId', 'room-1');
    fixture.componentRef.setInput('threadParticipants', [{ id: 'student-participant', name: 'Student One', initials: 'SO', role: 'Student' }]);
    fixture.detectChanges();
  });

  it('renders Delivered and Read labels for authored private messages', () => {
    const component = fixture.componentInstance as unknown as {
      messages: { set(value: unknown[]): void };
      selectedThreadParticipantId: { set(value: string): void };
    };
    component.selectedThreadParticipantId.set('student-participant');
    component.messages.set([
      {
        id: 'message-1',
        sessionId: 'session-1',
        roomId: 'room-1',
        senderId: 'teacher-participant',
        senderName: 'Teacher One',
        senderRole: 'teacher',
        recipientId: 'student-participant',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-user:student:student-1',
        message: 'Please check problem 4',
        shadowMuted: false,
        deliveryState: 'delivered',
        createdAt: '2026-06-22T10:05:00.000Z'
      }
    ]);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.message-status span')?.textContent?.trim()).toBe('Delivered');

    component.messages.set([
      {
        id: 'message-1',
        sessionId: 'session-1',
        roomId: 'room-1',
        senderId: 'teacher-participant',
        senderName: 'Teacher One',
        senderRole: 'teacher',
        recipientId: 'student-participant',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-user:student:student-1',
        message: 'Please check problem 4',
        shadowMuted: false,
        deliveryState: 'read',
        createdAt: '2026-06-22T10:05:00.000Z'
      }
    ]);
    fixture.detectChanges();

    expect(root.querySelector('.message-status span')?.textContent?.trim()).toBe('Read');
  });

  it('upgrades an authored private message to Read from a targeted read receipt', () => {
    const component = fixture.componentInstance as unknown as {
      messages: { set(value: unknown[]): void; (): Array<{ deliveryState?: string; readAt?: string }> };
      selectedThreadParticipantId: { set(value: string): void };
      applyReadReceipt(receipt: unknown): void;
    };
    component.selectedThreadParticipantId.set('student-participant');
    component.messages.set([
      {
        id: 'message-1',
        sessionId: 'session-1',
        roomId: 'room-1',
        senderId: 'teacher-participant',
        senderName: 'Teacher One',
        senderRole: 'teacher',
        recipientId: 'student-participant',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-user:student:student-1',
        message: 'Please check problem 4',
        shadowMuted: false,
        deliveryState: 'delivered',
        createdAt: '2026-06-22T10:05:00.000Z'
      }
    ]);

    component.applyReadReceipt({
      sessionId: 'session-1',
      roomId: 'room-1',
      scope: 'private',
      threadKey: 'session-1:teacher:teacher-user:student:student-1',
      participantId: 'student-participant',
      userId: 'student-user',
      lastReadAt: '2026-06-22T10:06:00.000Z'
    });

    expect(component.messages()[0]?.deliveryState).toBe('read');
    expect(component.messages()[0]?.readAt).toBe('2026-06-22T10:06:00.000Z');
  });

  it('renders chat attachments as compact attachment tiles', () => {
    const component = fixture.componentInstance as unknown as {
      messages: { set(value: unknown[]): void };
      selectedThreadParticipantId: { set(value: string): void };
    };
    component.selectedThreadParticipantId.set('student-participant');
    component.messages.set([
      {
        id: 'message-with-attachments',
        sessionId: 'session-1',
        roomId: 'room-1',
        senderId: 'teacher-participant',
        senderName: 'Teacher One',
        senderRole: 'teacher',
        recipientId: 'student-participant',
        scope: 'private',
        threadKey: 'session-1:teacher:teacher-user:student:student-1',
        message: 'Review these',
        attachments: [
          {
            id: 'image-1',
            attachmentId: 'image-1',
            type: 'image',
            fileName: 'diagram.png',
            mimeType: 'image/png',
            size: 1200,
            storageProvider: 'local',
            downloadUrl: '/api/v1/class-sessions/session-1/chat/attachments/image-1'
          },
          {
            id: 'link-1',
            type: 'link',
            title: 'Reference',
            url: 'https://example.test/reference'
          }
        ],
        shadowMuted: false,
        deliveryState: 'delivered',
        createdAt: '2026-06-22T10:05:00.000Z'
      }
    ]);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const attachments = root.querySelectorAll('.message-attachment');
    expect(attachments.length).toBe(2);
    expect(attachments[0]?.textContent).toContain('diagram.png');
    expect(attachments[1]?.textContent).toContain('Reference');
  });

  it('uploads file attachments before sending chat with attachment ids only', async () => {
    classSessions.uploadChatAttachments.and.returnValue(
      of([
        {
          id: 'attachment-1',
          attachmentId: 'attachment-1',
          type: 'pdf',
          fileName: 'lesson.pdf',
          title: 'lesson.pdf',
          mimeType: 'application/pdf',
          size: 5,
          storageProvider: 'local'
        }
      ])
    );
    socketService.emitAck.and.returnValue(
      Promise.resolve({
        id: 'message-1',
        sessionId: 'session-1',
        roomId: 'room-1',
        senderId: 'teacher-participant',
        senderName: 'Teacher One',
        senderRole: 'teacher',
        recipientId: 'student-participant',
        scope: 'private',
        message: '',
        attachments: [
          {
            id: 'attachment-1',
            attachmentId: 'attachment-1',
            type: 'pdf',
            fileName: 'lesson.pdf',
            mimeType: 'application/pdf',
            size: 5,
            storageProvider: 'local'
          }
        ],
        shadowMuted: false,
        deliveryState: 'sent',
        createdAt: '2026-06-22T10:05:00.000Z'
      })
    );
    fixture.componentRef.setInput('batchId', 'batch-1');
    fixture.componentRef.setInput('live', true);
    fixture.componentRef.setInput('joined', true);
    fixture.detectChanges();

    const component = fixture.componentInstance as unknown as {
      addFileAttachment(file: File): Promise<void>;
      sendMessage(event?: Event): void;
    };
    const file = new File(['hello'], 'lesson.pdf', { type: 'application/pdf' });
    await component.addFileAttachment(file);
    component.sendMessage(new Event('submit'));

    const sendCall = socketService.emitAck.calls.allArgs().find(([event]) => event === 'chat:send');
    const request = sendCall?.[1] as { attachments?: Array<{ attachmentId?: string; dataUrl?: string; fileName?: string; type?: string }> };
    expect(classSessions.uploadChatAttachments).toHaveBeenCalledWith('session-1', [file], { batchId: 'batch-1' });
    expect(request.attachments?.[0]).toEqual(
      jasmine.objectContaining({
        attachmentId: 'attachment-1',
        fileName: 'lesson.pdf',
        type: 'pdf'
      })
    );
    expect(request.attachments?.[0]?.dataUrl).toBeUndefined();
  });
});
