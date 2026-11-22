import type { ExerciseDetail } from '@ceg/contract';

/** Subject header: files to turn in, allowed functions, prototype, text, visible tests. */
export function Subject({ ex, showTests = true }: { ex: ExerciseDetail; showTests?: boolean }) {
  return (
    <section className="subject-box">
      <dl className="facts">
        <dt>Turn in</dt>
        <dd className="mono">{ex.expected_files.join(', ')}</dd>
        <dt>Allowed</dt>
        <dd className="mono">{ex.allowed_functions.length ? ex.allowed_functions.join(', ') : 'none'}</dd>
        {ex.prototype && (
          <>
            <dt>Prototype</dt>
            <dd className="mono pre">{ex.prototype}</dd>
          </>
        )}
      </dl>
      <div className="subject">{ex.subject_md}</div>
      {showTests && ex.visible_tests.length > 0 && (
        <details className="visible-tests">
          <summary>Example runs ({ex.visible_tests.length})</summary>
          <ul className="mono small">
            {ex.visible_tests.map((t) => (
              <li key={t.id}>
                {t.id}: ./{ex.expected_files[0]?.replace(/\.c$/, '')} {t.argv.map((a) => JSON.stringify(a)).join(' ')}
                {t.stdin !== null ? ` < ${JSON.stringify(t.stdin)}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {ex.subject_source === '42-derived-private' && (
        <p className="muted small">Subject text © 42 / École 42, for private practice only.</p>
      )}
    </section>
  );
}
