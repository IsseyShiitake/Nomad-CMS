import { apiRequest } from './client';
import type {
  ImageAsset,
  ListImagesResponse,
  UploadImageResponse,
} from '@cms/shared';

/**
 * Image API endpoints.
 *
 * Images are binary assets stored in the repository. The backend handles the
 * actual upload to GitHub. Uploads use FormData, which the client passes
 * through untouched (the browser sets the multipart boundary) and unwraps the
 * `{ data }` envelope like any JSON response.
 */

/** Lists images in a repository. */
export async function listImages(owner: string, repo: string): Promise<ImageAsset[]> {
  return apiRequest<ListImagesResponse>(`/api/repositories/${owner}/${repo}/images`, {});
}

/** Uploads an image to a repository. */
export async function uploadImage(
  owner: string,
  repo: string,
  file: File,
): Promise<UploadImageResponse> {
  const formData = new FormData();
  formData.append('file', file);

  return apiRequest<UploadImageResponse>(
    `/api/repositories/${owner}/${repo}/images`,
    {
      method: 'POST',
      body: formData,
    },
  );
}
