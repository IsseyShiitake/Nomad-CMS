import { describe, expect, it } from 'vitest';
import type { Repository } from '@cms/shared';
import { thumbnailCandidates } from './RepoTile';

/** Repository DTO with only the fields the candidate resolver reads. */
function repo(overrides: Partial<Repository>): Repository {
  return {
    id: 1,
    name: 'site',
    owner: 'octocat',
    fullName: 'octocat/site',
    defaultBranch: 'main',
    description: null,
    isPrivate: false,
    htmlUrl: 'https://github.com/octocat/site',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('thumbnailCandidates', () => {
  it('uses the project-pages convention for a plain repo', () => {
    expect(thumbnailCandidates(repo({}))).toEqual(['https://octocat.github.io/site/']);
  });

  it('uses the root URL for user/org-site repos (owner.github.io)', () => {
    const r = repo({ owner: 'isseymiitake', name: 'isseymiitake.github.io' });
    expect(thumbnailCandidates(r)).toEqual(['https://isseymiitake.github.io/']);
  });

  it('prefers a configured homepage and keeps the convention as fallback', () => {
    const r = repo({ homepage: 'https://studio.example/' });
    expect(thumbnailCandidates(r)).toEqual(['https://studio.example/', 'https://octocat.github.io/site/']);
  });

  it('ignores homepages that are the github.com repo page or garbage', () => {
    expect(thumbnailCandidates(repo({ homepage: 'https://github.com/octocat/site' }))).toEqual([
      'https://octocat.github.io/site/',
    ]);
    expect(thumbnailCandidates(repo({ homepage: 'not a url' }))).toEqual([
      'https://octocat.github.io/site/',
    ]);
  });

  it('upgrades schemeless homepages to https', () => {
    expect(thumbnailCandidates(repo({ homepage: 'studio.example' }))[0]).toBe('https://studio.example/');
  });
});
