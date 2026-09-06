// Cross-origin isolation, via the REAL production path.
//
// Every other test file runs against a server that sends COOP/COEP itself, which makes
// the page isolated on its first paint and skips coi-serviceworker.js entirely. That is a
// deliberate speed and determinism win, but it means the service worker - which is how
// GitHub Pages actually gets isolated, since Pages cannot send headers - would otherwise
// go untested. This file is that test. It must never be skipped.
//
// What is asserted here is the riskiest assumption in the whole design: COOP: same-origin
// is required for SharedArrayBuffer, and it also governs whether window.opener survives.
// The three detached windows depend on the opener; the blocking worker depends on the SAB.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startHarness, waitForIsolation, TIMEOUTS } from './helpers.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PAGES = ['index.html', 'pynode_editor.html', 'pynode_console.html', 'pynode_output.html'];

let harness;
// coi: 'none' - no headers from the server, exactly like GitHub Pages.
before(async () => { harness = await startHarness({ coi: 'none' }); });
after(async () => { await harness?.close(); });

// A cheap static check that catches the most likely regression directly: someone moves
// the shim out of the repo root (breaking its service-worker scope) or drops it from a
// page. Either would silently cost isolation on the deployed site.
test('every page loads coi-serviceworker.js from the root, before anything else', async () => {
    for (const p of PAGES) {
        const html = await readFile(join(ROOT, p), 'utf8');
        const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]);
        assert.ok(scripts.length > 0, `${p} has no scripts?`);
        assert.equal(scripts[0], 'coi-serviceworker.js',
            `${p} must load coi-serviceworker.js first, got ${scripts[0]}`);
    }
});

test('the service worker delivers isolation on all four pages', async () => {
    for (const p of PAGES) {
        const context = await harness.browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(`${harness.origin}/${p}`, { waitUntil: 'load' });
            await waitForIsolation(page);
            assert.equal(await page.evaluate(() => window.crossOriginIsolated), true, `${p} not isolated`);
            assert.equal(await page.evaluate(() => typeof SharedArrayBuffer), 'function', `${p} has no SAB`);
        } finally {
            await context.close();
        }
    }
});

// COOP: same-origin puts a document in its own browsing context group unless the opener
// is same-origin AND reports the same COOP value. The shim gives every page in scope
// identical headers, so openers survive - but this is exactly the sort of thing that
// differs between browsers, and the entire popup feature rests on it.
test('window.opener and shared memory survive COOP across all three popups', async () => {
    const context = await harness.browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(`${harness.origin}/index.html`, { waitUntil: 'load' });
        await waitForIsolation(page);
        await page.waitForFunction(() => window.editor_exists === true, { timeout: TIMEOUTS.editor });
        await page.evaluate(() => { window.__probe = 'hello-from-opener'; });

        for (const fn of ['editorPopup', 'consolePopup', 'outputPopup']) {
            const [popup] = await Promise.all([
                page.waitForEvent('popup', { timeout: 15000 }),
                page.evaluate((f) => window[f](700, 500), fn),
            ]);
            await popup.waitForLoadState('load');
            await waitForIsolation(popup);

            assert.equal(
                await popup.evaluate(() => {
                    try { return window.opener ? window.opener.__probe : 'NO OPENER'; }
                    catch (e) { return 'THREW ' + e; }
                }),
                'hello-from-opener', `${fn} lost its opener`);

            // A SharedArrayBuffer can only cross windows in the same agent cluster.
            assert.equal(
                await popup.evaluate(() => {
                    try {
                        window.opener.__sab = new SharedArrayBuffer(8);
                        new Int32Array(window.opener.__sab)[0] = 7;
                        return new Int32Array(window.opener.__sab)[0] === 7;
                    } catch { return false; }
                }),
                true, `${fn} is not in the opener's agent cluster`);

            await popup.close();
        }
    } finally {
        await context.close();
    }
});
