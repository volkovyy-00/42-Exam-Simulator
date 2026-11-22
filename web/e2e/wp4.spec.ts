// WP4 acceptance tests (TASKS.md "WP4: Web app"), run on the iPhone 15 and Pixel 8 profiles
// against `vite preview` + the real API (fixtures/ content, fake dispatcher; see
// playwright.config.ts). Every test starts logged in (e2e/fixtures.ts). Responses the fake
// dispatcher or a fresh account never produce (429 cooldown, slow responses, hint state, a
// nm/compile result, a given exercise list) are injected with page.route.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { E2E, LOGIN_DEMO } from './env.ts';
import { expect, newInvite, test } from './fixtures.ts';

const DISCLAIMER = 'Not affiliated with, endorsed by, or reflective of the official exams of 42';
const here = path.dirname(fileURLToPath(import.meta.url));

async function openPractice(page: Page, id = 'gym_echo_first') {
  await page.goto(`/#/practice/${id}`);
  await expect(page.locator('.cm-content')).toBeVisible();
}

/** Text of the editor document, line by line (CodeMirror renders one .cm-line per line). */
async function editorText(page: Page): Promise<string> {
  return page.locator('.cm-line').evaluateAll((lines) => lines.map((l) => l.textContent ?? '').join('\n'));
}

async function focusEditor(page: Page) {
  await page.locator('.cm-content').tap();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.cm-content'))).toBe(true);
}

/**
 * Enter as a hardware key. On Android, CodeMirror defers Enter briefly to see whether the IME
 * handles it; synthetic key events need that moment before the next keystroke.
 */
async function enter(page: Page) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
}

const activeInEditor = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('.cm-content'));

