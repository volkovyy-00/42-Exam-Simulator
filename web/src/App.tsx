// Placeholder shell. WP4 replaces this with the real screens: login/register, exercise list,
// practice editor (CodeMirror 6 + key bar), exam mode, results with cat -e diff, hints panel.
import { useEffect, useState } from 'react';
import type { ExerciseDetail, ExerciseSummary, GradeResult, HealthResponse } from '@ceg/contract';
import { api, ApiFailure } from './api.ts';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [exercises, setExercises] = useState<ExerciseSummary[]>([]);
  const [current, setCurrent] = useState<ExerciseDetail | null>(null);
  const [source, setSource] = useState('');
  const [result, setResult] = useState<GradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e: Error) => setError(e.message));
    api.exercises().then((r) => setExercises(r.exercises)).catch(() => {});
  }, []);

  async function open(id: string) {
    setResult(null);
    setCurrent(await api.exercise(id));
  }

  async function grade() {
    if (!current) return;
    setError(null);
    try {
      setResult(await api.submitPractice(current.id, { filename: current.expected_files[0] ?? '', source }));
    } catch (e) {
      setError(e instanceof ApiFailure ? `${e.body.error}: ${e.message}` : String(e));
    }
  }

  return (
    <div className="shell">
      <header>
        <strong>C Exam Gym</strong>
        <span className="muted">
          {health ? `grader ${health.grader} · hints ${health.hints_enabled ? 'on' : 'off'}` : '…'}
        </span>
      </header>

      <main>
        {!current && (
          <ul className="list">
            {exercises.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => void open(e.id)}>
                  L{e.level} · {e.id} {e.solved ? '✓' : ''}
                </button>
              </li>
            ))}
          </ul>
        )}

        {current && (
          <section>
            <button type="button" onClick={() => setCurrent(null)}>← Exercises</button>
            <h2>{current.id}</h2>
            <p className="muted">
              Turn in: {current.expected_files.join(', ')} · Allowed: {current.allowed_functions.join(', ') || 'none'}
            </p>
            <pre className="subject">{current.subject_md}</pre>
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="Editor placeholder (CodeMirror 6 arrives in WP4)"
            />
            <button type="button" className="grade" onClick={() => void grade()}>Grade</button>
            {result && (
              <div className="result">
                <strong>{result.verdict}</strong> · {result.message}
                <div>{result.tests.map((t) => `[${t.status}]`).join(' ')}</div>
                {result.first_failure && (
                  <pre>
                    {`expected: ${result.first_failure.expected_cat_e}\ngot:      ${result.first_failure.got_cat_e}`}
                  </pre>
                )}
              </div>
            )}
          </section>
        )}
        {error && <p className="error">{error}</p>}
      </main>

      <footer>
        Independent practice tool. Not affiliated with, endorsed by, or reflective of the official
        exams of 42 / École 42.
      </footer>
    </div>
  );
}
