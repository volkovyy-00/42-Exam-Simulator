import { useEffect, useState } from 'react';
import type { ExerciseSummary } from '@ceg/contract';
import { api, errorText } from '../api.ts';

export function ExerciseList() {
  const [list, setList] = useState<ExerciseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.exercises().then((r) => setList(r.exercises), (e) => setError(errorText(e)));
  }, []);

  if (error) return <main><p className="error">{error}</p></main>;
  if (!list) return <main><p className="muted">Loading…</p></main>;

  const clean = list.filter((e) => e.solved_without_hints).length;
  const solved = list.filter((e) => e.solved).length;
  const tried = list.filter((e) => e.attempts > 0).length;
  const levels = [...new Set(list.map((e) => e.level))].sort((a, b) => a - b);

  return (
    <main>
      <section className="progress" data-testid="progress">
        <p className="headline">
          <strong>{clean}</strong> / {list.length} solved without hints
        </p>
        <p className="muted small">
          {solved} solved in total · {tried} attempted
        </p>
      </section>
      {levels.map((lvl) => (
        <section key={lvl}>
          <h2 className="level">Level {lvl}</h2>
          <ul className="list">
            {list.filter((e) => e.level === lvl).map((e) => (
              <li key={e.id}>
                <a className="row" href={`#/practice/${encodeURIComponent(e.id)}`}>
                  <span className="mono">{e.id}</span>
                  <span className="marks">
                    {e.solved_without_hints ? (
                      <span className="badge good" title="Solved without hints">★ no hints</span>
                    ) : e.solved ? (
                      <span className="badge" title="Solved">✓ solved</span>
                    ) : e.attempts > 0 ? (
                      <span className="muted small">{e.attempts} tries</span>
                    ) : null}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
