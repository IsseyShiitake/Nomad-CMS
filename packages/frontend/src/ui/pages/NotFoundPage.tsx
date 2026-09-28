import { Link } from 'react-router';
import { config } from '@/config';
import { useI18n } from '@/i18n';
import './NotFound.css';

/** 404 page shown for unknown routes. */
export function NotFoundPage() {
  const { m } = useI18n();
  return (
    <section className="not-found">
      <p className="not-found__kicker">{config.appName || m.app.name}</p>
      <p className="not-found__code">404</p>
      <h2 className="not-found__title">{m.notFound.title}</h2>
      <p className="not-found__body">{m.notFound.body}</p>
      <Link className="btn btn--primary not-found__action" to="/">
        {m.nav.repositories}
      </Link>
    </section>
  );
}
