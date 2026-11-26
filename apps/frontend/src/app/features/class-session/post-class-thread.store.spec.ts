import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import type { ChatHistoryResponse, ChatMessage } from '@native-sfu/contracts';
import { ClassSessionService } from './class-session.service';
import { PostClassThreadStore } from './post-class-thread.store';

describe('private post-class thread refresh', () => {
  let store: PostClassThreadStore;
  let api: jasmine.SpyObj<ClassSessionService>;
  let page: { visibilityState: string; defaultView: { innerHeight: number } };
  const target = (id: string) => ({ sessionId: 'session', batchId: 'batch', roomId: 'room', participantId: id, visible: () => true });
  const message = (id: string) => ({ id, createdAt: '2026-11-26T07:00:00.000Z', message: id } as ChatMessage);
  beforeEach(() => {
    jasmine.clock().install();
    api = jasmine.createSpyObj('ClassSessionService', ['getPostClassChatHistory', 'markChatRead']);
    api.getPostClassChatHistory.and.returnValue(of({ messages: [] }));
    api.markChatRead.and.returnValue(of({} as any));
    page = { visibilityState: 'visible', defaultView: { innerHeight: 800 } };
    TestBed.configureTestingModule({ providers: [PostClassThreadStore, { provide: ClassSessionService, useValue: api }, { provide: DOCUMENT, useValue: page }] });
    store = TestBed.inject(PostClassThreadStore);
  });
  afterEach(() => { store.close(); jasmine.clock().uninstall(); });

  it('cancels an old private request before switching to another student', () => {
    const old = new Subject<ChatHistoryResponse>();
    api.getPostClassChatHistory.and.returnValues(old, of({ messages: [message('student-two')] }));
    store.open(target('one')); jasmine.clock().tick(0);
    expect(old.observed).toBeTrue();
    store.open(target('two')); jasmine.clock().tick(0);
    expect(old.observed).toBeFalse();
    old.next({ messages: [message('private-student-one')] });
    expect(store.messages().map(item => item.id)).toEqual(['student-two']);
    store.close();
  });

  it('skips hidden pages and threads and never overlaps history requests', () => {
    const pending = new Subject<ChatHistoryResponse>();
    api.getPostClassChatHistory.and.returnValue(pending);
    let visible = false;
    store.open({ ...target('one'), visible: () => visible }); jasmine.clock().tick(0);
    expect(api.getPostClassChatHistory).not.toHaveBeenCalled();
    visible = true; page.visibilityState = 'hidden'; jasmine.clock().tick(5000);
    expect(api.getPostClassChatHistory).not.toHaveBeenCalled();
    page.visibilityState = 'visible'; jasmine.clock().tick(5000); jasmine.clock().tick(5000);
    expect(api.getPostClassChatHistory).toHaveBeenCalledTimes(1);
    store.close(); expect(pending.observed).toBeFalse();
  });

  it('preserves a newly sent message when an earlier poll finishes later', () => {
    const pending = new Subject<ChatHistoryResponse>();
    api.getPostClassChatHistory.and.returnValue(pending);
    store.open(target('one'), [message('question')]); jasmine.clock().tick(5000);
    store.append(message('new-reply'));
    pending.next({ messages: [message('question')] }); pending.complete();
    expect(store.messages().map(item => item.id)).toEqual(['question', 'new-reply']);
    store.close();
  });

  it('marks only rendered visible messages read and does not repeat the same receipt', () => {
    store.open(target('one'), [message('question')]);
    const visible = { dataset: { messageCreatedAt: '2026-11-26T07:00:00.000Z' }, getBoundingClientRect: () => new DOMRect(0, 10, 100, 30) };
    const offscreen = { dataset: { messageCreatedAt: '2026-11-26T08:00:00.000Z' }, getBoundingClientRect: () => new DOMRect(0, 1000, 100, 30) };
    const container = { getBoundingClientRect: () => new DOMRect(0, 0, 100, 200), querySelectorAll: () => [visible, offscreen] } as unknown as HTMLElement;
    store.markVisibleRead(container); store.markVisibleRead(container);
    expect(api.markChatRead).toHaveBeenCalledOnceWith('session', { batchId: 'batch', roomId: 'room', participantId: 'one', scope: 'private', readAt: '2026-11-26T07:00:00.000Z' });
    page.visibilityState = 'hidden'; store.markVisibleRead(container);
    expect(api.markChatRead).toHaveBeenCalledTimes(1);
  });
});
