import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';
import type { ClassSessionMaterial, ClassSessionMaterialEvent, LiveClassSettings } from '@native-sfu/contracts';
import { firstValueFrom } from 'rxjs';
import { SocketService } from '../../../core/services/socket.service';
import { ClassSessionService } from '../class-session.service';

type MaterialRole = 'teacher' | 'student' | 'admin';
type MaterialEventName = 'material:shared' | 'material:unshared' | 'material:updated';

const MATERIAL_MAX_COUNT = 5;

@Component({
  selector: 'sfu-session-materials',
  standalone: true,
  templateUrl: './session-materials.html',
  styleUrl: './session-materials.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class SessionMaterials implements OnDestroy {
  private readonly classSessions = inject(ClassSessionService);
  private readonly socket = inject(SocketService);
  private readonly socketDisposers: Array<() => void> = [];
  private loadKey = '';

  readonly sessionId = input('');
  readonly batchId = input('');
  readonly role = input<MaterialRole>('student');
  readonly live = input(false);
  readonly joined = input(false);
  readonly compact = input(false);
  readonly materialSettings = input<LiveClassSettings['materials'] | null>(null);

  protected readonly materials = signal<ClassSessionMaterial[]>([]);
  protected readonly loading = signal(false);
  protected readonly uploading = signal(false);
  protected readonly pendingMaterialId = signal('');
  protected readonly error = signal('');
  protected readonly linkTitle = signal('');
  protected readonly linkUrl = signal('');
  protected readonly linkOpen = signal(false);

  protected readonly canManage = computed(() => this.role() === 'teacher' || this.role() === 'admin');
  protected readonly materialsEnabled = computed(() => this.materialSettings()?.materialsEnabled !== false);
  protected readonly canUpload = computed(() => this.canManage() && this.materialsEnabled() && this.materialSettings()?.teacherCanUploadMaterials !== false);
  protected readonly canDownload = computed(() => this.canManage() || this.materialSettings()?.studentsCanDownloadMaterials !== false);
  protected readonly maxFileSizeMb = computed(() => this.materialSettings()?.maxMaterialFileSizeMb ?? 10);
  protected readonly acceptTypes = computed(() => {
    const allowed = this.materialSettings()?.allowedMaterialTypes ?? ['pdf', 'image', 'document', 'slides', 'link', 'file'];
    const mimeTypes: string[] = [];
    if (allowed.includes('pdf')) mimeTypes.push('application/pdf');
    if (allowed.includes('image')) mimeTypes.push('image/*');
    if (allowed.includes('document')) mimeTypes.push('.doc,.docx,text/plain');
    if (allowed.includes('slides')) mimeTypes.push('.ppt,.pptx');
    if (allowed.includes('file')) mimeTypes.push('*/*');
    return mimeTypes.join(',');
  });
  protected readonly sharedMaterial = computed(() => this.materials().find((material) => material.shared) ?? null);
  protected readonly sortedMaterials = computed(() =>
    [...this.materials()].sort((left, right) => Number(right.shared) - Number(left.shared) || right.createdAt.localeCompare(left.createdAt))
  );

  constructor() {
    this.registerSocketHandlers();
    effect(() => {
      const sessionId = this.sessionId();
      const batchId = this.batchId();
      const key = sessionId ? `${sessionId}:${batchId}` : '';
      if (!key || key === this.loadKey) {
        return;
      }
      this.loadKey = key;
      void this.loadMaterials();
    });
  }

  ngOnDestroy(): void {
    for (const dispose of this.socketDisposers.splice(0)) {
      dispose();
    }
  }

  protected async loadMaterials(): Promise<void> {
    const sessionId = this.sessionId();
    if (!sessionId) {
      return;
    }
    this.loading.set(true);
    this.error.set('');
    try {
      const materials = await firstValueFrom(this.classSessions.listMaterials(sessionId, { batchId: this.batchId() || undefined }));
      this.materials.set(materials);
    } catch (error) {
      this.error.set(this.classSessions.errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected async uploadFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const files = Array.from(input?.files ?? []).slice(0, MATERIAL_MAX_COUNT);
    if (input) {
      input.value = '';
    }
    if (!files.length || !this.canUpload()) {
      return;
    }
    const maxBytes = this.maxFileSizeMb() * 1024 * 1024;
    const oversized = files.find((file) => file.size > maxBytes);
    if (oversized) {
      this.error.set(`Class materials cannot exceed ${this.maxFileSizeMb()} MB.`);
      return;
    }
    const sessionId = this.sessionId();
    if (!sessionId) {
      return;
    }
    this.uploading.set(true);
    this.error.set('');
    try {
      const uploaded = await firstValueFrom(this.classSessions.uploadMaterials(sessionId, files, { batchId: this.batchId() || undefined }));
      this.upsertMaterials(uploaded);
    } catch (error) {
      this.error.set(this.classSessions.errorMessage(error));
    } finally {
      this.uploading.set(false);
    }
  }

  protected async attachLink(): Promise<void> {
    if (!this.canUpload()) {
      return;
    }
    const sessionId = this.sessionId();
    const title = this.linkTitle().trim();
    const url = this.linkUrl().trim();
    if (!sessionId || !title || !url) {
      this.error.set('Add a title and a valid link.');
      return;
    }
    this.uploading.set(true);
    this.error.set('');
    try {
      const material = await firstValueFrom(
        this.classSessions.attachMaterialLink(sessionId, {
          batchId: this.batchId() || undefined,
          title,
          url
        })
      );
      this.upsertMaterials([material]);
      this.linkTitle.set('');
      this.linkUrl.set('');
      this.linkOpen.set(false);
    } catch (error) {
      this.error.set(this.classSessions.errorMessage(error));
    } finally {
      this.uploading.set(false);
    }
  }

  protected async share(material: ClassSessionMaterial): Promise<void> {
    await this.setShared(material, true);
  }

  protected async unshare(material: ClassSessionMaterial): Promise<void> {
    await this.setShared(material, false);
  }

  protected async archiveMaterial(material: ClassSessionMaterial): Promise<void> {
    if (!this.canManage()) {
      return;
    }
    const sessionId = this.sessionId();
    if (!sessionId) {
      return;
    }
    this.pendingMaterialId.set(material.materialId);
    this.error.set('');
    try {
      await firstValueFrom(this.classSessions.deleteMaterial(sessionId, material.materialId, { batchId: this.batchId() || undefined }));
      this.materials.update((materials) => materials.filter((item) => item.materialId !== material.materialId));
    } catch (error) {
      this.error.set(this.classSessions.errorMessage(error));
    } finally {
      this.pendingMaterialId.set('');
    }
  }

  protected async openMaterial(material: ClassSessionMaterial): Promise<void> {
    if (material.source === 'link' && material.url) {
      window.open(material.url, '_blank', 'noopener,noreferrer');
      return;
    }
    await this.download(material);
  }

  protected async download(material: ClassSessionMaterial): Promise<void> {
    if (material.source === 'link') {
      await this.openMaterial(material);
      return;
    }
    if (!this.canDownload()) {
      this.error.set('Material downloads are disabled for this class.');
      return;
    }
    const sessionId = this.sessionId();
    if (!sessionId) {
      return;
    }
    this.pendingMaterialId.set(material.materialId);
    this.error.set('');
    try {
      const blob = await firstValueFrom(this.classSessions.downloadMaterial(sessionId, material.materialId, { batchId: this.batchId() || undefined }));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = material.fileName || material.title || 'class-material';
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.error.set(this.classSessions.errorMessage(error));
    } finally {
      this.pendingMaterialId.set('');
    }
  }

  protected iconFor(material: ClassSessionMaterial): string {
    switch (material.kind) {
      case 'pdf':
        return 'PDF';
      case 'image':
        return 'IMG';
      case 'slides':
        return 'PPT';
      case 'document':
        return 'DOC';
      case 'link':
        return 'URL';
      default:
        return 'FILE';
    }
  }

  protected readableSize(material: ClassSessionMaterial): string {
    const size = material.size ?? 0;
    if (!size) {
      return material.source === 'link' ? 'Link' : 'File';
    }
    if (size < 1024 * 1024) {
      return `${Math.max(1, Math.round(size / 1024))} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | null)?.value ?? '';
  }

  private async setShared(material: ClassSessionMaterial, shared: boolean): Promise<void> {
    if (!this.canManage() || !this.live()) {
      return;
    }
    const sessionId = this.sessionId();
    if (!sessionId) {
      return;
    }
    this.pendingMaterialId.set(material.materialId);
    this.error.set('');
    try {
      const updated = shared
        ? await firstValueFrom(this.classSessions.shareMaterial(sessionId, material.materialId, { batchId: this.batchId() || undefined }))
        : await firstValueFrom(this.classSessions.unshareMaterial(sessionId, material.materialId, { batchId: this.batchId() || undefined }));
      this.upsertMaterials([updated], { exclusiveShared: shared });
    } catch (error) {
      this.error.set(this.classSessions.errorMessage(error));
    } finally {
      this.pendingMaterialId.set('');
    }
  }

  private registerSocketHandlers(): void {
    const handlers: Array<[MaterialEventName, (event: ClassSessionMaterialEvent) => void]> = [
      ['material:shared', (event) => this.applyMaterialEvent(event)],
      ['material:unshared', (event) => this.applyMaterialEvent(event)],
      ['material:updated', (event) => this.applyMaterialEvent(event)]
    ];
    for (const [event, handler] of handlers) {
      this.socket.on(event, handler);
      this.socketDisposers.push(() => this.socket.off(event, handler));
    }
  }

  private applyMaterialEvent(event: ClassSessionMaterialEvent): void {
    if (event.sessionId !== this.sessionId()) {
      return;
    }
    if (event.material) {
      if (event.material.deletedAt) {
        this.materials.update((materials) => materials.filter((material) => material.materialId !== event.materialId));
        return;
      }
      this.upsertMaterials([event.material], { exclusiveShared: event.shared });
      return;
    }
    void this.loadMaterials();
  }

  private upsertMaterials(materials: ClassSessionMaterial[], options: { exclusiveShared?: boolean } = {}): void {
    this.materials.update((current) => {
      const next = options.exclusiveShared ? current.map((material) => ({ ...material, shared: false, sharedAt: undefined })) : [...current];
      for (const material of materials) {
        const index = next.findIndex((item) => item.materialId === material.materialId);
        if (index >= 0) {
          next[index] = material;
        } else {
          next.unshift(material);
        }
      }
      return next;
    });
  }
}
