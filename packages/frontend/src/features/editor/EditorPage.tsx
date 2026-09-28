import { useParams } from 'react-router';
import { useI18n } from '@/i18n';
import { EditorView } from './EditorView';

/** Route parameters for the editor. */
type EditorRouteParams = {
  owner: string;
  repo: string;
  path: string;
};

/**
 * Admin editor page: thin wrapper around the shared EditorView that reads
 * owner/repo/path from the route.
 */
export function EditorPage() {
  const { owner = '', repo = '', path = '' } = useParams<EditorRouteParams>();
  const { m } = useI18n();

  return (
    <EditorView
      owner={owner}
      repo={repo}
      path={path}
      backTo={`/repositories/${owner}/${repo}/pages`}
      backLabel={m.pages.htmlFiles}
    />
  );
}
