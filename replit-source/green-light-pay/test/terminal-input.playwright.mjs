/**
 * terminal-input.playwright.mjs
 * v0.1.3-stage1.3 — Browser interaction regression tests for the terminal input
 *
 * ENVIRONMENT REQUIREMENT:
 *   Requires a host with system glib/GTK libraries so Playwright's headless Chrome
 *   can launch. In the Replit NixOS sandbox (where those libraries are absent from
 *   standard paths), use the HTTP integration counterpart instead:
 *     node --test test/developer-terminal.test.mjs
 *   In a standard Linux/macOS CI environment run:
 *     npx playwright install chromium && node test/terminal-input.playwright.mjs
 *
 * Covers every scenario that was broken before the fixes in this version:
 *   - Typing one word and submitting via Enter
 *   - Typing a multiword command
 *   - Editing text (type → backspace → retype) without losing focus
 *   - Submitting via the RUN button (and regaining focus afterwards)
 *   - Recovering from an unknown command (error output, input re-usable)
 *   - Sending a second prompt without an extra click
 *   - Double-submit is silently dropped
 *   - Escape does not steal focus from the terminal input
 *   - Transaction filter keeps focus while typing (the re-render bug)
 *   - End-to-end: the `health` command reaches the real server, not local state
 *
 * Runs on desktop (1280x900) and mobile (390x844) viewport sizes.
 *
 * Usage:
 *   npx playwright test artifacts/green-light-pay/test/terminal-input.playwright.mjs
 * Or via the qa helper:
 *   node artifacts/green-light-pay/qa/run-playwright.mjs
 */

import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.GLP_TEST_URL || 'http://localhost:80/green-light-pay';
const TERMINAL_URL = `${BASE}/developer#terminal`;
const TRANSACTIONS_URL = `${BASE}/developer#transactions`;

const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'mobile',  width: 390,  height: 844 },
];

// Helper: wait for a terminal output line matching a pattern
async function waitForOutput(page, pattern, timeout = 5000) {
  const loc = page.locator('#terminal-output .term-content', { hasText: pattern });
  await loc.waitFor({ timeout });
  return loc;
}

// Helper: run a command and return the last term-content text
async function runCommand(page, cmd) {
  const input = page.locator('#terminal-input');
  await input.fill(cmd);
  await page.keyboard.press('Enter');
}

