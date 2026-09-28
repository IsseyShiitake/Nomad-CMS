/**
 * Component tests for the Help center modal.
 *
 * Verifies both tabs render and switch content.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '@/i18n';
import { HelpCenter } from './HelpCenter';

describe('HelpCenter', () => {
  it('renders the getting-started steps and switches to the glossary', () => {
    render(
      <I18nProvider>
        <HelpCenter open onClose={() => {}} />
      </I18nProvider>,
    );

    // Getting started tab is active by default.
    expect(screen.getByText('Sign in')).not.toBeNull();
    expect(screen.getByText('Pick a page')).not.toBeNull();

    // Switch to the HTML basics tab.
    fireEvent.click(screen.getByRole('tab', { name: 'HTML basics' }));
    expect(screen.getByText('<h1> — Main heading')).not.toBeNull();
    expect(screen.getByText('Beacon (editable block)')).not.toBeNull();

    // And back.
    fireEvent.click(screen.getByRole('tab', { name: 'Getting started' }));
    expect(screen.getByText('Save')).not.toBeNull();
  });
});
