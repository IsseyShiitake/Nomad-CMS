import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router';
import type { Messages } from '@/i18n';
import { encodePath } from '@cms/shared';
import type { EditOperation, EditableElement, InsertableTag, ScanMode } from '@/services/htmlParser';
import { DomHtmlParser } from '@/services/htmlParser';
import { ApiClientError, getDeployLinks, publishRepository } from '@/api';
import { config } from '@/config';
import { fmt, useI18n } from '@/i18n';
import { useAuth } from '@/services/auth';
import { buildSrcDoc } from '@/services/preview';
import { InMemoryEditorController } from '@/services/editorState';
import { ApiImageManager } from '@/services/images';
import { ErrorBanner } from '@/ui/components/ErrorBanner';
import { Spinner } from '@/ui/components/Spinner';
import { ElementEditor, type ElementEditorCallbacks } from './ElementEditor';
import './EditorMood.css';

// Preview device presets: fixed viewport widths scaled to fit the panel.
type DevicePreset = 'desktop' | 'tablet' | 'mobile';

// Fixed viewport widths (px). Each preset renders a true device-width page
// (desktop layout included) scaled down to fit the available panel width.
const DEVICE_WIDTHS: Record<DevicePreset, number> = {
  desktop: 1280,
  tablet: 768,
  mobile: 375,
};

// Preview viewport heights (px). The iframe renders each preset at a true
// device viewport so vh-based layouts (hero sections, full-height headers)
// resolve against a sane height instead of the preview's own.
const PREVIEW_VIEWPORT_HEIGHTS: Record<DevicePreset, number> = {
  desktop: 900,
  tablet: 1024,
  mobile: 667,
};

// Zoom bounds for the manual preview zoom controls.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

/**
 * Maps a save-error code from the controller to a localized message.
 * Parser-invariant messages (e.g. "Element not found.") pass through
 * verbatim — they are developer-facing contract strings, not UX copy.
 */
export function describeSaveError(code: string | null, m: Messages): string | null {
  if (code == null) return null;
  if (code === 'merge_conflict') return m.editor.modifiedElsewhere;
  if (code === 'rate_limited') return m.editor.saveRateLimited;
  if (code === 'file_too_large' || code === 'invalid_content' || code === 'invalid_path' || code === 'repo_too_large') {
    return m.editor.saveRejected;
  }
  if (code === 'save_failed') return m.editor.saveFailed;
  return code;
}

/** Resolves the stamped editable-element id under a preview click target. */
export function resolveClickedElementId(target: EventTarget | null): string | null {
  if (!(target && 'closest' in target)) return null;
  return (
    (target as Element).closest('[data-cms-element-id]')?.getAttribute('data-cms-element-id') ??
    null
  );
}

/**
 * Shared editor view used by both the admin editor route and the client
 * workspace. Loads the selected page's HTML through the backend proxy,
 * parses it into an editable document, and lets the user edit text,
 * replace images, delete elements, and insert elements above or below.
 * A live iframe preview renders the current page state with optional
 * editable-area highlighting and device-width presets.
 */
