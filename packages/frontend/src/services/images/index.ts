/**
 * Image management module.
 *
 * Manages image assets within a repository. Uploads are proxied
 * through the backend so the frontend never holds GitHub
 * credentials. The manager surfaces upload failures as thrown
 * errors so the editor can react (e.g. keep the previous src).
 */

import type { ImageAsset } from '@cms/shared';
import { listImages as apiListImages, uploadImage as apiUploadImage } from '@/api';

/** Operations the image manager exposes to the UI. */
export interface ImageManager {
  /** Lists images in a repository. */
  listImages(owner: string, repo: string): Promise<ImageAsset[]>;

  /** Uploads an image to a repository and returns the committed asset. */
  uploadImage(owner: string, repo: string, file: File): Promise<ImageAsset>;
}

/**
 * Backend-backed image manager.
 *
 * Uses the CMS API to list and upload images. Upload failures
 * (including merge conflicts) are thrown as errors so callers can
 * handle them explicitly.
 */
export class ApiImageManager implements ImageManager {
  /** Lists images in a repository. */
  async listImages(owner: string, repo: string): Promise<ImageAsset[]> {
    return apiListImages(owner, repo);
  }

  /** Uploads an image and returns the committed asset. */
  async uploadImage(owner: string, repo: string, file: File): Promise<ImageAsset> {
    const result = await apiUploadImage(owner, repo, file);
    if (!result.success || !result.image) {
      throw new Error(result.error ?? 'Image upload failed.');
    }
    return result.image;
  }
}