test.describe('key bar', () => {
  test('renders on a coarse pointer and is hidden on a fine pointer', async ({ page, browser, baseURL, storageState }) => {
    await openPractice(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const bar = page.locator('.keybar');
    await expect(bar).toBeVisible();
    const keys = bar.locator('button');
    await expect(keys).toHaveCount(17);
    for (const b of await keys.all()) {
      await expect(b).toHaveAttribute('type', 'button');
      await expect(b).toHaveAttribute('tabindex', '-1');
      const box = (await b.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // The bar scrolls horizontally rather than wrapping.
    expect(await bar.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');

    const desktop = await browser.newContext({
      baseURL, viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1,
      storageState,
    });
    const dp = await desktop.newPage();
    await openPractice(dp);
    expect(await dp.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
    await expect(dp.locator('.keybar')).toBeHidden();
    await expect(dp.getByRole('button', { name: 'Grade' })).toBeVisible();
    await desktop.close();
  });

  test('( inserts () with the caret inside and keeps focus; Tab inserts \\t', async ({ page }) => {
    await openPractice(page);
    await focusEditor(page);
    await page.locator('[data-key="("]').tap();
    expect(await activeInEditor(page)).toBe(true);
    expect(await editorText(page)).toBe('()');
    await page.keyboard.type('x');
    expect(await editorText(page)).toBe('(x)');

    // `)` skips over the auto-inserted closer instead of doubling it.
    await page.locator('[data-key=")"]').tap();
    expect(await editorText(page)).toBe('(x)');

    await enter(page);
    await page.locator('[data-key="Tab"]').tap();
    expect(await activeInEditor(page)).toBe(true);
    await page.keyboard.type('y');
    expect(await editorText(page)).toBe('(x)\n\ty');

    // Plain keys and quotes.
    for (const k of [';', '"']) await page.locator(`[data-key='${k}']`).tap();
    expect(await editorText(page)).toBe('(x)\n\ty;""');
    expect(await activeInEditor(page)).toBe(true);
  });

  test('one tap on ( inserts exactly one ( (no ghost click, on every engine)', async ({ page }) => {
    await openPractice(page);
    await focusEditor(page);
    const paren = page.locator('[data-key="("]');
    await paren.tap();
    // Wait past the 500 ms window in which a click following the tap is ignored (lib/tap.ts).
    await page.waitForTimeout(700);
    expect(await editorText(page)).toBe('()');
    expect(await activeInEditor(page)).toBe(true);
    // A second tap after the window counts again: exactly one more pair.
    await paren.tap();
    await page.waitForTimeout(700);
    expect(await editorText(page)).toBe('(())');
  });

  test('Tab with a selection indents the selected lines', async ({ page }) => {
    await openPractice(page);
    await focusEditor(page);
    await page.keyboard.type('a;');
    await enter(page);
    await page.keyboard.type('b;');
    await page.keyboard.press('ControlOrMeta+a');
    await page.locator('[data-key="Tab"]').tap();
    expect(await editorText(page)).toBe('\ta;\n\tb;');
  });
});

test.describe('practice', () => {
  test('Grade stays visible with the editor focused and is disabled while grading', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/practice/*/submissions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await gate;
      await route.continue();
    });
    await openPractice(page);
    await focusEditor(page);
    const grade = page.getByRole('button', { name: /^(Grade|Grading…)$/ });
    await expect(grade).toBeInViewport({ ratio: 1 });
    const box = (await grade.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);

    await grade.tap();
    await expect(grade).toBeDisabled();
    await expect(grade).toHaveText('Grading…');
    // A second tap while in flight sends nothing.
    release();
    await expect(grade).toBeEnabled();
    await expect(grade).toHaveText('Grade');
    expect(await activeInEditor(page)).toBe(true);
  });

  test('FAIL shows [OK] [KO], the hidden test, cat -e diff and visible whitespace', async ({ page }) => {
    await openPractice(page);
    await page.getByRole('button', { name: 'Grade' }).tap();
    const result = page.getByTestId('result');
    await expect(result).toBeVisible();
    await expect(result.getByTestId('tests')).toHaveText('[OK] [KO]');
    await expect(result).toContainText('hidden test');
    await expect(result).toContainText('Test 02');
    const diff = result.getByTestId('diff');
    await expect(diff).toContainText('expected: $');
    await expect(diff).toContainText('got: ');
    await result.getByRole('button', { name: 'Show whitespace' }).tap();
    await expect(diff).toContainText('expected: \\n');
    await result.getByRole('button', { name: 'Show cat -e' }).tap();
    await expect(diff).toContainText('expected: $');
  });

  test('compile errors and forbidden functions are shown', async ({ page }) => {
    await page.route('**/api/practice/*/submissions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        json: {
          submission_id: 9, exercise_id: 'gym_echo_first', mode: 'practice', attempt_no: 2,
          created_at: '2026-11-22T10:00:00Z', verdict: 'FAIL', stage: 'nm',
          message: 'forbidden function: printf', tests: [], first_failure: null,
          compile_stderr: "gym_echo_first.c:3:1: error: expected ';'", forbidden: ['printf'], duration_ms: 5,
        },
      });
    });
    await openPractice(page);
    await page.getByRole('button', { name: 'Grade' }).tap();
    const result = page.getByTestId('result');
    await expect(result).toContainText('forbidden function: printf');
    await expect(result).toContainText('Forbidden functions used: printf');
    await expect(result.locator('.compile')).toContainText("error: expected ';'");
  });

  test.describe(() => {
    // A new user with exactly one graded attempt.
    test.use({ account: 'fresh' });
    test('history lists attempts and the solution is revealed after an attempt', async ({ page }) => {
      const first = await page.request.post('/api/practice/gym_echo_first/submissions', {
        data: { filename: 'gym_echo_first.c', source: '' },
      });
      expect(first.status(), await first.text()).toBe(200);
      await openPractice(page);
      await expect(page.locator('.history li')).toHaveCount(1);
      await page.getByRole('button', { name: 'Show the solution' }).tap();
      await expect(page.getByRole('alertdialog')).toContainText('solved without hints');
      await page.getByRole('button', { name: 'Show it' }).tap();
      // The real reference from fixtures/refs/gym_echo_first.c (the stubs sent "/* reference */").
      await expect(page.getByTestId('solution')).toContainText('write(1, "\\n", 1);');
    });
  });

  test('solution is locked before the first attempt', async ({ page }) => {
    await page.route('**/api/practice/*/submissions', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { submissions: [] } }) : route.continue());
    await openPractice(page);
    await expect(page.getByRole('button', { name: 'Show the solution' })).toBeDisabled();
  });

  test.describe(() => {
    // The seeded `e2e` user is id 1, which the draft key below names.
    test.use({ account: 'seed' });
    test('draft autosaves per user and exercise', async ({ page }) => {
      await openPractice(page);
      await focusEditor(page);
      await page.keyboard.type('int x;');
      await page.waitForTimeout(600);
      await page.reload();
      await expect(page.locator('.cm-content')).toBeVisible();
      expect(await editorText(page)).toBe('int x;');
      expect(await page.evaluate(() => localStorage.getItem('ceg:draft:1:gym_echo_first'))).toBe('int x;');
      // Another exercise starts empty.
      await openPractice(page, 'gym_strlen');
      expect(await editorText(page)).toBe('');
    });
  });

  test('autocomplete offers exercise words and C keywords, and can be turned off', async ({ page }) => {
    await openPractice(page);
    await focusEditor(page);
    await page.keyboard.type('wri');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('write');
    await page.keyboard.press('Enter');
    expect(await editorText(page)).toBe('write');
    await page.keyboard.type('(1, "ret');
    expect(await editorText(page)).toBe('write(1, "ret")');
    await page.waitForTimeout(300);
    await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0); // not inside strings
    await page.keyboard.press('End');
    await page.keyboard.type('; // ret');
    await page.waitForTimeout(300);
    await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0); // not inside comments
    await enter(page);
    await page.keyboard.type('ret');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('return'); // C keyword
    await page.keyboard.press('Escape');

    await page.getByLabel('Practice without autocomplete').check();
    await page.locator('.cm-content').tap();
    await page.keyboard.press('End');
    await enter(page);
    await page.keyboard.type('retu');
    await page.waitForTimeout(300);
    await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
  });

  test('hints panel: warning label and "this hint was wrong"', async ({ page }) => {
    const hint = {
      hint_id: 7, level: 1, text: 'What does your program print when argc is 1?', source: 'llm',
      cached: false, created_at: '2026-11-22T10:01:00Z',
    };
    await page.route('**/api/practice/*/hints', (route) =>
      route.fulfill({
        json: {
          enabled: true, eligible_level: null, reason: 'code_unchanged', failed_runs: 1,
          minutes_on_exercise: 3, quota: { user_day_left: 24, exercise_day_left: 2 }, hints: [hint],
        },
      }));
    let rated: unknown = null;
    await page.route('**/api/hints/7/rating', async (route) => {
      rated = route.request().postDataJSON();
      await route.fulfill({ status: 204 });
    });
    await openPractice(page);
    const panel = page.getByTestId('hints');
    await expect(panel).toContainText('AI hint may be wrong');
    await expect(panel).toContainText(hint.text);
    await panel.getByRole('button', { name: 'This hint was wrong' }).tap();
    await expect(panel).toContainText('marked as wrong');
    expect(rated).toEqual({ rating: 'wrong' });
  });
});

