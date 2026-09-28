/**
 * API contract types.
 *
 * These define the request/response shapes for the Cloudflare
 * Worker's HTTP endpoints. Keeping them in the shared package
 * ensures the frontend and backend agree on the wire format.
 */

import type { ImageAsset, UploadImageResult } from './image';
import type { Page, PageSummary, SavePageResult } from './page';
import type { Repository, RepositoryFile } from './repository';

/** Standard error body returned by the API. */
export interface ApiError {
  /** Machine-readable error code. */
  code: string;

  /** Human-readable error message. */
  message: string;
}

/** Standard envelope for error responses (consumed when parsing failures). */
export interface ApiErrorResponse {
  error: ApiError;
}

/** Response for GET /api/repositories. */
export type ListRepositoriesResponse = Repository[];

/** Response for GET /api/repositories/:owner/:repo/pages. */
export type ListPagesResponse = PageSummary[];

/** Response for GET /api/repositories/:owner/:repo/pages/:path. */
export type GetPageResponse = Page;

/** Response for PUT /api/repositories/:owner/:repo/pages/:path. */
export type SavePageResponse = SavePageResult;

/** Response for GET /api/repositories/:owner/:repo/images. */
export type ListImagesResponse = ImageAsset[];

/** Response for POST /api/repositories/:owner/:repo/images. */

export type UploadImageResponse = UploadImageResult;