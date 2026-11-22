import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type {
  ExerciseDetail,
  GradeResult,
  SolutionResponse,
  SubmissionDetail,
  SubmissionSummary,
  User,
} from '@ceg/contract';
import { api, errorText } from '../api.ts';
import { CodeEditor } from '../editor/CodeEditor.tsx';
import { KeyBar } from '../editor/KeyBar.tsx';
import { BottomBar } from '../components/BottomBar.tsx';
import { ResultView } from '../components/Result.tsx';
import { HintsPanel } from '../components/HintsPanel.tsx';
import { Subject } from '../components/Subject.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { useAutocompleteSetting, useDraft } from '../lib/hooks.ts';
import { draftKey } from '../lib/storage.ts';

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

export function Practice({ user, exerciseId }: { user: User; exerciseId: string }) {
  const [ex, setEx] = useState<ExerciseDetail | null>(null);
  const [history, setHistory] = useState<SubmissionSummary[]>([]);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<SubmissionDetail | null>(null);
  const [solution, setSolution] = useState<SolutionResponse | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [gradeCount, setGradeCount] = useState(0);
  const [autocomplete, setAutocomplete] = useAutocompleteSetting();
  const viewRef = useRef<EditorView | null>(null);
  const draft = useDraft(draftKey(user.id, exerciseId));

  const loadHistory = useCallback(() => {
    api.practiceSubmissions(exerciseId).then((r) => setHistory(r.submissions), () => {});
  }, [exerciseId]);

  useEffect(() => {
    setEx(null);
    setResult(null);
    setSolution(null);
    setViewing(null);
    api.exercise(exerciseId).then(setEx, (e) => setError(errorText(e)));
    loadHistory();
  }, [exerciseId, loadHistory]);

  async function grade() {
    if (!ex || grading) return;
    const source = viewRef.current?.state.doc.toString() ?? draft.current();
    setGrading(true);
    setError(null);
    try {
      const r = await api.submitPractice(ex.id, { filename: ex.expected_files[0] ?? `${ex.id}.c`, source });
      setResult(r);
      setViewing(null);
      setGradeCount((n) => n + 1);
      loadHistory();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setGrading(false);
    }
  }

  async function reveal() {
    setConfirmReveal(false);
    try {
      setSolution(await api.solution(exerciseId));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function openSubmission(id: number) {
    try {
      setViewing(await api.submission(id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  function loadIntoEditor(source: string) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
  }

  if (!ex) {
    return (
      <main>
        <a href="#/">← Exercises</a>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  const filename = ex.expected_files[0] ?? `${ex.id}.c`;
  const attempted = history.length > 0 || result !== null;
  const latestFailId =
    result ? (result.verdict === 'FAIL' ? result.submission_id : null)
      : history[0]?.verdict === 'FAIL' ? history[0].id : null;

  return (
    <main className="with-bar">
      <a href="#/">← Exercises</a>
      <h2 className="title">
        <span className="mono">{ex.id}</span> <span className="muted small">level {ex.level} · {ex.kind}</span>
      </h2>
      <Subject ex={ex} />

      <div className="editor-head">
        <span className="mono small">{filename}</span>
        <label className="switch small">
          <input
            type="checkbox"
            checked={!autocomplete}
            onChange={(e) => setAutocomplete(!e.target.checked)}
          />
          Practice without autocomplete
        </label>
      </div>
      <CodeEditor
        key={`${user.id}:${ex.id}`}
        initialDoc={draft.initial}
        words={ex.autocomplete_words}
        autocomplete={autocomplete}
        onChange={draft.onChange}
        viewRef={viewRef}
      />

      {error && <p className="error" role="alert">{error}</p>}
      {result && !viewing && <ResultView result={result} filename={filename} />}

      {viewing && (
        <section className="viewing">
          <p className="small">
            Attempt {viewing.attempt_no} from {when(viewing.created_at)}{' '}
            <button type="button" className="small-btn" onClick={() => setViewing(null)}>Close</button>{' '}
            <button type="button" className="small-btn" onClick={() => loadIntoEditor(viewing.source)}>
              Load this code into the editor
            </button>
          </p>
          <ResultView result={viewing} filename={viewing.filename} />
        </section>
      )}

      <HintsPanel exerciseId={ex.id} latestFailId={latestFailId} refreshKey={gradeCount} />

      <section className="history">
        <h3>History</h3>
        {history.length === 0 ? (
          <p className="muted small">No attempts yet.</p>
        ) : (
          <ul className="list">
            {history.map((s) => (
              <li key={s.id}>
                <button type="button" className="row" onClick={() => void openSubmission(s.id)}>
                  <span>#{s.attempt_no} <span className={s.verdict === 'PASS' ? 'okc' : 'koc'}>{s.verdict}</span></span>
                  <span className="muted small">{when(s.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="reveal">
        <h3>Solution</h3>
        {solution ? (
          <>
            <p className="mono small">{solution.filename}</p>
            <pre className="code mono" data-testid="solution">{solution.source}</pre>
          </>
        ) : (
          <>
            <button type="button" disabled={!attempted} onClick={() => setConfirmReveal(true)}>
              Show the solution
            </button>
            {!attempted && <p className="muted small">Available after your first graded attempt.</p>}
          </>
        )}
      </section>

      {confirmReveal && (
        <ConfirmDialog
          title="Show the solution?"
          confirmLabel="Show it"
          onConfirm={() => void reveal()}
          onCancel={() => setConfirmReveal(false)}
        >
          <p>If you have not solved this exercise yet, it will no longer count as solved without hints.</p>
        </ConfirmDialog>
      )}

      <BottomBar>
        <KeyBar viewRef={viewRef} />
        <button
          type="button"
          className="grade primary"
          disabled={grading}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void grade()}
        >
          {grading ? 'Grading…' : 'Grade'}
        </button>
      </BottomBar>
    </main>
  );
}