test.describe('exam', () => {
  test('grademe asks for confirmation, 429 cooldown shows a countdown, no hints or solution', async ({ page, exam: _exam }) => {
    let calls = 0;
    const next = new Date(Date.now() + 90_000).toISOString();
    await page.route('**/api/exams/*/grademe', async (route) => {
      calls++;
      await route.fulfill({
        status: 429,
        json: { error: 'cooldown', message: 'Wait for the cooldown.', next_grade_at: next },
      });
    });
    await page.goto('/#/exam');
    await expect(page.getByTestId('clock')).toHaveText(/^\d:\d\d:\d\d$/);
    await expect(page.locator('.cm-content')).toBeVisible();

    // No hint or solution controls anywhere on the exam screen.
    await expect(page.getByTestId('hints')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /hint|solution/i })).toHaveCount(0);

    const grademe = page.getByRole('button', { name: 'grademe' });
    await grademe.tap();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).tap();
    await expect(dialog).toHaveCount(0);
    expect(calls).toBe(0);

    await grademe.tap();
    await dialog.getByRole('button', { name: 'grademe' }).tap();
    const cd = page.getByTestId('cooldown');
    await expect(cd).toBeVisible();
    await expect(cd).toContainText(/1:[23]\d/);
    expect(calls).toBe(1);
    await expect(page.locator('.bottombar .grade')).toBeDisabled();
    const first = await cd.textContent();
    await expect.poll(() => cd.textContent(), { timeout: 3000 }).not.toBe(first);
  });

  test('profile picker starts an exam; status and finish work', async ({ page }) => {
    await page.route('**/api/exams/current', (route) =>
      route.fulfill({ status: 404, json: { error: 'not_found', message: 'No active exam.' } }));
    await page.goto('/#/exam');
    await expect(page.getByRole('radio', { name: /Piscine exam/ })).toBeChecked();
    await page.getByRole('button', { name: 'Start exam' }).tap();
    await expect(page.getByTestId('exam-status')).toContainText('Question 1 / 16');
    await page.getByRole('button', { name: 'status' }).tap();
    await page.getByRole('button', { name: 'finish' }).tap();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Finish' }).tap();
    await expect(page.getByRole('heading', { name: /Exam finished/ })).toBeVisible();
  });
});

