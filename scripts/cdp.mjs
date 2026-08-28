/**
 * Minimal DevTools-protocol driver: launch headless Chrome, evaluate
 * expressions in a page, tear down. Shared by the sandbox and end-to-end
 * suites so neither has to reimplement the plumbing.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  const path = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!path) {
    console.error('Could not find Chrome. Set CHROME_PATH to its executable.');
    process.exit(2);
  }
  return path;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens `url` in a fresh headless Chrome and hands `fn` an `evaluate` function.
 * Always tears the browser down, even when `fn` throws.
 */
export async function withPage(url, fn, { port = 9333 } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'anvil-chrome-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      // CI containers run as root, where Chrome's own sandbox refuses to start.
      ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      url,
    ],
    { stdio: 'ignore' },
  );

  let socket;
  try {
    const target = await waitForTarget(port, url);
    const connection = await connect(target.webSocketDebuggerUrl);
    socket = connection.socket;
    await connection.send('Runtime.enable');
    // Everything is wrapped in an async IIFE so callers can use `await`
    // freely: a bare Runtime.evaluate expression cannot.
    const call = async (source) => {
      const { result, exceptionDetails } = await connection.send('Runtime.evaluate', {
        expression: source,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      return result.value;
    };

    await connection.send('Page.enable');

    return await fn({
      /** Saves a PNG of the current viewport. */
      screenshot: async (path, { width = 1280, height = 900 } = {}) => {
        await connection.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 2,
          mobile: false,
        });
        const { data } = await connection.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path, Buffer.from(data, 'base64'));
        return path;
      },
      /** Evaluates a single expression and returns its value. */
      evaluate: (expression) => call(`(async () => { return (${expression}); })()`),
      /** Runs a block of statements. Use `return` to send a value back. */
      run: (body) => call(`(async () => { ${body} })()`),
    });
  } finally {
    socket?.close();
    chrome.kill();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the profile briefly; harmless */
    }
  }
}

async function waitForTarget(port, url) {
  const wanted = new URL(url).pathname;
  // Match on pathname only: Chrome may normalise the query string.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === 'page' && new URL(target.url).pathname === wanted,
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* Chrome is still starting */
    }
    await sleep(250);
  }
  throw new Error(`Chrome never exposed a page target for ${url}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = message.id ? pending.get(message.id) : undefined;
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    socket.addEventListener('error', () => reject(new Error('DevTools socket error')));
    socket.addEventListener('open', () =>
      resolve({
        socket,
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          }),
      }),
    );
  });
}

/** Polls `expression` until it evaluates truthy, or throws on timeout. */
export async function waitFor(evaluate, expression, { timeoutMs = 15_000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
