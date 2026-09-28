/**
 * Tests for the publish hook.
 *
 * Verifies the lifecycle: a successful publish call followed by polling to
 * the settled success state with the live URL surfaced; a failed publish
 * (token rejected) mapping to the failed phase with a reconnect hint; and
 * the idle seeding of the live URL from resolved links.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, getDeployStatus, publishRepository } from '@/api';
import type { DeployLink } from '@cms/shared';
import type { PublishOutcome } from '@/api';
import { usePublish } from './index';
vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishRepository: vi.fn(),
  getDeployStatus: vi.fn(),
}));

const LINKS: DeployLink[] = [
  {
    platform: 'cloudflare',
    projectName: 'site',
    mode: 'git',
    url: 'https://site.pages.dev',
    latest: { id: 'd1', state: 'success', url: 'https://site.pages.dev', message: null, createdAt: null },
  },
];

/**
 * Probe component that hands the hook's controls to the test on every
 * render — the captured object is always the freshest state snapshot.
 */
function PublishProbe({ onControls }: { onControls: (c: ReturnType<typeof usePublish>) => void }) {
  const controls = usePublish('octocat', 'site', LINKS);
  onControls(controls);
  return null;
}

/** Renders the probe and returns a stable accessor for the latest controls. */
function mountProbe(): () => ReturnType<typeof usePublish> {
  let current!: ReturnType<typeof usePublish>;
  render(<PublishProbe onControls={(c) => (current = c)} />);
  return () => current;
}

describe('usePublish', () => {
  beforeEach(() => {
    vi.mocked(publishRepository).mockReset();
    vi.mocked(getDeployStatus).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('publishes and polls to a settled success with the live URL', async () => {
    vi.mocked(publishRepository).mockResolvedValue({
      deployments: [{ platform: 'cloudflare', projectName: 'site', deploymentId: 'd2', state: 'queued' }],
      failures: [],
    } as PublishOutcome);
    vi.mocked(getDeployStatus).mockResolvedValue([
      {
        platform: 'cloudflare',
        projectName: 'site',
        latest: { id: 'd2', state: 'success', url: 'https://site.pages.dev', message: null, createdAt: null },
      },
    ]);

    const controls = mountProbe();

    await act(async () => {
      await controls().publish();
    });

    expect(publishRepository).toHaveBeenCalledWith('octocat', 'site');
    expect(getDeployStatus).toHaveBeenCalled();
    expect(controls().state.phase).toBe('done');
    expect(controls().state.url).toBe('https://site.pages.dev');
    expect(controls().state.isBusy).toBe(false);
  });

  it('maps a rejected platform token to the failed phase with a hint', async () => {
    vi.mocked(publishRepository).mockRejectedValue(
      new ApiClientError(401, 'platform_token_invalid', 'unauthorized'),
    );

    const controls = mountProbe();

    await act(async () => {
      await controls().publish();
    });

    expect(controls().state.phase).toBe('failed');
    expect(controls().state.error).toBe('platform_token_invalid');
    expect(getDeployStatus).not.toHaveBeenCalled();
  });

  it('seeds the live URL from resolved links while idle', async () => {
    const controls = mountProbe();
    await act(async () => {});

    expect(controls().state.phase).toBe('idle');
    expect(controls().state.url).toBe('https://site.pages.dev');
  });

  it('settles on the timeout phase (not a busy-looking building state)', async () => {
    // The poll clock starts before the first poll; one tick of the fake
    // clock past the 5-minute budget lands the cycle in 'timeout' without
    // ever reaching a settled deployment.
    vi.useFakeTimers();
    try {
      vi.mocked(publishRepository).mockResolvedValue({
        deployments: [{ platform: 'cloudflare', projectName: 'site', deploymentId: 'd2', state: 'queued' }],
        failures: [],
      } as PublishOutcome);
      vi.mocked(getDeployStatus).mockResolvedValue([
        {
          platform: 'cloudflare',
          projectName: 'site',
          latest: { id: 'd2', state: 'building', url: null, message: null, createdAt: null },
        },
      ]);

      const controls = mountProbe();
      await act(async () => {
        const pending = controls().publish();
        // Advance past POLL_TIMEOUT_MS plus one poll interval: the poll at
        // the 5-minute boundary itself is not yet "past" the budget, the
        // next one (5s later) settles the cycle in 'timeout'.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10_000);
        await pending;
      });

      expect(controls().state.phase).toBe('timeout');
      expect(controls().state.isBusy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
