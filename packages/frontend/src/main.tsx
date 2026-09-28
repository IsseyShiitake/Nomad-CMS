import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './services/theme';
import './styles/global.css';

/**
 * Frontend entry point.
 *
 * Mounts the application to the DOM. The app uses a data router
 * (createBrowserRouter in <App />) so route-level hooks like useBlocker
 * are available to feature pages.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
