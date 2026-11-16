/**
 * Image management domain types.
 *
 * Images are binary assets stored in the repository (e.g. under
 * an /images directory). The backend handles uploads and returns
 * metadata; the frontend image module manages the UI around them.
 */

/** Metadata for an image stored in a repository. */
export interface ImageAsset {
  /** Repository-relative path, e.g. "images/hero.png". */
  path: string;

  /** File name, e.g. "hero.png". */
  name: string;

  /** Size in bytes. */
  size: number;

  /** MIME type, e.g. "image/png". */
  mimeType: string;

  /** SHA of the file blob, used for updates. */
  sha: string | null;

  /** When the image was last modified. */
  updatedAt: string | null;
}

/**
 * The editor's template placeholder image src.
 *
 * Shared so the backend save route can enforce the same placeholder guard
 * the editor applies client-side (a committed placeholder is a guaranteed
 * 404 on the live site). Server-side the double-quoted and single-quoted
 * attribute forms are both rejected; see findPlaceholderContent in the
 * repositories route.
 */
export const CMS_PLACEHOLDER_IMAGE_SRC = '/images/placeholder.png';

/** Result of uploading an image to a repository. */
export interface UploadImageResult {
  /** Whether the upload succeeded. */
  success: boolean;

  /** The uploaded image metadata, if successful. */
  image: ImageAsset | null;

  /** Human-readable error message, if the upload failed. */
  error: string | null;
}