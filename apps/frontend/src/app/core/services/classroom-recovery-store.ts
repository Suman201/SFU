/** IndexedDB keeps pending lesson work across app/browser restarts without exposing it to other accounts. */
export class ClassroomRecoveryStore {
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('native-sfu-classroom-recovery', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('work', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { this.database = undefined; reject(request.error); };
    });
  }
  async put<T>(key: string, value: T): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('work', 'readwrite');
      tx.objectStore('work').put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Unable to save lesson work on this device.'));
    });
  }
  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('work').objectStore('work').get(key);
      request.onsuccess = () => resolve(request.result?.value as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('work').objectStore('work').getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async remove(key: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('work', 'readwrite');
      tx.objectStore('work').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
}
