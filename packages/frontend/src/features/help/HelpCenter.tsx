import { useState } from 'react';
import { Modal } from '@/ui/components/Modal';
import { useI18n } from '@/i18n';

/**
 * Help center modal.
 *
 * Two tabs: a step-by-step getting-started guide and an HTML-terms
 * glossary. Content comes from the translated dictionaries so both
 * tabs follow the active locale.
 */
export function HelpCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const [tab, setTab] = useState<'start' | 'glossary'>('start');

  return (
    <Modal open={open} title={m.help.title} onClose={onClose}>
      <div className="help-center">
        <div className="help-center__tabs" role="tablist" aria-label={m.help.title}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'start'}
            className={`help-center__tab${tab === 'start' ? ' help-center__tab--active' : ''}`}
            onClick={() => setTab('start')}
          >
            {m.help.tabStart}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'glossary'}
            className={`help-center__tab${tab === 'glossary' ? ' help-center__tab--active' : ''}`}
            onClick={() => setTab('glossary')}
          >
            {m.help.tabGlossary}
          </button>
        </div>

        {tab === 'start' ? (
          <ol className="help-center__steps">
            {m.help.steps.map((step) => (
              <li key={step.title} className="help-center__step">
                <strong className="help-center__step-title">{step.title}</strong>
                <p className="help-center__step-body">{step.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <dl className="help-center__glossary">
            {m.help.glossary.map((entry) => (
              <div key={entry.term} className="help-center__glossary-entry">
                <dt className="help-center__term">{entry.term}</dt>
                <dd className="help-center__def">{entry.def}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Modal>
  );
}
