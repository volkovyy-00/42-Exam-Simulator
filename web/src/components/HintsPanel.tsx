import { useCallback, useEffect, useState } from 'react';
import type { Hint, HintBlockReason, HintStateResponse } from '@ceg/contract';
import { api, errorText } from '../api.ts';

const WHY: Record<HintBlockReason, string> = {
  need_failed_run: 'Grade a failing attempt first.',
  code_unchanged: 'Change your code before asking for another hint.',
  quota: 'Hint limit reached for today.',
  disabled: 'Hints are turned off on this server.',
  exam_active: 'Hints are off while an exam is running.',
};

const SOURCE: Record<Hint['source'], string> = {
  llm: 'AI hint',
  canned: 'Prepared hint',
  diff: 'Output-diff hint',
};

interface Props {
  exerciseId: string;
  /** Latest FAIL submission id, if any; a hint request needs one. */
  latestFailId: number | null;
  /** Bumped after each grade so the panel re-reads eligibility. */
  refreshKey: number;
}

export function HintsPanel({ exerciseId, latestFailId, refreshKey }: Props) {
  const [state, setState] = useState<HintStateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rated, setRated] = useState<Set<number>>(new Set());

  const reload = useCallback(() => {
    api.hintState(exerciseId).then(setState, (e) => setError(errorText(e)));
  }, [exerciseId]);

  useEffect(reload, [reload, refreshKey]);

  async function ask() {
    if (latestFailId === null) return;
    setBusy(true);
    setError(null);
    try {
      const hint = await api.requestHint(exerciseId, latestFailId);
      setState((s) => (s ? { ...s, hints: [...s.hints.filter((h) => h.hint_id !== hint.hint_id), hint] } : s));
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function markWrong(id: number) {
    try {
      await api.rateHint(id, { rating: 'wrong' });
      setRated((r) => new Set(r).add(id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!state) return error ? <p className="error">{error}</p> : null;

  const canAsk = state.enabled && state.eligible_level !== null && latestFailId !== null && !busy;
  return (
    <section className="hints" data-testid="hints">
      <h3>Hints</h3>
      {!state.enabled ? (
        <p className="muted">{WHY.disabled}</p>
      ) : (
        <>
          <p className="warn">AI hint may be wrong. Check it against the subject and your output.</p>
          {state.hints.map((h) => (
            <article key={h.hint_id} className="hint">
              <p className="small muted">Level {h.level} · {SOURCE[h.source]}</p>
              <p className="hint-text">{h.text}</p>
              {rated.has(h.hint_id) ? (
                <p className="small muted">Thanks, marked as wrong.</p>
              ) : (
                <button type="button" className="small-btn" onClick={() => void markWrong(h.hint_id)}>
                  This hint was wrong
                </button>
              )}
            </article>
          ))}
          <button type="button" disabled={!canAsk} onClick={() => void ask()}>
            {busy ? 'Thinking…' : state.eligible_level ? `Get a level ${state.eligible_level} hint` : 'Get a hint'}
          </button>
          {state.eligible_level === null && state.reason && <p className="muted small">{WHY[state.reason]}</p>}
          <p className="muted small">
            Left today: {state.quota.user_day_left} in total, {state.quota.exercise_day_left} for this exercise.
          </p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
