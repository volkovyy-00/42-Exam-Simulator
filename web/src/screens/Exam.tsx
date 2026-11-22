import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type { ExamProfile, ExamStatus, ExerciseDetail, GradeResult, User } from '@ceg/contract';
import { api, ApiFailure, errorText } from '../api.ts';
import { CodeEditor } from '../editor/CodeEditor.tsx';
import { KeyBar } from '../editor/KeyBar.tsx';
import { BottomBar } from '../components/BottomBar.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ResultView } from '../components/Result.tsx';
import { Subject } from '../components/Subject.tsx';
import { formatDuration, useAutocompleteSetting, useDraft, useNow } from '../lib/hooks.ts';
import { draftKey } from '../lib/storage.ts';

type Phase = 'loading' | 'picker' | 'exam';

export function Exam({ user }: { user: User }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [profiles, setProfiles] = useState<ExamProfile[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState<ExamStatus | null>(null);
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((s: ExamStatus) => {
    setStatus(s);
    setSkew(Date.parse(s.now) - Date.now());
    setPhase('exam');
  }, []);

  const showPicker = useCallback(() => {
    setStatus(null);
    setPhase('picker');
    api.examProfiles().then((r) => {
      setProfiles(r.profiles);
      setPicked((p) => p ?? r.profiles.find((x) => x.enabled)?.id ?? null);
    }, (e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    api.currentExam().then(applyStatus, (e) => {
      if (e instanceof ApiFailure && e.status === 404) showPicker();
      else setError(errorText(e));
    });
  }, [applyStatus, showPicker]);

  async function start() {
    if (!picked) return;
    setError(null);
    try {
      applyStatus(await api.startExam(picked));
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) {
        api.currentExam().then(applyStatus, (e2) => setError(errorText(e2)));
      } else setError(errorText(e));
    }
  }

  if (phase === 'loading') {
    return <main>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;
  }

  if (phase === 'picker' || !status) {
    return (
      <main>
        <h2>Start an exam</h2>
        <fieldset className="profiles">
          <legend className="small muted">Exam profile</legend>
          {profiles.map((p) => (
            <label key={p.id} className={`profile ${p.enabled ? '' : 'disabled'}`}>
              <input
                type="radio"
                name="profile"
                value={p.id}
                disabled={!p.enabled}
                checked={picked === p.id}
                onChange={() => setPicked(p.id)}
              />
              <span>
                <strong>{p.label}</strong>
                <span className="muted small">
                  {' '}· {p.slots.length} questions · pass at {p.pass_mark}
                  {p.enabled ? '' : ' · not available'}
                </span>
                <span className="small muted block">{p.approximation_note}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <button type="button" className="primary" disabled={!picked} onClick={() => void start()}>
          Start exam
        </button>
        <p className="muted small">No hints and no solutions during an exam. A failed grademe starts a cooldown.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </main>
    );
  }

  if (status.status !== 'active' || !status.current) {
    return <ExamOver status={status} onNew={showPicker} />;
  }

  return <ActiveExam user={user} status={status} skew={skew} onStatus={applyStatus} />;
}

function ExamOver({ status, onNew }: { status: ExamStatus; onNew: () => void }) {
  return (
    <main>
      <h2>Exam {status.status === 'expired' ? 'over (time is up)' : 'finished'}</h2>
      <p className="headline">
        <strong>{status.score}</strong> / pass at {status.pass_mark}:{' '}
        <span className={status.passed ? 'okc' : 'koc'}>{status.passed ? 'passed' : 'not passed'}</span>
      </p>
      <ExamHistory status={status} />
      <button type="button" className="primary" onClick={onNew}>Start a new exam</button>
    </main>
  );
}

function ExamHistory({ status }: { status: ExamStatus }) {
  if (status.history.length === 0) return null;
  return (
    <section>
      <h3>History</h3>
      <ul className="list">
        {status.history.map((h, i) => (
          <li key={i} className="row static">
            <span>Q{h.slot + 1} · L{h.level} · <span className="mono">{h.exercise_id}</span></span>
            <span className={h.result === 'passed' ? 'okc' : 'koc'}>
              {h.result === 'passed' ? `+${h.points}` : 'replaced'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ActiveProps {
  user: User;
  status: ExamStatus;
  skew: number;
  onStatus: (s: ExamStatus) => void;
}

function ActiveExam({ user, status, skew, onStatus }: ActiveProps) {
  const current = status.current!;
  const [question, setQuestion] = useState<ExerciseDetail | null>(null);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [nextGradeAt, setNextGradeAt] = useState<string | null>(status.next_grade_at);
  const [confirm, setConfirm] = useState<'grade' | 'finish' | null>(null);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autocomplete, setAutocomplete] = useAutocompleteSetting();
  const viewRef = useRef<EditorView | null>(null);
  const draft = useDraft(draftKey(user.id, current.exercise_id, status.exam_id));
  const now = useNow() + skew;

  useEffect(() => setNextGradeAt(status.next_grade_at), [status.next_grade_at]);

  useEffect(() => {
    setQuestion(null);
    api.examQuestion(status.exam_id).then(setQuestion, (e) => setError(errorText(e)));
  }, [status.exam_id, current.exercise_id]);

  const timeLeft = (Date.parse(status.ends_at) - now) / 1000;
  const cooldownLeft = nextGradeAt ? (Date.parse(nextGradeAt) - now) / 1000 : 0;
  const coolingDown = cooldownLeft > 0;

  // Re-read status once when the clock runs out.
  const expiredOnce = useRef(false);
  useEffect(() => {
    if (timeLeft <= 0 && !expiredOnce.current) {
      expiredOnce.current = true;
      api.exam(status.exam_id).then(onStatus, () => {});
    }
  }, [timeLeft, status.exam_id, onStatus]);

  async function refresh() {
    setError(null);
    try {
      onStatus(await api.exam(status.exam_id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function grademe() {
    setConfirm(null);
    if (!question || grading) return;
    const source = viewRef.current?.state.doc.toString() ?? draft.current();
    setGrading(true);
    setError(null);
    try {
      const r = await api.grademe(status.exam_id, {
        filename: current.expected_files[0] ?? `${current.exercise_id}.c`,
        source,
      });
      setResult(r.result);
      onStatus(r.status);
    } catch (e) {
      if (e instanceof ApiFailure && e.body.error === 'cooldown' && e.body.next_grade_at) {
        setNextGradeAt(e.body.next_grade_at);
      }
      if (e instanceof ApiFailure && e.body.error === 'exam_over') void refresh();
      setError(errorText(e));
    } finally {
      setGrading(false);
    }
  }

  async function finish() {
    setConfirm(null);
    try {
      onStatus(await api.finishExam(status.exam_id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  const filename = current.expected_files[0] ?? `${current.exercise_id}.c`;

  return (
    <main className="with-bar exam">
      <section className="exam-status" data-testid="exam-status">
        <div className="clock mono" aria-label="Time left" data-testid="clock">{formatDuration(timeLeft)}</div>
        <div className="small">
          Question {status.slot + 1} / {status.total_slots} · level {status.level ?? '—'} · score{' '}
          <strong>{status.score}</strong> / {status.pass_mark}
          {current.failures > 0 && <> · {current.failures} failed</>}
        </div>
        <div className="exam-actions">
          <button type="button" className="small-btn" onClick={() => void refresh()}>status</button>
          <button type="button" className="small-btn" onClick={() => setConfirm('finish')}>finish</button>
        </div>
      </section>

      {coolingDown && (
        <p className="cooldown" role="status" data-testid="cooldown">
          Cooldown: next grademe in <strong className="mono">{formatDuration(cooldownLeft)}</strong>
        </p>
      )}

      {question ? (
        <>
          <h2 className="title mono">{question.id}</h2>
          <Subject ex={question} />
          <div className="editor-head">
            <span className="mono small">{filename}</span>
            <label className="switch small">
              <input type="checkbox" checked={!autocomplete} onChange={(e) => setAutocomplete(!e.target.checked)} />
              Practice without autocomplete
            </label>
          </div>
          <CodeEditor
            key={`${status.exam_id}:${current.exercise_id}`}
            initialDoc={draft.initial}
            words={question.autocomplete_words}
            autocomplete={autocomplete}
            onChange={draft.onChange}
            viewRef={viewRef}
          />
        </>
      ) : (
        <p className="muted">Loading the question…</p>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {result && <ResultView result={result} filename={filename} />}
      <ExamHistory status={status} />
      <p className="muted small">Scoring, cooldown and timeouts approximate the real exam.</p>

      {confirm === 'grade' && (
        <ConfirmDialog
          title="Grade this file?"
          confirmLabel="grademe"
          onConfirm={() => void grademe()}
          onCancel={() => setConfirm(null)}
        >
          <p>
            Submit <span className="mono">{filename}</span> for grading. If it fails, you get a cooldown
            before the next try.
          </p>
        </ConfirmDialog>
      )}
      {confirm === 'finish' && (
        <ConfirmDialog
          title="Finish the exam?"
          confirmLabel="Finish"
          onConfirm={() => void finish()}
          onCancel={() => setConfirm(null)}
        >
          <p>Your score is final once you finish.</p>
        </ConfirmDialog>
      )}

      <BottomBar>
        <KeyBar viewRef={viewRef} />
        <button
          type="button"
          className="grade primary"
          disabled={grading || coolingDown || !question}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setConfirm('grade')}
        >
          {grading ? 'Grading…' : coolingDown ? formatDuration(cooldownLeft) : 'grademe'}
        </button>
      </BottomBar>
    </main>
  );
}
