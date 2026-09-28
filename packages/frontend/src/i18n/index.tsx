/**
 * i18n provider and hook.
 *
 * Built-in typed dictionaries (no external library). The locale is
 * persisted in localStorage and defaults to the browser language.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { en, fr } from './messages';
import type { Locale, Messages } from './messages';

const STORAGE_KEY = 'cms.locale';
const dictionaries: Record<Locale, Messages> = { en, fr };

/** Replaces `{key}` placeholders in a template with values. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'fr') return stored;
  } catch {
    /* SSR/test: no storage */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr')
    ? 'fr'
    : 'en';
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  m: Messages;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Provides the current locale and translated messages to the app. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale, m: dictionaries[locale] }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Hook to access the current locale and translated messages. */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}

export type { Locale, Messages };
