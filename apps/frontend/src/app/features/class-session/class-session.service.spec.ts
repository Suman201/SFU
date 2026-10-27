import { firstValueFrom, of } from 'rxjs';
import { ClassSessionService } from './class-session.service';

describe('ClassSessionService whiteboard response envelopes', () => {
  it('returns null for an unsaved board so the teacher initializes authoritative page metadata', async () => {
    const service = Object.create(ClassSessionService.prototype) as ClassSessionService;
    Object.assign(service, { http: { get: jasmine.createSpy('get').and.returnValue(of({ success: true, data: null })) } });
    expect(await firstValueFrom(service.getWhiteboardMemory('session', { batchId: 'batch' }))).toBeNull();
  });

  it('returns the saved whiteboard from a populated response envelope', async () => {
    const service = Object.create(ClassSessionService.prototype) as ClassSessionService;
    const memory = { snapshotVersion: 1, lastOperationSeq: 2, snapshot: { schemaVersion: 1, pages: [] } };
    Object.assign(service, { http: { get: jasmine.createSpy('get').and.returnValue(of({ success: true, data: memory })) } });
    expect(await firstValueFrom(service.getWhiteboardMemory('session'))).toEqual(memory as any);
  });
});
