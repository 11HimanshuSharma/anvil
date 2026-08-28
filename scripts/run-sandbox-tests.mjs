#!/usr/bin/env node
/**
 * Runs the sandbox containment suite in a real headless Chrome and reports the
 * result as a process exit code, so it can gate a build.
 *
 * `--dump-dom` is not enough: the suite is asynchronous and the watchdog case
 * deliberately takes three seconds, so we drive the page over the DevTools
 * protocol and poll until it reports a summary.
 *
 *   node scripts/run-sandbox-tests.mjs [url]
 *
 * The sandboxed iframe needs a browser that executes scripts in a src-loaded
 * sandbox="allow-scripts" frame. Real Chrome does. Some embedded preview panes
 * do not, and there every case fails at boot - that is the harness, not the app.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:5173/sandbox-tests.html';
const PORT = 9333;
const OVERALL_TIMEOUT_MS = 90_000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('Could not find Chrome. Set CHROME_PATH to its executable.');
  process.exit(2);
}

const profileDir = mkdtempSync(join(tmpdir(), 'anvil-chrome-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    URL_UNDER_TEST,
  ],
  { stdio: 'ignore' },
);

let exitCode = 1;
try {
  const target = await waitForTarget();
  const result = await drive(target.webSocketDebuggerUrl);
  console.log(result.report);
  console.log(result.summary);
  exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(`sandbox tests failed to run: ${error.message}`);
  exitCode = 2;
} finally {
  chrome.kill();
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* Windows sometimes holds the profile briefly; harmless */
  }
}
process.exit(exitCode);

/* ---------------------------------------------------------------- helpers -- */

async function waitForTarget() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('sandbox-tests'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* Chrome is still starting */
    }
    await sleep(250);
  }
  throw new Error('Chrome did not expose the page target in time');
}

function drive(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    const deadline = Date.now() + OVERALL_TIMEOUT_MS;

    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++nextId;
        pending.set(id, { res, rej });
        socket.send(JSON.stringify({ id, method, params }));
      });

    const evaluate = async (expression) => {
      const { result } = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.value;
    };

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.rej(new Error(message.error.message));
        else entry.res(message.result);
      }
    });

    socket.addEventListener('error', () => reject(new Error('DevTools socket error')));

    socket.addEventListener('open', () => {
      void (async () => {
        try {
          await send('Runtime.enable');
          while (Date.now() < deadline) {
            const done = await evaluate(
              "document.getElementById('summary')?.dataset.ok !== undefined && " +
                "document.getElementById('summary')?.textContent.startsWith('SUMMARY')",
            );
            if (done) break;
            await sleep(400);
          }

          const report = await evaluate(
            `[...document.querySelectorAll('.case')].map(el =>
               (el.dataset.pass === 'true' ? 'PASS ' : 'FAIL ') +
               el.querySelector('.case-name').textContent.padEnd(28) +
               el.querySelector('.case-claim').textContent + '\\n       ' +
               el.querySelector('.case-detail').textContent
             ).join('\\n')`,
          );
          const summary = await evaluate("document.getElementById('summary').textContent");
          const ok = await evaluate("document.getElementById('summary').dataset.ok === 'true'");
          socket.close();
          resolve({ report, summary, ok });
        } catch (error) {
          socket.close();
          reject(error);
        }
      })();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
