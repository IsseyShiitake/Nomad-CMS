/**
 * Tests for the editor controller's save retry behavior.
 *
 * Invariant: when a save fails AFTER images have been uploaded (e.g. a merge
 * conflict on the HTML commit), retrying must NOT re-upload the same images —
 * otherwise every retry orphans duplicate blobs in the repository. The
 * controller caches committed image paths per save attempt so retries reuse
 * them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPage, savePage } from '@/api';
import { ApiClientError } from '@/api/client';
import type { ImageAsset } from '@cms/shared';
import type { ImageManager } from '@/services/images';
import { DomHtmlParser } from '@/services/htmlParser';
import { InMemoryEditorController } from './index';

vi.mock('@/api', () => ({
  getPage: vi.fn(),
  savePage: vi.fn(),
}));

const FIXTURE = `<!doctype html>
<html><head><title>T</title></head><body>
  <h1>Hello</h1>
  <img src="/old.png" alt="old" />
</body></html>`;

describe('InMemoryEditorController save retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not re-upload images on retry after a merge conflict', async () => {
    const counter = { count: 0 };
    const imageManager: ImageManager = {
      uploadImage: async (): Promise<ImageAsset> => {
        counter.count += 1;
        return {
          path: 'images/uploaded.png',
          name: 'uploaded.png',
          size: 10,
          mimeType: 'image/png',
          sha: 'sha',
          updatedAt: null,
        };
      },
      listImages: async () => [],
    };

    const controller = new InMemoryEditorController({
      parser: new DomHtmlParser(),
      owner: 'octocat',
      repo: 'site',
      imageManager,
    });

    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });
    const document = await controller.loadPage('index.html', 'generic');
    const img = document.elements.find((element) => element.tagName === 'img')!;
    controller.registerImageUpload(
      img.id,
      new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }),
    );

    // First save: upload succeeds, HTML commit hits a merge conflict.
    vi.mocked(savePage).mockRejectedValueOnce(
      new ApiClientError(409, 'merge_conflict', 'remote changed'),
    );
    await controller.save();
    expect(controller.saveError).toBe('merge_conflict');
    expect(counter.count).toBe(1);

    // Retry: HTML commit succeeds. The image must NOT be re-uploaded.
    vi.mocked(savePage).mockResolvedValueOnce({ success: true, sha: 'sha-2', error: null });
    await controller.save();
    expect(controller.saveError).toBeNull();
    expect(counter.count).toBe(1); // idempotent — no duplicate upload
    expect(controller.isDirty).toBe(false);

    // The committed content must reference the uploaded image path.
    const committedContent = vi.mocked(savePage).mock.calls[1]![3];
    expect(committedContent).toContain('images/uploaded.png');
  });
});

describe('InMemoryEditorController dirty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the dirty flag when a later edit fails', async () => {
    const imageManager: ImageManager = {
      uploadImage: async () => {
        throw new Error('not used');
      },
      listImages: async () => [],
    };

    const controller = new InMemoryEditorController({
      parser: new DomHtmlParser(),
      owner: 'octocat',
      repo: 'site',
      imageManager,
    });

    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });
    const document = await controller.loadPage('index.html', 'generic');
    const h1 = document.elements.find((element) => element.tagName === 'h1')!;
    const img = document.elements.find((element) => element.tagName === 'img')!;

    // A successful edit marks the document dirty.
    const ok = controller.applyEdit({ elementId: h1.id, type: 'edit-text', value: 'Changed' });
    expect(ok.error).toBeNull();
    expect(controller.isDirty).toBe(true);

    // A failed edit must NOT clear the dirty flag — otherwise the Save
    // button (disabled while !isDirty) locks the user out of saving.
    const failed = controller.applyEdit({ elementId: img.id, type: 'edit-text', value: 'x' });
    expect(failed.error).toBe('Text editing is not available for images.');
    expect(controller.isDirty).toBe(true);
    expect(controller.saveError).toBe('Text editing is not available for images.');
  });
});

describe('InMemoryEditorController save/undo race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores undo while a save is in flight (the save commits its snapshot)', async () => {
    const imageManager: ImageManager = {
      uploadImage: async () => {
        throw new Error('not used');
      },
      listImages: async () => [],
    };
    const controller = new InMemoryEditorController({
      parser: new DomHtmlParser(),
      owner: 'octocat',
      repo: 'site',
      imageManager,
    });

    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });
    const document = await controller.loadPage('index.html', 'generic');
    const h1 = document.elements.find((element) => element.tagName === 'h1')!;
    const img = document.elements.find((element) => element.tagName === 'img')!;

    // Two edits → two undo snapshots.
    controller.applyEdit({ elementId: h1.id, type: 'edit-text', value: 'First' });
    controller.applyEdit({ elementId: img.id, type: 'replace-image', value: 'images/new.png' });
    expect(controller.canUndo).toBe(true);

    // Park the save on a pending promise; undo arrives mid-flight.
    // (ES2022 lib: executor form — Promise.withResolvers is ES2024.)
    let saveResolve!: (value: never) => void;
    const saveDone = new Promise<never>((resolve) => {
      saveResolve = resolve;
    });
    vi.mocked(savePage).mockImplementationOnce(() => saveDone);
    const saving = controller.save();
    expect(controller.isSaving).toBe(true);

    controller.undo();
    // The undo is ignored while saving: the document still holds both edits
    // (what the in-flight save is committing).
    expect(controller.document?.elements.find((e) => e.id === img.id)).toBeDefined();
    expect(controller.canUndo).toBe(true);

    saveResolve({ success: true, sha: 'sha-2', error: null } as never);
    await saving;
    expect(controller.isSaving).toBe(false);
    expect(controller.isDirty).toBe(false);
  });
});