test.describe('layout and inputs', () => {
  test('every input and the editor compute font-size >= 16px; viewport meta has no maximum-scale', async ({ page, exam: _exam }) => {
    const meta = await page.goto('/').then(() =>
      page.locator('meta[name="viewport"]').getAttribute('content'));
    expect(meta).toContain('viewport-fit=cover');
    expect(meta).not.toMatch(/maximum-scale/);
    expect(meta).not.toMatch(/user-scalable\s*=\s*no/);

    const sizes = (p: Page) =>
      p.locator('input, textarea, select, .cm-content').evaluateAll((els) =>
        els.map((e) => ({ el: e.tagName + '.' + e.className, px: parseFloat(getComputedStyle(e).fontSize) })));

    // Login and register forms.
    await page.route('**/api/me', (r) => r.fulfill({ status: 401, json: { error: 'unauthorized', message: 'Log in.' } }));
    await page.reload();
    await page.getByRole('tab', { name: 'Register' }).tap();
    const login = await sizes(page);
    expect(login.length).toBe(3);
    for (const s of login) expect(s.px, s.el).toBeGreaterThanOrEqual(16);
    await page.unroute('**/api/me');

    for (const url of ['/#/practice/gym_echo_first', '/#/exam']) {
      await page.goto(url);
      await page.reload();
      await expect(page.locator('.cm-content')).toBeVisible();
      const s = await sizes(page);
      expect(s.some((x) => x.el.includes('cm-content'))).toBe(true);
      for (const x of s) expect(x.px, `${url} ${x.el}`).toBeGreaterThanOrEqual(16);
    }
  });

  test('cm_edit_context=off turns off EditContext (Android path)', async ({ page }) => {
    test.skip(!/Android/.test(await page.evaluate(() => navigator.userAgent)), 'EditContext is Android-only in CodeMirror');
    await openPractice(page);
    const hasEditContext = () =>
      page.locator('.cm-content').evaluate((el) => (el as HTMLElement & { editContext?: unknown }).editContext != null);
    expect(await hasEditContext()).toBe(true);
    await page.evaluate(() => localStorage.setItem('cm_edit_context', 'off'));
    await page.reload();
    await expect(page.locator('.cm-content')).toBeVisible();
    expect(await hasEditContext()).toBe(false);
  });

  test('no horizontal page overflow at device width', async ({ page }) => {
    for (const url of ['/#/', '/#/practice/gym_echo_first', '/#/exam']) {
      await page.goto(url);
      await expect(page.getByTestId('disclaimer')).toBeVisible();
      const [w, sw] = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
      expect(sw, url).toBeLessThanOrEqual(w);
      expect(w, url).toBe(page.viewportSize()!.width);
    }
  });

  test('editor content attributes and tab settings', async ({ page }) => {
    await openPractice(page);
    const c = page.locator('.cm-content');
    await expect(c).toHaveAttribute('autocorrect', 'off');
    await expect(c).toHaveAttribute('autocapitalize', 'off');
    await expect(c).toHaveAttribute('spellcheck', 'false');
    await expect(c).toHaveAttribute('enterkeyhint', 'enter');
    expect(await c.evaluate((el) => getComputedStyle(el).tabSize)).toBe('4');
  });

  test('footer disclaimer on every screen', async ({ page }) => {
    for (const url of ['/#/', '/#/practice/gym_strlen', '/#/exam']) {
      await page.goto(url);
      await expect(page.getByTestId('disclaimer')).toContainText(DISCLAIMER);
    }
    await page.route('**/api/me', (r) => r.fulfill({ status: 401, json: { error: 'unauthorized', message: 'x' } }));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(page.getByTestId('disclaimer')).toContainText(DISCLAIMER);
  });

  test('exercise list shows levels, marks and the "solved without hints" headline', async ({ page }) => {
    await page.route('**/api/exercises', (r) => r.fulfill({
      json: {
        exercises: [
          { id: 'gym_echo_first', level: 0, kind: 'program', attempts: 2, solved: true, solved_without_hints: true },
          { id: 'gym_strlen', level: 1, kind: 'function', attempts: 3, solved: true, solved_without_hints: false },
        ],
      },
    }));
    await page.goto('/#/');
    await expect(page.getByTestId('progress')).toContainText('1 / 2 solved without hints');
    await expect(page.getByRole('heading', { name: 'Level 0' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Level 1' })).toBeVisible();
    await expect(page.getByText('★ no hints')).toBeVisible();
    await expect(page.getByText('✓ solved')).toBeVisible();
  });

  test('login and register reach the exercise list', async ({ page }, testInfo) => {
    const invite = newInvite();
    const friend = `friend-${testInfo.workerIndex}-${testInfo.retry}`;
    await page.route('**/api/me', (r) => r.fulfill({ status: 401, json: { error: 'unauthorized', message: 'x' } }));
    await page.goto('/');
    await page.getByLabel('Username').fill(LOGIN_DEMO.username);
    await page.getByLabel('Password').fill(LOGIN_DEMO.password);
    await page.getByRole('button', { name: 'Log in' }).tap();
    await expect(page.getByTestId('progress')).toBeVisible();

    await page.getByRole('button', { name: 'Log out' }).tap();
    await page.getByRole('tab', { name: 'Register' }).tap();
    await page.getByLabel('Invite code').fill(invite);
    await page.getByLabel('Username').fill(friend);
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).tap();
    await expect(page.getByRole('alert')).toContainText('at least 10');
    await page.getByLabel('Password').fill(E2E.password);
    await page.getByRole('button', { name: 'Create account' }).tap();
    await expect(page.getByTestId('progress')).toBeVisible();
  });
});

test('npm run check:cm reports one copy each of @codemirror/state and @codemirror/view', () => {
  const out = execFileSync('node', [path.join(here, '..', 'scripts', 'check-cm.mjs')], { encoding: 'utf8' });
  expect(out).toContain('@codemirror/state: 1 copy');
  expect(out).toContain('@codemirror/view: 1 copy');
});
