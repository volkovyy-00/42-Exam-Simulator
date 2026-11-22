// localStorage wrappers. Every access is guarded: private mode or blocked storage must never
// break the editor.

export function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: drafts are a convenience */
  }
}

/** Draft key, per user and exercise (TASKS.md WP4 item 4). Exam drafts are kept apart. */
export function draftKey(userId: number, exerciseId: string, examId?: number): string {
  return examId === undefined
    ? `ceg:draft:${userId}:${exerciseId}`
    : `ceg:draft:${userId}:exam${examId}:${exerciseId}`;
}

export const AUTOCOMPLETE_OFF_KEY = 'ceg:autocomplete_off';
