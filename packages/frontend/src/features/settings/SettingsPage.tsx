import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ClientAccess, Repository, ReviewPullRequest } from '@cms/shared';
import {
  createClient,
  deleteClient,
  listClients,
  listRepositories,
  listReviewPullRequests,
  closeReviewPullRequest,
  mergeReviewPullRequest,
  resetClientPassword,
  revokeClient,
  setClientApproval,
  updateClientLanguage,
} from '@/api';
import { useAuth } from '@/services/auth';
import { ApiClientError } from '@/api/client';
import { useI18n, fmt, type Locale } from '@/i18n';
import './Settings.css';
import { HostingPlatformsCard } from './HostingPlatformsCard';
import { Card } from '@/ui/components/Card';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { ErrorBanner } from '@/ui/components/ErrorBanner';
import { Modal } from '@/ui/components/Modal';
import { Spinner } from '@/ui/components/Spinner';

/** One-time credentials shown after create / password reset. */
type Credentials = { clientId: string; password: string };

/** Pending destructive confirmation. */
type PendingAction =
  | { kind: 'revoke' | 'delete'; access: ClientAccess }
  | { kind: 'reject'; pull: ReviewPullRequest };

/**
 * Settings page: client access management (admin only).
 *
 * The administrator creates access ID + password pairs linked to one
 * repository, and can reset passwords, revoke, or delete accesses.
 * Plaintext passwords are shown exactly once (create / reset).
 */
