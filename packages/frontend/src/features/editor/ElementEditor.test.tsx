/**
 * Component tests for the element editor row.
 *
 * Verifies the Phase 2 UI contract: text elements render an auto-growing
 * multi-line <textarea> that forwards newlines to onEditText, images keep
 * their single-line src field plus a localized browse button that opens
 * the hidden native file picker, and the queued-file placeholder is
 * localized in both locales.
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditableElement } from '@/services/htmlParser';
import { I18nProvider, useI18n } from '@/i18n';
import { ElementEditor, type ElementEditorCallbacks } from './ElementEditor';

const TEXT_ELEMENT: EditableElement = {
  id: 'el--p',
  tagName: 'p',
  textContent: 'Hello',
  src: null,
  selector: 'p',
};

const IMAGE_ELEMENT: EditableElement = {
  id: 'el--img',
  tagName: 'img',
  textContent: null,
  src: '/old.png',
  selector: 'img',
};

function makeCallbacks(): ElementEditorCallbacks {
  return {
    onEditText: vi.fn(),
    onReplaceImage: vi.fn(),
    onImageFile: vi.fn(),
    onInsertAbove: vi.fn(),
    onInsertBelow: vi.fn(),
    onDelete: vi.fn(),
  };
}

/** Switches the provider's locale on mount (localStorage is unavailable in tests). */
function LocaleSetter({ locale, children }: { locale: 'en' | 'fr'; children: ReactNode }) {
  const { setLocale } = useI18n();
  useEffect(() => {
    setLocale(locale);
  }, [setLocale, locale]);
  return <>{children}</>;
}

function renderElement(
  element: EditableElement,
  locale: 'en' | 'fr' = 'en',
  isActive = false,
  onActivate: (id: string) => void = () => {},
) {
  return render(
    <I18nProvider>
      <LocaleSetter locale={locale}>
        <ul>
          <ElementEditor
            element={element}
            callbacks={makeCallbacks()}
            isActive={isActive}
            onActivate={onActivate}
          />
        </ul>
      </LocaleSetter>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ElementEditor text elements', () => {
  it('renders a multi-line textarea and forwards newlines', () => {
    const callbacks = makeCallbacks();
    render(
      <I18nProvider>
        <ul>
          <ElementEditor
            element={TEXT_ELEMENT}
            callbacks={callbacks}
            isActive={false}
            onActivate={() => {}}
          />
        </ul>
      </I18nProvider>,
    );

    const field = screen.getByRole('textbox');
    expect(field.tagName).toBe('TEXTAREA');

    fireEvent.change(field, { target: { value: 'Line1\nLine2' } });
    expect(callbacks.onEditText).toHaveBeenCalledWith('el--p', 'Line1\nLine2');
  });

  it('shows the current content as the textarea value', () => {
    renderElement(TEXT_ELEMENT);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Hello');
  });
});

describe('ElementEditor image elements', () => {
  it('keeps the src field as a single-line input', () => {
    renderElement(IMAGE_ELEMENT);

    const field = screen.getByRole('textbox');
    expect(field.tagName).toBe('INPUT');
    expect((field as HTMLInputElement).value).toBe('/old.png');
  });

  it('opens the hidden native picker from the localized browse button (EN)', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    renderElement(IMAGE_ELEMENT);

    // Localized visible label…
    expect(screen.getByText('Browse…')).not.toBeNull();
    // …and the empty-file placeholder.
    expect(screen.getByText('No file selected')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
    expect(clickSpy).toHaveBeenCalledOnce();

    clickSpy.mockRestore();
  });

  it('localizes the browse button and placeholder in French', () => {
    renderElement(IMAGE_ELEMENT, 'fr');

    expect(screen.getByText('Parcourir…')).not.toBeNull();
    expect(screen.getByText('Aucun fichier sélectionné')).not.toBeNull();
  });

  it('queues the selected file under its element id', () => {
    const callbacks = makeCallbacks();
    render(
      <I18nProvider>
        <ul>
          <ElementEditor
            element={IMAGE_ELEMENT}
            callbacks={callbacks}
            isActive={false}
            onActivate={() => {}}
          />
        </ul>
      </I18nProvider>,
    );

    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['bytes'], 'photo.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [file] } });

    expect(callbacks.onImageFile).toHaveBeenCalledWith('el--img', file);
    // The queued filename replaces the placeholder.
    expect(screen.getByText('photo.png')).not.toBeNull();
  });
});

describe('ElementEditor active state', () => {
  it('marks the row active only when isActive is set', () => {
    const { container, unmount } = renderElement(TEXT_ELEMENT, 'en', true);
    expect(container.querySelector('.editor-element--active')).not.toBeNull();
    unmount();

    const inactive = renderElement(TEXT_ELEMENT);
    expect(inactive.container.querySelector('.editor-element--active')).toBeNull();
  });

  it('calls onActivate with the element id when the row is clicked', () => {
    const onActivate = vi.fn();
    const { container } = renderElement(TEXT_ELEMENT, 'en', false, onActivate);
    fireEvent.click(container.querySelector('.editor-element')!);
    expect(onActivate).toHaveBeenCalledWith('el--p');
  });

  it('still calls onActivate when the click lands on a child control', () => {
    const onActivate = vi.fn();
    renderElement(TEXT_ELEMENT, 'en', false, onActivate);
    fireEvent.click(screen.getByRole('textbox'));
    expect(onActivate).toHaveBeenCalledWith('el--p');
  });
});