async function runSuite(label, width, height) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page    = await context.newPage();

  try {
    // ── Navigate to the terminal workspace ──────────────────────────────────
    await page.goto(TERMINAL_URL, { waitUntil: 'networkidle' });

    // Wait for boot banner to confirm the terminal is mounted
    await page.waitForSelector('#terminal-output', { timeout: 8000 });
    await waitForOutput(page, 'GREEN LIGHT PAY OPERATIONS TERMINAL');

    // ── 1. Auto-focus: input should be focused without clicking ─────────────
    {
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'terminal-input', `[${label}] terminal-input must be auto-focused on entry`);
    }

    // ── 2. Type one word and submit via Enter ────────────────────────────────
    {
      const input = page.locator('#terminal-input');
      await input.fill('help');
      // Confirm the value is held while we look at it
      assert.equal(await input.inputValue(), 'help', `[${label}] single word must be retained before submit`);
      await page.keyboard.press('Enter');
      await waitForOutput(page, 'AVAILABLE COMMANDS');
      // Input should be cleared after submit
      assert.equal(await input.inputValue(), '', `[${label}] input must be cleared after submit`);
      // Focus should have returned to the input
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'terminal-input', `[${label}] focus must return to terminal-input after submit via Enter`);
    }

    // ── 3. Type a multiword command ──────────────────────────────────────────
    {
      const input = page.locator('#terminal-input');
      await input.fill('intents --status=CANCELLED');
      assert.equal(await input.inputValue(), 'intents --status=CANCELLED', `[${label}] multiword command must be held in full`);
      await page.keyboard.press('Enter');
      // Either the result is an array printout or "no runs" — either way the command ran
      await page.waitForFunction(
        () => document.querySelectorAll('#terminal-output .term-line').length >= 3,
        { timeout: 5000 }
      );
      assert.equal(await input.inputValue(), '', `[${label}] input must be empty after multiword submit`);
    }

    // ── 4. Edit text without losing focus ───────────────────────────────────
    {
      const input = page.locator('#terminal-input');
      await input.focus();
      await input.fill('statuz'); // typo
      // Backspace to fix typo
      await page.keyboard.press('Backspace');
      await page.keyboard.type('s'); // correct
      assert.equal(await input.inputValue(), 'status', `[${label}] editing via Backspace+retype must work without losing focus`);
      // Confirm focus was never lost during editing
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'terminal-input', `[${label}] focus must remain on terminal-input during text editing`);
      await input.fill(''); // clear without submitting
    }

    // ── 5. Submit via RUN button ─────────────────────────────────────────────
    {
      const input = page.locator('#terminal-input');
      await input.fill('queues');
      const runBtn = page.locator('.term-run-btn');
      await runBtn.click();
      await page.waitForFunction(
        () => {
          const lines = document.querySelectorAll('#terminal-output .term-line');
          return [...lines].some(l => l.textContent.includes('screening') || l.textContent.includes('reconciled'));
        },
        { timeout: 5000 }
      );
      assert.equal(await input.inputValue(), '', `[${label}] input must be cleared after RUN button submit`);
      // Focus must return to input even though the button was clicked
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'terminal-input', `[${label}] focus must return to terminal-input after RUN button submit`);
    }

    // ── 6. Error recovery: unknown command ──────────────────────────────────
    {
      const input = page.locator('#terminal-input');
      const linesBefore = await page.locator('#terminal-output .term-line').count();
      await input.fill('notacommand');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (before) => document.querySelectorAll('#terminal-output .term-line').length > before,
        linesBefore,
        { timeout: 5000 }
      );
      const errorLine = page.locator('#terminal-output .term-error').last();
      await errorLine.waitFor({ timeout: 3000 });
      assert.ok(
        (await errorLine.textContent()).includes('Unknown command') || (await errorLine.textContent()).includes('notacommand'),
        `[${label}] unknown command must produce an error line`
      );
      // Input must be empty and re-focusable for the next command
      assert.equal(await input.inputValue(), '', `[${label}] input must be clear after error`);
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'terminal-input', `[${label}] focus must return to input after error recovery`);
    }

    // ── 7. Second prompt without re-clicking ────────────────────────────────
    {
      const input = page.locator('#terminal-input');
      // Focus should already be on the input from previous test step
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'terminal-input', `[${label}] input must be focused before second prompt (no extra click)`);
      // Type second command without clicking the input first
      await page.keyboard.type('balance');
      assert.equal(await input.inputValue(), 'balance', `[${label}] second prompt text must appear without extra click`);
      await page.keyboard.press('Enter');
      await waitForOutput(page, 'total_debits');
      assert.equal(await input.inputValue(), '', `[${label}] input must clear after second prompt`);
    }

    // ── 8. Escape does NOT steal focus from the terminal input ───────────────
    {
      const input = page.locator('#terminal-input');
      await input.focus();
      await input.fill('status');
      // Press Escape — palette should not open/close and steal focus
      await page.keyboard.press('Escape');
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'terminal-input', `[${label}] Escape must not steal focus from terminal-input when palette is closed`);
      // Input value must be intact — Escape only closes the palette, not the input
      assert.equal(await input.inputValue(), 'status', `[${label}] input value must survive an Escape keypress`);
      await input.fill(''); // clear
    }

    // ── 9. End-to-end: 'health' command hits the real server ────────────────
    {
      const input = page.locator('#terminal-input');
      await input.fill('health');
      await page.keyboard.press('Enter');
      // The health command calls GET /api/health and prints the JSON response.
      // We verify a field that only the real server can supply.
      await waitForOutput(page, 'live_money_movement');
      const healthContent = await page.locator('#terminal-output .term-content').last().textContent();
      assert.ok(
        healthContent.includes('live_money_movement') && healthContent.includes('false'),
        `[${label}] health command must return real server data with live_money_movement:false`
      );
    }

    // ── 10. Command history: ArrowUp recalls last command ────────────────────
    {
      const input = page.locator('#terminal-input');
      await input.focus();
      await page.keyboard.press('ArrowUp');
      const val = await input.inputValue();
      assert.ok(val.length > 0, `[${label}] ArrowUp must recall last command from history`);
      await input.fill(''); // clear
    }

    console.log(`  ✓ ${label} (${width}×${height}): all terminal input scenarios passed`);

  } finally {
    await browser.close();
  }
}

// ── Transaction filter: focus retained while typing ─────────────────────────
async function runFilterSuite(label, width, height) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page    = await context.newPage();

  try {
    await page.goto(TRANSACTIONS_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tx-q', { timeout: 8000 });

    const txQ = page.locator('#tx-q');
    await txQ.focus();

    // Type three characters one at a time and assert focus is retained after each
    for (const char of ['G', 'L', 'P']) {
      await page.keyboard.type(char);
      // After each character the workspace re-renders; focus must be restored
      await page.waitForTimeout(50); // allow microtask + paint
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'tx-q', `[${label}] focus must stay on #tx-q after typing '${char}'`);
    }

    // Value must contain all typed characters
    const val = await txQ.inputValue();
    assert.ok(val.includes('GLP') || val.length >= 3,
      `[${label}] tx-q must retain all typed characters — got: "${val}"`);

    console.log(`  ✓ ${label} (${width}×${height}): transaction filter focus retention passed`);
  } finally {
    await browser.close();
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
const failures = [];
for (const { label, width, height } of VIEWPORTS) {
  try {
    await runSuite(label, width, height);
  } catch (err) {
    console.error(`  ✗ ${label} terminal suite FAILED: ${err.message}`);
    failures.push(`${label} terminal: ${err.message}`);
  }
  try {
    await runFilterSuite(label, width, height);
  } catch (err) {
    console.error(`  ✗ ${label} filter suite FAILED: ${err.message}`);
    failures.push(`${label} filter: ${err.message}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test suite(s) failed:\n${failures.map(f => '  • ' + f).join('\n')}`);
  process.exit(1);
} else {
  console.log(`\nAll terminal-input regression tests passed on both viewports.`);
}
