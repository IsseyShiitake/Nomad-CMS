import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError, publishRepository, getDeployStatus } from '@/api';
import type { DeployLink, DeployState } from '@cms/shared';

/**
 * Publish pipeline for one repository.
 *
 * Trigger production deployments on every linked platform project and poll
 * the deployment state until it settles (success/error) or the timeout
 * elapses. Unmount-safe: polling stops when the consumer unmounts and late
 * trigger responses are ignored.
 */

/** The tracked state of one publishing cycle. */
export type PublishPhase =
  | 'idle'
  | 'publishing'
  | 'queued'
  | 'building'
  | 'done'
  | 'failed'
  | 'timeout';

/** Everything the UI needs to render the publish panel. */
export interface PublishState {
  /** Lifecycle phase of the current publishing cycle. */
  phase: PublishPhase;
  /** Live URL of the (settled or settling) deployment, when known. */
  url: string | null;
  /** Human-readable error message on failure. */
  error: string | null;
  /** True while a publish call or poll is in flight. */
  isBusy: boolean;
}

/** Idle state constant shared by every reset path. */
const IDLE: PublishState = { phase: 'idle', url: null, error: null, isBusy: false };

/** Poll cadence for deployment state (platforms build for tens of seconds). */
const POLL_INTERVAL_MS = 5000;

/** Give up polling after this long (the platform finishes regardless). */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Settled deployment states that stop polling. */
const SETTLED: DeployState[] = ['success', 'error', 'canceled'];

/**
 * Publish pipeline for one repository.
 *
 * Trigger production deployments on every linked platform project and poll
 * the deployment state until it settles (success/error) or the timeout
 * elapses. Unmount-safe: polling stops when the consumer unmounts and late
 * trigger responses are ignored.
 *
 * Failure reasons are stored as machine codes (or raw passthrough
 * messages); `describePublishError` maps them to localized copy at render.
 */
export function usePublish(
  owner: string,
  repo: string,
  links: DeployLink[],
): {
  state: PublishState;
  publish: () => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<PublishState>(IDLE);
  /** False once the consuming component unmounted — stops all async work. */
  const aliveRef = useRef(true);
  /** Pending poll timer id, cleared on unmount and reset. */
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      window.clearTimeout(timerRef.current);
    };
  }, []);

  const setStateIfAlive = useCallback((next: PublishState) => {
    if (aliveRef.current) setState(next);
  }, []);

  /** Publishes the repository and polls each linked project's deployment. */
  const publish = useCallback(async () => {
    if (!aliveRef.current) return;
    setStateIfAlive({ phase: 'publishing', url: null, error: null, isBusy: true });

    let outcome;
    try {
      outcome = await publishRepository(owner, repo);
    } catch (error) {
      setStateIfAlive({
        phase: 'failed',
        url: null,
        isBusy: false,
        // Machine code, not copy: the panel maps it to a localized string.
        error:
          error instanceof ApiClientError && error.code === 'platform_token_invalid'
            ? 'platform_token_invalid'
            : error instanceof Error
              ? error.message
              : 'publish_failed',
      });
      return;
    }

    if (outcome.failures.length > 0 && outcome.deployments.length === 0) {
      setStateIfAlive({
        phase: 'failed',
        url: null,
        isBusy: false,
        error: `${outcome.failures[0]!.platform}: ${outcome.failures[0]!.error}`,
      });
      return;
    }


    // Track the first deployment to a settled state; the live URL comes from
    // the first linked project once its deployment succeeds.
    const started = Date.now();
    const poll = async (): Promise<void> => {
      if (!aliveRef.current) return;
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        // Distinct settled phase: the platform keeps building, but the CMS
        // stopped watching — never leave the chip on a busy-looking
        // "building" state forever.
        setStateIfAlive({ phase: 'timeout', url: null, error: null, isBusy: false });
        return;
      }
      try {
        const statuses = await getDeployStatus(owner, repo);
        const unsettled = statuses.filter(
          (s) => s.latest && !SETTLED.includes(s.latest.state),
        );
        const success = statuses.find((s) => s.latest?.state === 'success');
        const failure = statuses.find((s) => s.latest?.state === 'error');
        if (failure && !unsettled.length) {
          setStateIfAlive({ phase: 'failed', url: failure.latest?.url ?? null, error: 'deployment_failed', isBusy: false });
          return;
        }
        if (success && !unsettled.length) {
          setStateIfAlive({ phase: 'done', url: success.latest?.url ?? null, error: null, isBusy: false });
          return;
        }
        setStateIfAlive({
          phase: unsettled.some((s) => s.latest?.state === 'building') ? 'building' : 'queued',
          url: success?.latest?.url ?? null,
          error: null,
          isBusy: true,
        });
        timerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        // Transient polling failure: keep waiting rather than failing the cycle.
        timerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    await poll();
  }, [owner, repo, setStateIfAlive]);

  /** Returns to the idle phase. */
  const reset = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setStateIfAlive(IDLE);
  }, [setStateIfAlive]);

  // Seed the live URL from the resolved links while idle (e.g. after mount).
  useEffect(() => {
    if (state.phase !== 'idle') return;
    const live = links.find((link) => link.latest?.state === 'success');
    if (live?.url) {
      setState((current) =>
        current.phase === 'idle' ? { ...current, url: live.url! } : current,
      );
    }
  }, [links, state.phase]);

  return { state, publish, reset };
}

/**
 * Maps a publish failure code to a localized message. Raw passthrough
 * strings (platform error details) render as-is.
 */
export function describePublishError(
  error: string | null,
  m: { deploy: { platformTokenRejected: string; deploymentFailed: string } },
): string | null {
  if (error == null) return null;
  if (error === 'platform_token_invalid') return m.deploy.platformTokenRejected;
  if (error === 'deployment_failed') return m.deploy.deploymentFailed;
  return error;
}
