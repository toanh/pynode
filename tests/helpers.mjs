// Shared helpers for the PyNode browser tests.

import { startServer } from './server.mjs';
import { launch } from './browser.mjs';

// --bg-chrome in each palette. See the token block at the top of css/style.css.
export const DARK = 'rgb(45, 45, 48)';
export const LIGHT = 'rgb(82, 82, 82)';

export const TIMEOUTS = {
    editor: 30000,    // editor_exists
    boot: 120000,     // PyNodeHost.isReady() - Pyodide, cold cache
    run: 60000,       // a typical script reaching idle
    long: 180000,     // sleep(1)x10, the example sweep
};

/**
 * Start a server and a browser for one test file.
 *
 * Each file gets its own harness rather than sharing one: the server costs nothing to
 * start, an ephemeral port cannot collide with a hand-started server on 8000, and a
 * distinct origin per file means localStorage and service-worker state cannot leak
 * between files. `coi` is passed straight through to the server - see server.mjs.
 */
export async function startHarness({ coi = 'headers' } = {}) {
    const server = await startServer({ coi });
    const browser = await launch();
    return {
        origin: server.origin,
        browser,
        close: async () => {
            await browser.close().catch(() => {});
            await server.close();
        },
    };
}

/**
 * Open the app in a FRESH BrowserContext and wait until it is actually usable.
 *
 * A fresh context per test is deliberate: localStorage carries the editor contents
 * ("code") and the theme ("pynode-theme") between tests, and the theme tests need their
 * own colorScheme emulation anyway. Clean-by-construction beats remembering to clear the
 * right keys. Pyodide's wasm is served from the browser's shared HTTP cache after the
 * first fetch, so a repeat boot is a few seconds, not a fresh 13 MB download.
 *
 * `waitForWorker: false` skips the Pyodide wait entirely - use it for any test that only
 * touches the editor, the theme or the chrome, which is most of them.
 */
export async function openApp(harness, opts = {}) {
    const {
        colorScheme = 'light',
        page: pagePath = 'index.html',
        waitForWorker = true,
        storage,
    } = opts;

    const contextOpts = { colorScheme };
    // Seed localStorage declaratively. An addInitScript that clears it would race the
    // inline <head> script in index.html that reads "pynode-theme" before the stylesheet,
    // and would also re-clear on reload, breaking the "persists across reload" assertion.
    if (storage) {
        contextOpts.storageState = {
            cookies: [],
            origins: [{
                origin: harness.origin,
                localStorage: Object.entries(storage).map(([name, value]) => ({ name, value })),
            }],
        };
    }

    const context = await harness.browser.newContext(contextOpts);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.pynodeErrors = errors;

    await page.goto(`${harness.origin}/${pagePath}`, { waitUntil: 'load' });
    await waitForIsolation(page);

    if (pagePath.startsWith('index.html')) {
        await page.waitForFunction(() => window.editor_exists === true, { timeout: TIMEOUTS.editor });
        if (waitForWorker) {
            await page.waitForFunction(
                () => window.PyNodeHost && window.PyNodeHost.isReady(), { timeout: TIMEOUTS.boot });
        }
    }
    return { context, page };
}

/**
 * Wait for cross-origin isolation.
 *
 * With the default server this is already true on the first paint and returns
 * immediately. Under `coi: 'none'` the service worker has to register and reload the
 * page once, which is what this loop is for.
 */
export async function waitForIsolation(page, tries = 30) {
    for (let i = 0; i < tries; i++) {
        const ok = await page.evaluate(() => window.crossOriginIsolated === true).catch(() => false);
        if (ok) return true;
        await page.waitForTimeout(400);
        if (i === 3 || i === 12) await page.reload({ waitUntil: 'load' }).catch(() => {});
    }
    throw new Error('Page never became cross-origin isolated - is coi-serviceworker.js served from the root?');
}

/** Put source in the editor and press Run. */
export async function runCode(page, src) {
    await page.evaluate((s) => window.editor.setValue(s), src);
    await page.click('#run');
}

export function state(page) {
    return page.evaluate(() => window.PyNodeHost.state());
}

export async function waitIdle(page, timeout = TIMEOUTS.run) {
    await page.waitForFunction(() => window.PyNodeHost.state() === 'idle', { timeout });
}

/**
 * Console text with whitespace normalised.
 *
 * NOT cosmetic: pynode_core.format_string_HTML turns every space into &nbsp;, which
 * innerText returns as U+00A0, so a naive .includes("hello world") silently fails. This
 * produced a false failure once already. js/pynode_host.js mirrors the same escaping in
 * escapeConsole() for the echoed input() answer, so both halves need it.
 */
export function consoleText(page) {
    return page.evaluate(() =>
        document.getElementById('console').innerText.replace(/\s+/g, ' ').trim());
}

/**
 * Wait until the console matches, and report how long it took.
 *
 * The elapsed time is the point: timing assertions should be LOWER bounds ("output
 * appeared no sooner than the sleep allows"), never upper bounds or fixed-interval
 * sampling, which fail on a loaded machine for no good reason.
 */
export async function waitForConsole(page, matcher, timeout = TIMEOUTS.run) {
    const started = Date.now();
    const test = typeof matcher === 'string'
        ? (t) => t.includes(matcher)
        : (t) => matcher.test(t);
    while (Date.now() - started < timeout) {
        const text = await consoleText(page);
        if (test(text)) return { text, elapsed: Date.now() - started };
        await page.waitForTimeout(100);
    }
    throw new Error(`console never matched ${matcher} in ${timeout}ms; last: ${await consoleText(page)}`);
}

export function bg(page, selector) {
    return page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, selector);
}

export function circleCount(page) {
    return page.evaluate(() => document.querySelectorAll('#output circle').length);
}

/** Open one of the detached windows and wait for it to load. */
export async function openPopup(page, fn) {
    const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15000 }),
        page.evaluate((f) => window[f](800, 600), fn),
    ]);
    await popup.waitForLoadState('load');
    await popup.waitForTimeout(500);
    return popup;
}
