import { useCallback, useEffect, useState, type JSX } from 'react';
import type { DeployLink } from '@cms/shared';
import { getDeployLinks } from '@/api';
import { useAuth } from '@/services/auth';
import { usePublish, describePublishError } from '@/services/publish';
import { fmt, useI18n } from '@/i18n';
import { Card } from '@/ui/components/Card';

/**
 * Publish panel: hosting-platform projects linked to one repository.
 *
 * Shows each linked project's deployment state and live URL, and — for admin
 * sessions — a Publish button that triggers production deployments on every
 * linked platform and tracks them to completion. Client sessions see the
 * state but no button (the backend enforces the same rule).
 */
export function PublishPanel({ owner, repo }: { owner: string; repo: string }) {
  const { m } = useI18n();
  const { isAdmin } = useAuth();
  const [links, setLinks] = useState<DeployLink[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const { state, publish, reset } = usePublish(owner, repo, links ?? []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      // No connections = an empty link list (the backend answers []).
      setLinks(await getDeployLinks(owner, repo));
    } catch {
      setLoadFailed(true);
    }
  }, [owner, repo]);

  useEffect(() => {
    void load();
  }, [load]);

  // After a publish cycle settles (done, failed, or the poll timed out),
  // hold the outcome for a moment, then return the chips to their own
  // per-project latest state.
  useEffect(() => {
    if (state.phase === 'done' || state.phase === 'failed' || state.phase === 'timeout') {
      const timer = setTimeout(reset, 4000);
      return () => clearTimeout(timer);
    }
  }, [state.phase, reset]);

  if (loadFailed) return null; // hosting is optional; never block the page list
  if (links === null) return null;

  /** Maps a deploy state to its localized label. */
  const stateLabel = (phase: string): string => {
    switch (phase) {
      case 'queued':
        return m.deploy.stateQueued;
      case 'building':
        return m.deploy.stateBuilding;
      case 'timeout':
        return m.deploy.stateTimeout;
      case 'success':
      case 'done':
        return m.deploy.stateSuccess;
      case 'error':
      case 'failed':
        return m.deploy.stateError;
      case 'publishing':
        return m.deploy.publishing;
      default:
        return m.deploy.stateIdle;
    }
  };


  /** One platform chip with its latest deployment state. While a publish
   * cycle runs, the first chip reflects the cycle; otherwise each chip
   * shows its own latest deployment. */
  const platformChip = (link: DeployLink, index: number): JSX.Element => {
    const cycleActive = index === 0 && state.phase !== 'idle';
    const phase = cycleActive ? state.phase : (link.latest?.state ?? 'idle');
    const isLive = phase === 'success' || phase === 'done';
    const url = cycleActive && state.url ? state.url : (link.latest?.url ?? link.url);
    return (
      <li className={`publish-chip publish-chip--${isLive ? 'live' : phase}`} key={`${link.platform}-${link.projectName}`}>
        <span className="publish-chip__name">
          {link.platform === 'cloudflare' ? m.deploy.platformCloudflare : m.deploy.platformVercel}
          {' · '}
          {link.projectName}
        </span>
        <span className="publish-chip__state">{stateLabel(phase)}</span>
        {isLive && url && (
          <a className="publish-chip__url" href={url} target="_blank" rel="noreferrer">
            {fmt(m.deploy.liveAt, { url })}
          </a>
        )}
      </li>
    );
  };

  if (links.length === 0) {
    return isAdmin ? (
      <Card className="publish-panel">
        <h4>{m.deploy.publishHeading}</h4>
        <p className="page-status">{m.deploy.notLinked}</p>
      </Card>
    ) : null;
  }

  return (
    <Card className="publish-panel">
      <h4>{m.deploy.publishHeading}</h4>
      <p className="page-status">{m.deploy.publishIntro}</p>
      <ul className="publish-list">{links.map(platformChip)}</ul>
      {isAdmin && (
        <button
          type="button"
          className="btn btn--primary publish-panel__btn"
          onClick={() => void publish()}
          disabled={state.isBusy}
        >
          {state.isBusy ? m.deploy.publishing : m.deploy.publish}
        </button>
      )}
      {state.phase === 'failed' && state.error && (
        <p className="page-status publish-panel__error">{describePublishError(state.error, m)}</p>
      )}
    </Card>
  );
}