export function SettingsPage() {
  const { m, locale } = useI18n();
  const { isLoading: authLoading, isAuthenticated, isAdmin, isClient, login } = useAuth();
  const [accesses, setAccesses] = useState<ClientAccess[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  // Open review pull requests (client changes awaiting approval).
  const [reviews, setReviews] = useState<ReviewPullRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state.
  const [label, setLabel] = useState('');
  const [repoValue, setRepoValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createLanguage, setCreateLanguage] = useState<Locale>(locale);

  // One-time credentials dialog.
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Pending revoke/delete confirmation.
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    if (!isAdmin) {
      setIsLoading(false);
      return;
    }
    setError(null);
    try {
      const [clients, repos, pulls] = await Promise.all([
        listClients(),
        listRepositories(),
        listReviewPullRequests().catch(() => [] as ReviewPullRequest[]),
      ]);
      setAccesses(clients);
      setRepositories(repos);
      setReviews(pulls);
      setRepoValue((current) => current || (repos.length > 0 ? `${repos[0]!.owner}/${repos[0]!.name}` : current));
    } catch {
      setError(m.settings.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [isAdmin, m]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!repoValue || !label.trim() || isCreating) return;
    const [repoOwner, repoName] = repoValue.split('/');
    setIsCreating(true);
    setError(null);
    try {
      const created = await createClient({
        repoOwner: repoOwner ?? '',
        repoName: repoName ?? '',
        label: label.trim(),
        language: createLanguage,
      });
      setCredentials({ clientId: created.access.clientId, password: created.password });
      setLabel('');
      await load();
    } catch {
      setError(m.settings.createFailed);
    } finally {
      setIsCreating(false);
    }
  };

  const handleChangeLanguage = async (access: ClientAccess, language: 'en' | 'fr') => {
    // Optimistic update; a failure rolls the row back and reloads from source.
    setAccesses((current) =>
      current.map((a) => (a.clientId === access.clientId ? { ...a, language } : a)),
    );
    try {
      const updated = await updateClientLanguage(access.clientId, language);
      setAccesses((current) =>
        current.map((a) =>
          a.clientId === updated.clientId ? { ...a, language: updated.language ?? language } : a,
        ),
      );
    } catch {
      // Reload first (load() clears the banner), then surface the failure.
      await load();
      setError(m.settings.actionFailed);
    }
  };

  const handleResetPassword = async (access: ClientAccess) => {
    setError(null);
    try {
      const { password } = await resetClientPassword(access.clientId);
      setCredentials({ clientId: access.clientId, password });
      await load();
    } catch {
      setError(m.settings.resetFailed);
    }
  };

  /** Toggles review mode (saves wait for approval) for one access. */
  const handleToggleApproval = async (access: ClientAccess, requireApproval: boolean) => {
    // Optimistic update; a failure rolls the row back and reloads.
    setAccesses((current) =>
      current.map((a) => (a.clientId === access.clientId ? { ...a, requireApproval } : a)),
    );
    try {
      const updated = await setClientApproval(access.clientId, requireApproval);
      setAccesses((current) =>
        current.map((a) =>
          a.clientId === updated.clientId ? { ...a, requireApproval: updated.requireApproval } : a,
        ),
      );
    } catch {
      await load();
      setError(m.settings.actionFailed);
    }
  };

  /** Approves a pending change: merges it and publishes. */
  const handleApprove = async (pull: ReviewPullRequest) => {
    setError(null);
    try {
      const result = await mergeReviewPullRequest(pull.owner, pull.repo, pull.number);
      if (result.failures.length > 0) {
        setError(m.settings.reviewApprovePublishFailed);
      }
      await load();
    } catch (error) {
      // Only a real conflict gets the resolve-on-GitHub explanation;
      // anything else is a transient failure worth a plain retry.
      if (error instanceof ApiClientError && error.code === 'review_conflict') {
        setError(m.settings.reviewApproveFailed);
      } else {
        setError(m.settings.actionFailed);
      }
    }
  };

  /** Rejects a pending change (confirmed via dialog): closes it and resets the branch. */
  const handleReject = async (pull: ReviewPullRequest) => {
    setError(null);
    try {
      await closeReviewPullRequest(pull.owner, pull.repo, pull.number);
      await load();
    } catch {
      setError(m.settings.reviewRejectFailed);
    } finally {
      setPending(null);
    }
  };

  const handleConfirm = async () => {
    if (!pending) return;
    if (pending.kind === 'reject') {
      await handleReject(pending.pull);
      return;
    }
    setError(null);
    try {
      if (pending.kind === 'revoke') {
        await revokeClient(pending.access.clientId);
      } else {
        await deleteClient(pending.access.clientId);
      }
      await load();
    } catch {
      setError(m.settings.actionFailed);
    } finally {
      setPending(null);
    }
  };

  const copy = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the value stays visible.
    }
  };

  if (authLoading) return <Spinner />;
  if (!isAuthenticated) {
    return (
      <section className="auth-card">
        <h2>{m.auth.signInToStartTitle}</h2>
        <p>{m.auth.signInToStartBody}</p>
        <button type="button" className="btn btn--primary" onClick={login}>
          {m.header.signInGithub}
        </button>
        <Link className="auth-card__client-link" to="/login">
          {m.auth.clientLink}
        </Link>
      </section>
    );
  }

  if (isClient) {
    return (
      <section className="page">
        <h2>{m.settings.title}</h2>
        <p className="page-status">{m.settings.adminOnly}</p>
      </section>
    );
  }

  return (
    <section className="page page--centered">
      <div className="page__header">
        <h2>{m.settings.title}</h2>
      </div>

      <HostingPlatformsCard />

      <h3>{m.settings.reviewHeading}</h3>
      <p className="page-status">{m.settings.reviewIntro}</p>

      {!isLoading && reviews.length > 0 && (
        <Card className="settings-card">
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>{m.settings.colLabel}</th>
                  <th>{m.settings.colRepo}</th>
                  <th>{m.settings.reviewColChange}</th>
                  <th>{m.settings.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((pull) => (
                  <tr key={`${pull.owner}/${pull.repo}#${pull.number}`}>
                    <td>{pull.label ?? pull.branch}</td>
                    <td>
                      {pull.owner}/{pull.repo}
                    </td>
                    <td>
                      <a href={pull.url} target="_blank" rel="noreferrer">
                        {m.settings.reviewView}
                      </a>
                    </td>
                    <td className="settings-table__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => void handleApprove(pull)}
                      >
                        {m.settings.reviewApprove}
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => setPending({ kind: 'reject', pull })}
                      >
                        {m.settings.reviewReject}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {!isLoading && reviews.length === 0 && <p className="page-status">{m.settings.reviewEmpty}</p>}

      <h3>{m.settings.clientsHeading}</h3>
      <p className="page-status">{m.settings.clientsIntro}</p>
      {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <Card className="settings-card">
            <h4>{m.settings.createHeading}</h4>
            <div className="settings-form">
              <label className="settings-form__field">
                <span>{m.settings.labelField}</span>
                <input
                  type="text"
                  value={label}
                  maxLength={60}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label className="settings-form__field">
                <span>{m.settings.repoField}</span>
                <select value={repoValue} onChange={(event) => setRepoValue(event.target.value)}>
                  {repositories
                    .filter((repo) => repo.hasHtml !== false)
                    .map((repo) => (
                      <option key={repo.fullName} value={`${repo.owner}/${repo.name}`}>
                        {repo.fullName}
                      </option>
                    ))}
                </select>
              </label>
              <div className="settings-form__field">
                <span>{m.settings.colLanguage}</span>
                <div
                  className="settings-language"
                  role="group"
                  aria-label={m.settings.colLanguage}
                >
                  <button
                    type="button"
                    className={`settings-language__btn${createLanguage === 'fr' ? ' settings-language__btn--active' : ''}`}
                    aria-pressed={createLanguage === 'fr'}
                    onClick={() => setCreateLanguage('fr')}
                  >
                    FR
                  </button>
                  <button
                    type="button"
                    className={`settings-language__btn${createLanguage === 'en' ? ' settings-language__btn--active' : ''}`}
                    aria-pressed={createLanguage === 'en'}
                    onClick={() => setCreateLanguage('en')}
                  >
                    EN
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleCreate()}
                disabled={isCreating || !label.trim() || !repoValue}
              >
                {isCreating ? m.settings.creating : m.settings.createBtn}
              </button>
            </div>
          </Card>

          <Card className="settings-card">
            <h4>{m.settings.listHeading}</h4>
            {accesses.length === 0 ? (
              <p className="page-status">{m.settings.noClients}</p>
            ) : (
              <div className="settings-table-wrap">
                <table className="settings-table">
                  <thead>
                    <tr>
                      <th>{m.settings.colLabel}</th>
                      <th>{m.settings.colId}</th>
                      <th>{m.settings.colRepo}</th>
                      <th>{m.settings.colLanguage}</th>
                      <th>{m.settings.colReview}</th>
                      <th>{m.settings.colCreated}</th>
                      <th>{m.settings.colStatus}</th>
                      <th>{m.settings.colActions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accesses.map((access) => (
                      <tr key={access.clientId}>
                        <td>{access.label}</td>
                        <td>
                          <code>{access.clientId}</code>
                        </td>
                        <td>
                          {access.repo.owner}/{access.repo.repo}
                        </td>
                        <td>
                          <select
                            className="settings-language__select"
                            value={access.language ?? ''}
                            aria-label={fmt(m.settings.languageAria, { label: access.label })}
                            onChange={(event) => {
                              const value = event.target.value;
                              if (value === 'en' || value === 'fr') {
                                void handleChangeLanguage(access, value);
                              }
                            }}
                          >
                            <option className="settings-language__option--auto" value="">
                              ·
                            </option>
                            <option value="fr">FR</option>
                            <option value="en">EN</option>
                          </select>
                        </td>
                        <td>
                          <label className="settings-review-toggle">
                            <input
                              type="checkbox"
                              checked={access.requireApproval === true}
                              aria-label={fmt(m.settings.reviewToggleAria, { label: access.label })}
                              onChange={(event) =>
                                void handleToggleApproval(access, event.target.checked)
                              }
                            />
                            <span>
                              {access.requireApproval ? m.settings.reviewOn : m.settings.reviewOff}
                            </span>
                          </label>
                        </td>
                        <td>{new Date(access.createdAt).toLocaleDateString()}</td>
                        <td>
                          <span
                            className={`settings-status${access.revoked ? ' settings-status--revoked' : ' settings-status--active'}`}
                          >
                            {access.revoked ? m.settings.statusRevoked : m.settings.statusActive}
                          </span>
                        </td>
                        <td className="settings-table__actions">
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void handleResetPassword(access)}
                          >
                            {m.settings.resetPassword}
                          </button>
                          {!access.revoked && (
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setPending({ kind: 'revoke', access })}
                            >
                              {m.settings.revoke}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--danger"
                            onClick={() => setPending({ kind: 'delete', access })}
                          >
                            {m.settings.deleteAccess}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Modal
        open={credentials !== null}
        title={m.settings.credentialsTitle}
        onClose={() => setCredentials(null)}
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setCredentials(null)}>
            {m.settings.credentialsDone}
          </button>
        }
      >
        {credentials && (
          <div className="credentials">
            <p className="credentials__intro">{m.settings.credentialsIntro}</p>
            <div className="credentials__row">
              <span className="credentials__label">{m.settings.credentialsId}</span>
              <code className="credentials__value">{credentials.clientId}</code>
              <button type="button" className="btn" onClick={() => void copy('id', credentials.clientId)}>
                {copiedField === 'id' ? m.common.copied : m.common.copy}
              </button>
            </div>
            <div className="credentials__row">
              <span className="credentials__label">{m.settings.credentialsPassword}</span>
              <code className="credentials__value">{credentials.password}</code>
              <button
                type="button"
                className="btn"
                onClick={() => void copy('password', credentials.password)}
              >
                {copiedField === 'password' ? m.common.copied : m.common.copy}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'delete'
            ? m.settings.confirmDeleteTitle
            : pending?.kind === 'reject'
              ? m.settings.confirmRejectTitle
              : m.settings.confirmRevokeTitle
        }
        message={
          pending?.kind === 'delete'
            ? m.settings.confirmDeleteMsg
            : pending?.kind === 'reject'
              ? m.settings.confirmRejectMsg
              : m.settings.confirmRevokeMsg
        }
        confirmLabel={
          pending?.kind === 'delete'
            ? m.common.delete
            : pending?.kind === 'reject'
              ? m.settings.reviewReject
              : m.settings.revoke
        }
        onConfirm={() => void handleConfirm()}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
