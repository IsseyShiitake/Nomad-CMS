/**
 * Vercel-direct storage adapter.
 *
 * Presents a Vercel direct-upload project (no Git repository) through the
 * same repository operations the CMS's page flow uses. Files live in the
 * project's latest production deployment; a save uploads the changed file
 * to Vercel's content-addressed store and creates a new deployment whose
 * manifest references every file — the old deployment's files carry over by
 * digest, so unchanged files are not re-uploaded.
 */

import type {
  DeployProject,
  PageSummary,
  Repository,
  RepositoryFile,
} from '@cms/shared';
import { VercelClient } from './vercel';

/** Hex SHA-1 digest of the bytes (Vercel's content addressing). */
async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Maps a Vercel direct project to the shared Repository shape.
 *
 * The id is a stable negative hash of `vercel/<name>` — negative so it can
 * never collide with a real GitHub numeric id, stable so React keys and
 * list diffs stay consistent across reloads (every virtual repo used to
 * share id 0, which duplicated React keys).
 */
export function projectToRepository(project: DeployProject): Repository {
  let hash = 0;
  const fullName = `vercel/${project.name}`;
  for (let i = 0; i < fullName.length; i += 1) {
    hash = (hash * 31 + fullName.charCodeAt(i)) | 0;
  }
  return {
    id: -Math.abs(hash || 1),
    name: project.name,
    owner: 'vercel',
    fullName,
    defaultBranch: 'main',
    description: null,
    isPrivate: false,
    homepage: project.url,
    htmlUrl: project.url ?? '',
    updatedAt: project.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * Storage adapter bound to one direct project + its latest deployment.
 */
export class VercelDirectStore {
  constructor(
    private readonly client: VercelClient,
    private readonly project: DeployProject,
    private readonly latestDeploymentId: string | null,
  ) {}

  /** Flattens the latest deployment's file tree. */
  private async listFiles(): Promise<Array<{ path: string; name: string; type: 'file' | 'dir'; size: number }>> {
    if (!this.latestDeploymentId) return [];
    return this.client.listDeploymentFiles(this.latestDeploymentId);
  }

  /** Lists directory contents at a path (root when empty). */
  async listContents(path: string): Promise<RepositoryFile[]> {
    const files = await this.listFiles();
    const prefix = path ? `${path}/` : '';
    // Keep only immediate children: entries whose path starts with the
    // prefix and has exactly one more segment.
    const seen = new Map<string, RepositoryFile>();
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      if (!rest) continue;
      const segments = rest.split('/');
      if (segments.length === 1 && file.type === 'file') {
        seen.set(file.path, { path: file.path, name: segments[0]!, type: 'file', size: file.size, sha: null });
      } else if (file.type === 'dir' && segments.length >= 1) {
        const dirPath = prefix + segments.slice(0, segments.length).join('/');
        // Directories appear as their own entries in the flattened tree;
        // only emit the immediate child directory.
        if (segments.length === 1 && !seen.has(dirPath)) {
          seen.set(dirPath, { path: dirPath, name: segments[0]!, type: 'dir', size: 0, sha: null });
        }
      }
    }
    return Array.from(seen.values());
  }

  /** Lists all HTML files in the deployment. */
  async listPages(): Promise<PageSummary[]> {
    const files = await this.listFiles();
    return files
      .filter((file) => file.type === 'file' && /\.html?$/i.test(file.path))
      .map((file) => ({ path: file.path }));
  }

  /** Lists all image assets in the deployment. */
  async listImages(): Promise<Array<{ path: string; size: number }>> {
    const files = await this.listFiles();
    return files
      .filter((file) => file.type === 'file' && /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i.test(file.path))
      .map((file) => ({ path: file.path, size: file.size }));
  }

  /** Reads a file's text content from the latest deployment. */
  async readFile(path: string): Promise<{ path: string; content: string } | null> {
    if (!this.latestDeploymentId) return null;
    const uid = await this.client.deploymentFileUid(this.latestDeploymentId, path);
    if (!uid) return null;
    const bytes = await this.client.readDeploymentFile(this.latestDeploymentId, uid);
    return { path, content: new TextDecoder().decode(bytes) };
  }

  /** Reads a file's raw bytes from the latest deployment. */
  async readRawFile(path: string): Promise<Uint8Array | null> {
    if (!this.latestDeploymentId) return null;
    const uid = await this.client.deploymentFileUid(this.latestDeploymentId, path);
    if (!uid) return null;
    return this.client.readDeploymentFile(this.latestDeploymentId, uid);
  }

  /**
   * Saves one changed file and re-deploys the project.
   *
   * The manifest is rebuilt from the deployment's current files with the
   * changed path replaced; Vercel's content-addressed store deduplicates
   * unchanged files, so only the new bytes are uploaded. Binary files that
   * were never downloaded keep their manifest digest from the tree, which
   * requires the tree to carry digests — see saveWithManifest below.
   */
  async saveFile(
    path: string,
    content: string,
    message: string,
  ): Promise<{ deploymentId: string }> {
    const bytes = new TextEncoder().encode(content);
    const digest = await sha1Hex(bytes);
    await this.client.uploadFile(bytes, digest);
    return this.saveWithDigest(path, digest, bytes.byteLength, message);
  }

  /**
   * Creates the new deployment referencing the full file manifest with one
   * file replaced by an already-uploaded digest.
   */
  private async saveWithDigest(
    path: string,
    digest: string,
    size: number,
    message: string,
  ): Promise<{ deploymentId: string }> {
    if (!this.latestDeploymentId) {
      // No prior deployment: the new file is the whole site.
      const deployment = await this.client.deployDirect(
        this.project.name,
        [{ file: path, sha: digest, size }],
        message,
      );
      return { deploymentId: deployment.id };
    }
    // The tree's flat entries do not expose digests; re-fetching per file
    // would be N calls. Vercel's deployDirect manifest tolerates sha-less
    // reference entries (only `file` is required), so carry paths over and
    // let the platform resolve them from the previous deployment's files.
    const files = await this.listFiles();
    const manifest: Array<{ file: string; sha?: string; size?: number }> = files
      .filter((file) => file.type === 'file')
      .map((file) =>
        file.path === path
          ? { file: file.path, sha: digest, size }
          : { file: file.path },
      );
    if (!manifest.some((entry) => entry.file === path)) {
      manifest.push({ file: path, sha: digest, size });
    }
    const deployment = await this.client.deployDirect(this.project.name, manifest, message);
    return { deploymentId: deployment.id };
  }

  /** Uploads a binary image and re-deploys (same manifest logic as save). */
  async uploadImage(
    path: string,
    bytes: Uint8Array,
    message: string,
  ): Promise<{ deploymentId: string }> {
    const digest = await sha1Hex(bytes);
    await this.client.uploadFile(bytes, digest);
    return this.saveWithDigest(path, digest, bytes.byteLength, message);
  }
}
