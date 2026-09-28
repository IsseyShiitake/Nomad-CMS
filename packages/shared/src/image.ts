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

/** Result of uploading an image to a repository. */
export interface UploadImageResult {
  /** Whether the upload succeeded. */
  success: boolean;

  /** The uploaded image metadata, if successful. */
  image: ImageAsset | null;

  /** Human-readable error message, if the upload failed. */
  error: string | null;
}