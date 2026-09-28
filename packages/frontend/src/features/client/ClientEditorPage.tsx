import { useParams } from 'react-router';
import { Navigate } from 'react-router';
import { useAuth } from '@/services/auth';
import { useI18n } from '@/i18n';
import { Spinner } from '@/ui/components/Spinner';
import { EditorView } from '@/features/editor/EditorView';

/** Route parameters for the client editor. */
type ClientEditorRouteParams = {
  path: string;
};

/**
 * Client editor page: renders the shared EditorView for the repository
 * the client session is locked to. Owner/repo come from the session,
 * never from the URL.
 */
export function ClientEditorPage() {
  const { path = '' } = useParams<ClientEditorRouteParams>();
  const { m } = useI18n();
  const { isLoading: authLoading, isAuthenticated, isClient, repoLock } = useAuth();

  if (authLoading) return <Spinner />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!isClient || !repoLock) return <Navigate to="/repositories" replace />;

  return (
    <EditorView
      owner={repoLock.owner}
      repo={repoLock.repo}
      path={path}
      backTo="/client"
      backLabel={m.client.backToPages}
    />
  );
}
