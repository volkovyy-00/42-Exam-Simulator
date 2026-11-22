import { useEffect, useState } from 'react';
import type { HealthResponse, User } from '@ceg/contract';
import { api, ApiFailure, errorText } from './api.ts';
import { Login } from './screens/Login.tsx';
import { ExerciseList } from './screens/ExerciseList.tsx';
import { Practice } from './screens/Practice.tsx';
import { Exam } from './screens/Exam.tsx';

type Route = { name: 'list' } | { name: 'practice'; id: string } | { name: 'exam' };

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'practice' && parts[1]) return { name: 'practice', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'exam') return { name: 'exam' };
  return { name: 'list' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const DISCLAIMER =
  'Independent practice tool. Not affiliated with, endorsed by, or reflective of the official exams of 42 / École 42.';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    api.me().then((r) => setUser(r.user), (e) => {
      if (e instanceof ApiFailure && e.status === 401) setUser(null);
      else {
        setUser(null);
        setError(errorText(e));
      }
    });
    api.health().then(setHealth, () => {});
  }, []);

  async function logout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      window.location.hash = '#/';
    }
  }

  let body;
  if (user === undefined) body = <main><p className="muted">Loading…</p></main>;
  else if (user === null) body = <Login onLoggedIn={(u) => { setError(null); setUser(u); }} />;
  else if (route.name === 'practice') body = <Practice key={route.id} user={user} exerciseId={route.id} />;
  else if (route.name === 'exam') body = <Exam user={user} />;
  else body = <ExerciseList />;

  return (
    <div className="shell">
      {user && (
        <header className="top">
          <a href="#/" className="brand">C Exam Gym</a>
          <nav>
            <a href="#/" aria-current={route.name !== 'exam' ? 'page' : undefined}>Practice</a>
            <a href="#/exam" aria-current={route.name === 'exam' ? 'page' : undefined}>Exam</a>
          </nav>
          <span className="spacer" />
          <button type="button" className="small-btn" onClick={() => void logout()} title={`Logged in as ${user.username}`}>
            Log out
          </button>
        </header>
      )}
      {user && health && health.grader !== 'up' && (
        <p className="warn small banner" role="status">The grader is down. Grading will fail until it is back.</p>
      )}
      {error && <p className="error pad">{error}</p>}
      {body}
      <footer className="disclaimer" data-testid="disclaimer">{DISCLAIMER}</footer>
    </div>
  );
}