export function EditorView({
  owner,
  repo,
  path,
  backTo,
  backLabel,
}: {
  owner: string;
  repo: string;
  path: string;
  /** Route to return to the page list. */
  backTo: string;
  /** Label for the page-list link in the breadcrumb. */
  backLabel: string;
}) {
  const { m } = useI18n();
  const { isAuthenticated, isLoading: authLoading, isAdmin, login } = useAuth();

  // Auto-publish: after a successful save, trigger production deployments on
  // every platform linked to the repository (admin sessions only; the panel
  // on the pages list offers a manual button for everything else).
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const autoPublish = useCallback(async () => {
    if (!isAdmin) return;
    setPublishNote(m.deploy.autoPublished);
    try {
      const links = await getDeployLinks(owner, repo);
      if (links.length === 0) {
        setPublishNote(null);
        return;
      }
      const outcome = await publishRepository(owner, repo);
      const live = links.find((l) => l.url);
      setPublishNote(
        outcome.deployments.length > 0 && live?.url
          ? fmt(m.deploy.liveAt, { url: live.url })
          : m.deploy.publishing,
      );
    } catch {
      // Publishing is best-effort after a commit; the pages-list panel
      // surfaces full state. Never block the editor on it.
      setPublishNote(null);
    }
  }, [isAdmin, owner, repo, m]);

  const controller = useMemo(() => {
    if (!isAuthenticated) return null;
    return new InMemoryEditorController({
      parser: new DomHtmlParser(),
      owner,
      repo,
      imageManager: new ApiImageManager(),
    });
  }, [isAuthenticated, owner, repo]);

  const [elements, setElements] = useState<EditableElement[]>([]);
  const [sourceHtml, setSourceHtml] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  // Preview options: beacon highlighting (default on), device width, and
  // manual zoom (null = auto-fit to the panel width).
  const [highlight, setHighlight] = useState(true);
  const [device, setDevice] = useState<DevicePreset>('desktop');
  const [zoom, setZoom] = useState<number | null>(null);
  // The element the user last activated (preview click or panel row click).
  const [activeElementId, setActiveElementId] = useState<string | null>(null);
  // Element whose preview area the iframe should scroll to (set on
  // panel-initiated activations; cleared when highlighting is turned off).
  const [previewScrollId, setPreviewScrollId] = useState<string | null>(null);
  // Element mode: editable blocks by default, falling back to beacons when
  // the page has no data-editable markup.
  const [scanMode, setScanMode] = useState<ScanMode>('editable');
  const [fellBack, setFellBack] = useState(false);
  const effectiveMode: ScanMode = fellBack ? 'generic' : scanMode;

  // Same-origin asset base: preview images/CSS/fonts load through the
  // backend proxy with correct MIME types (raw.githubusercontent.com serves
  // text/plain + nosniff, which browsers refuse as stylesheets).
  // config.apiBaseUrl (empty = same-origin) keeps split-domain deployments
  // working.
  const baseHref = useMemo(() => {
    const dir = path.split('/').slice(0, -1).join('/');
    const origin = config.apiBaseUrl ? config.apiBaseUrl.replace(/\/$/, '') : window.location.origin;
    return `${origin}/api/repositories/${owner}/${repo}/raw/${dir ? `${encodePath(dir)}/` : ''}`;
  }, [owner, repo, path]);

  // Measure the preview frame to scale the fixed-width device viewport down
  // to fit while keeping a true desktop rendering.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [frameHeight, setFrameHeight] = useState(0);
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return; // jsdom has none
    const measure = () => {
      setFrameWidth(el.clientWidth);
      setFrameHeight(el.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isLoading]);

  // The i18n messages object changes identity on locale switch; the load
  // effect must NOT re-run for it (it would discard unsaved edits), so
  // reads inside effects go through this ref instead.
  const messagesRef = useRef(m);
  messagesRef.current = m;

  // Unsaved-changes guard: block client-side navigation away from a dirty
  // editor (data router blocker) and warn on hard navigation/refresh
  // (beforeunload). window.confirm keeps this a safety net without a new
  // async UI flow.
  const blocker = useBlocker(() => isDirty && !isSaving);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm(messagesRef.current.editor.unsavedPrompt)) {
        blocker.proceed();
      } else {
        blocker.reset();
      }
    }
  }, [blocker]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    if (isDirty && !isSaving) window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty, isSaving]);

  // The iframe renders each device preset at a true viewport size: the width
  // drives responsive layout; content taller than the viewport scrolls
  // inside the frame — like a miniature browser window. On the desktop
  // preset at fit zoom the viewport height adapts to the frame, so the
  // preview fills the whole frame box (padding aside) instead of leaving a
  // blank band below a fixed 900px viewport. Manual zoom and the
  // tablet/mobile presets keep their fixed heights (zoom inspection and
  // true-device vh proportions).
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** Activates an element: highlights its panel row (and centers it) and,
   * when triggered from the panel, scrolls the preview to its area. */
  const activateElement = useCallback((elementId: string, fromPanel: boolean) => {
    setActiveElementId(elementId);
    if (fromPanel) setPreviewScrollId(elementId);
  }, []);
  /** Attaches the preview click listener to the inner document — the iframe
   * element's own onClick never sees clicks inside its browsing context. */
  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return; // jsdom
    doc.addEventListener('click', (event) => {
      const id = resolveClickedElementId(event.target);
      if (id) activateElement(id, false);
    });
  }, [activateElement]);

  const presetWidth = DEVICE_WIDTHS[device];
  const availableWidth = Math.max(0, frameWidth - 16); // .5rem padding per side
  // Fit means the whole page is visible at once: no cap, scale down as far
  // as needed (and up when the panel is wider than the preset).
  const fitScale = availableWidth > 0 ? availableWidth / presetWidth : 1;
  const effectiveScale = zoom ?? fitScale;

  // Desktop at fit zoom: size the viewport so height × scale equals the
  // frame's inner height — the preview fills the frame box completely.
  const availableHeight = Math.max(0, frameHeight - 16); // .5rem padding per side
  const fitFillHeight = Math.max(
    PREVIEW_VIEWPORT_HEIGHTS.desktop,
    Math.round(availableHeight / (effectiveScale || 1)),
  );
  const iframeHeight =
    zoom === null && device === 'desktop'
      ? fitFillHeight
      : PREVIEW_VIEWPORT_HEIGHTS[device];



  // react-router already decodes route params (including %2F → /); decoding
  // again would throw on filenames containing a literal "%" and would turn a
  // literal "%2F" in a filename into a path separator.

  useEffect(() => {
    if (!controller) return;
    let cancelled = false;

    setIsLoading(true);
    setLoadError(null);
    controller
      .loadPage(path, scanMode)
      .then((document) => {
        if (cancelled) return;
        // Editable blocks are the default mode, but pages without any
        // data-editable markup would list nothing — fall back to beacons.
        if (scanMode === 'editable' && document.elements.length === 0) {
          controller.setMode('generic');
          setFellBack(true);
          const effective = controller.document!;
          setElements(effective.elements);
          setSourceHtml(effective.sourceHtml);
        } else {
          setFellBack(false);
          setElements(document.elements);
          setSourceHtml(document.sourceHtml);
        }
        setIsDirty(controller.isDirty);
        setActiveElementId(null);
        setPreviewScrollId(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // A client session whose backing GitHub token died keeps its login;
        // explain that instead of the generic load failure.
        setLoadError(
          err instanceof ApiClientError && err.code === 'backing_token_invalid'
            ? messagesRef.current.client.backingTokenInvalid
            : messagesRef.current.editor.loadFailed,
        );
        setActiveElementId(null);
        setPreviewScrollId(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [controller, path, scanMode]);

  // Debounce the live-preview iframe reload so typing does not re-render the
  // sandboxed iframe on every keystroke. The element inputs update
  // immediately (they read from `elements` state); only the preview lags.
  useEffect(() => {
    const timer = setTimeout(() => setPreviewHtml(sourceHtml), 250);
    return () => clearTimeout(timer);
  }, [sourceHtml]);

  /** Re-syncs React state from the controller's current document. */
  const syncFromController = useCallback(() => {
    const document = controller?.document;
    if (!document) return;
    setElements(document.elements);
    setSourceHtml(document.sourceHtml);
    setIsDirty(controller.isDirty);
    setSaveError(controller.saveError);
    setIsSaving(controller.isSaving);
    setCanUndo(controller.canUndo);
  }, [controller]);

  /** Applies an operation in memory and refreshes the editor state. */
  const applyAndSync = useCallback(
    (operation: EditOperation) => {
      const outcome = controller?.applyEdit(operation);
      if (outcome?.error) {
        setMessage(outcome.error);
        return;
      }
      setMessage(null);
      syncFromController();
    },
    [controller, syncFromController],
  );

  /** Registers a local image file for upload on the next save. */
  const handleImageFile = useCallback(
    (elementId: string, file: File) => {
      controller?.registerImageUpload(elementId, file);
      setMessage(m.editor.imageQueued);
      syncFromController();
    },
    [controller, syncFromController, m],
  );

  /** Saves the current document, then auto-publishes when the repo is linked.
   * The synchronous in-flight check keeps a second click from racing the
   * first save (the React isSaving state only updates after the await). */
  const handleSave = useCallback(async () => {
    if (!controller || controller.isSaving || !controller.isDirty) return;
    setMessage(null);
    setIsSaving(true);
    await controller.save();
    syncFromController();
    if (!controller.saveError) {
      setMessage(messagesRef.current.editor.saved);
      void autoPublish();
    }
  }, [controller, syncFromController, autoPublish]);

  /** Reverts the last edit operation. */
  const handleUndo = useCallback(() => {
    if (!controller) return;
    setMessage(null);
    controller.undo();
    syncFromController();
  }, [controller, syncFromController]);

  const callbacks: ElementEditorCallbacks = useMemo(
    () => ({
      onEditText: (elementId, value) =>
        applyAndSync({ elementId, type: 'edit-text', value }),
      onReplaceImage: (elementId, src) =>
        applyAndSync({ elementId, type: 'replace-image', value: src }),
      onImageFile: (elementId, file) => handleImageFile(elementId, file),
      onInsertAbove: (elementId, insertTag: InsertableTag) =>
        applyAndSync({ elementId, type: 'insert-above', value: null, insertTag }),
      onInsertBelow: (elementId, insertTag: InsertableTag) =>
        applyAndSync({ elementId, type: 'insert-below', value: null, insertTag }),
      onDelete: (elementId) =>
        applyAndSync({ elementId, type: 'delete', value: null }),
    }),
    [applyAndSync, handleImageFile],
  );

  const srcDoc = useMemo(
    () =>
      buildSrcDoc(
        previewHtml,
        baseHref,
        highlight
          ? effectiveMode === 'generic'
            ? 'h1,h2,p,img'
            : '[data-editable],[data-editable-block]'
          : null,
      ),
    [previewHtml, baseHref, highlight, effectiveMode],
  );

  // Panel-initiated activation: scroll the matching (stamped) preview area
  // into view inside the iframe. Re-runs on every srcDoc reload, so the
  // selection keeps following the element across edits.
  useEffect(() => {
    if (!previewScrollId) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return; // jsdom
    // Exact attribute match (ids embed spaces/`>`, so querySelectorAll +
    // comparison beats any selector-escaping trick).
    const target = Array.from(doc.querySelectorAll('[data-cms-element-id]')).find(
      (el) => el.getAttribute('data-cms-element-id') === previewScrollId,
    );
    target?.scrollIntoView?.({ block: 'center' });
  }, [previewScrollId, srcDoc]);

  if (authLoading) return <Spinner />;
  if (!isAuthenticated) {
    return (
      <section className="auth-card">
        <h2>{m.auth.signInToEditTitle}</h2>
        <p>{m.auth.signInToEditBody}</p>
        <button type="button" className="btn btn--primary" onClick={login}>
          {m.header.signInGithub}
        </button>
        <Link className="auth-card__client-link" to="/login">
          {m.auth.clientLink}
        </Link>
      </section>
    );
  }
  if (isLoading) return <Spinner label={m.editor.loadingPage} />;


  return (
    <section className="page editor-page">
      <p className="breadcrumb">
        <Link to={backTo}>{backLabel}</Link> / {owner}/{repo} / {path}
      </p>
      {message && <p className="page-status editor-page__message">{message}</p>}
      {loadError && <ErrorBanner onDismiss={() => setLoadError(null)}>{loadError}</ErrorBanner>}
      {publishNote && (
        <p className="page-status editor-page__message editor-page__publish-note">{publishNote}</p>
      )}
      {saveError && (
        <ErrorBanner onDismiss={() => setSaveError(null)}>{describeSaveError(saveError, m)}</ErrorBanner>
      )}

      <div className="editor-page__toolbar">
        <button
          type="button"
          className="editor-page__undo"
          onClick={handleUndo}
          disabled={!canUndo || isSaving}
        >
          {m.editor.undo}
        </button>
        <button
          type="button"
          className="editor-page__save"
          onClick={() => void handleSave()}
          disabled={!isDirty || isSaving}
        >
          {isSaving ? m.editor.saving : m.common.save}
        </button>
        {isDirty && !isSaving && <span className="editor-page__unsaved">{m.editor.unsaved}</span>}
      </div>

      <div className="editor editor-mood editor-mood__enter">
        <div className="editor__panel">
          <h3>{m.editor.elements}</h3>
          {fellBack && <p className="page-status">{m.editor.modeFallback}</p>}
          {elements.length === 0 ? (
            <p className="page-status">{m.editor.noElements}</p>
          ) : (
            <ul className="editor__list">
              {elements.map((element) => (
                <ElementEditor
                  key={element.id}
                  element={element}
                  callbacks={callbacks}
                  isActive={element.id === activeElementId}
                  onActivate={(id) => activateElement(id, true)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="editor__panel editor__preview">
          <div className="editor-mood__backdrop" aria-hidden="true" />
          <div className="editor__preview-header editor-mood__dock">
            <h3>{m.editor.livePreview}</h3>
            <div className="scanner__toggle" role="group" aria-label={m.editor.modeAria}>
              <button
                type="button"
                className={`scanner__toggle-btn${effectiveMode === 'generic' ? ' scanner__toggle-btn--active' : ''}`}
                disabled={isDirty || isSaving}
                onClick={() => {
                  setFellBack(false);
                  setScanMode('generic');
                }}
              >
                {m.editor.modeBeacons}
              </button>
              <button
                type="button"
                className={`scanner__toggle-btn${effectiveMode === 'editable' ? ' scanner__toggle-btn--active' : ''}`}
                disabled={isDirty || isSaving}
                onClick={() => {
                  setFellBack(false);
                  setScanMode('editable');
                }}
              >
                {m.editor.modeEditable}
              </button>
            </div>
            <label className="editor__highlight">
              <input
                type="checkbox"
                checked={highlight}
                onChange={(event) => {
                  setHighlight(event.target.checked);
                  if (!event.target.checked) {
                    setActiveElementId(null);
                    setPreviewScrollId(null);
                  }
                }}
              />
              {m.editor.highlight}
            </label>
            <select
              className="editor__device"
              value={device}
              aria-label={m.editor.deviceAria}
              onChange={(event) => {
                setDevice(event.target.value as DevicePreset);
                setZoom(null); // refit on preset change
              }}
            >
              <option value="desktop">{m.editor.deviceDesktop}</option>
              <option value="tablet">{m.editor.deviceTablet}</option>
              <option value="mobile">{m.editor.deviceMobile}</option>
            </select>
            <div className="editor__zoom" role="group" aria-label={m.editor.zoomAria}>
              <button
                type="button"
                aria-label={m.editor.zoomOut}
                disabled={effectiveScale <= ZOOM_MIN}
                onClick={() =>
                  setZoom(Math.max(ZOOM_MIN, Math.round((effectiveScale - ZOOM_STEP) * 100) / 100))
                }
              >
                −
              </button>
              <span className="editor__zoom-value">{Math.round(effectiveScale * 100)}%</span>
              <button
                type="button"
                aria-label={m.editor.zoomIn}
                disabled={effectiveScale >= ZOOM_MAX}
                onClick={() =>
                  setZoom(Math.min(ZOOM_MAX, Math.round((effectiveScale + ZOOM_STEP) * 100) / 100))
                }
              >
                +
              </button>
              <button
                type="button"
                className="editor__zoom-fit"
                disabled={zoom === null}
                onClick={() => setZoom(null)}
              >
                {m.editor.zoomFit}
              </button>
            </div>
          </div>
          <div className="editor__preview-frame" ref={frameRef}>
            <div
              className="editor__preview-sizer"
              style={{ width: presetWidth * effectiveScale, height: iframeHeight * effectiveScale }}
            >
              <iframe
                ref={iframeRef}
                className="editor__iframe"
                title={m.editor.previewTitle}
                srcDoc={srcDoc}
                sandbox="allow-same-origin"
                onLoad={handleIframeLoad}
                style={{
                  width: presetWidth,
                  height: iframeHeight,
                  transform: `scale(${effectiveScale})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>
          {highlight && <p className="editor__preview-legend">{m.editor.previewLegend}</p>}
        </div>
      </div>
    </section>
  );
}
