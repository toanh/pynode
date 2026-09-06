// Light / dark theming.
//
// Dark is the unconditional default: the dark palette sits on bare :root and light
// applies only under [data-theme="light"]. prefers-color-scheme is deliberately not
// consulted, so these tests emulate BOTH OS settings and expect dark from each.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, openPopup, bg, DARK, LIGHT, startHarness, waitForIsolation } from './helpers.mjs';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

for (const os of ['light', 'dark']) {
    test(`a first visit is dark even when the OS prefers ${os}`, async () => {
        const { context, page } = await openApp(harness, { colorScheme: os, waitForWorker: false });
        try {
            assert.equal(await bg(page, 'body'), DARK);
            assert.equal(await page.evaluate(() => window.PyNodeTheme.resolved()), 'dark');
            // No explicit choice yet, so nothing should have been written.
            assert.equal(
                await page.evaluate(() => document.documentElement.getAttribute('data-theme')), null);
        } finally {
            await context.close();
        }
    });
}

test('the toggle switches to light and the choice survives a reload', async () => {
    const { context, page } = await openApp(harness, { colorScheme: 'dark', waitForWorker: false });
    try {
        assert.equal(await page.evaluate(() => !!document.querySelector('.themeToggle')), true,
            'toggle was not injected into the .appSectionTitle strip');

        await page.click('.themeToggle');
        await page.waitForTimeout(400);
        assert.equal(await bg(page, 'body'), LIGHT);
        assert.equal(await page.evaluate(() => localStorage.getItem('pynode-theme')), 'light');

        // An explicit LIGHT choice must beat a dark OS. Inverting this guard is the
        // single easiest mistake to make in the CSS, so it is asserted directly.
        await page.reload({ waitUntil: 'load' });
        
        await waitForIsolation(page);
        assert.equal(await bg(page, 'body'), LIGHT, 'explicit light lost to the dark OS setting');

        await page.click('.themeToggle');
        await page.waitForTimeout(400);
        assert.equal(await bg(page, 'body'), DARK);
    } finally {
        await context.close();
    }
});

// Node and edge colours come from Color.DARK_GREY / LIGHT_GREY in pynode_graphlib.py, so
// a dark canvas would wreck their contrast. --bg-canvas is intentionally not themed.
test('the graph canvas stays light in both themes', async () => {
    const { context, page } = await openApp(harness, { waitForWorker: false });
    try {
        assert.equal(await bg(page, '#outputBox'), 'rgb(255, 255, 255)');
        await page.evaluate(() => window.PyNodeTheme.set('light'));
        await page.waitForTimeout(300);
        assert.equal(await bg(page, '#outputBox'), 'rgb(255, 255, 255)');
    } finally {
        await context.close();
    }
});

// These three used to have their background set from JavaScript as an inline style, which
// beats any stylesheet rule and silently defeated the whole theme.
test('run/stop/restart are themeable and carry no inline style', async () => {
    const { context, page } = await openApp(harness, { waitForWorker: false });
    try {
        assert.equal(
            await page.evaluate(() => document.getElementById('run').getAttribute('style')), null,
            'an inline style is back on #run - it will override the theme');

        const dark = await bg(page, '#run');
        await page.evaluate(() => window.PyNodeTheme.set('light'));
        await page.waitForTimeout(300);
        const light = await bg(page, '#run');
        assert.notEqual(dark, light, '#run did not change with the theme');
    } finally {
        await context.close();
    }
});

test('Monaco follows the theme, including on a first visit', async () => {
    const { context, page } = await openApp(harness, { colorScheme: 'light', waitForWorker: false });
    try {
        const monacoBg = () => page.evaluate(() => {
            const el = document.querySelector('.monaco-editor .monaco-editor-background') ||
                       document.querySelector('.monaco-editor');
            return el ? getComputedStyle(el).backgroundColor : 'none';
        });
        const dark = await monacoBg();
        assert.match(dark, /rgb\(30, 30, 30\)/, `Monaco booted light: ${dark}`);

        await page.evaluate(() => window.PyNodeTheme.set('light'));
        await page.waitForTimeout(500);
        const light = await monacoBg();
        // Monaco's "vs" theme background is #FFFFFE, not pure white - do not assert an
        // exact rgb(255,255,255) here.
        assert.match(light, /^rgb\(255, 255, 25[0-5]\)$/, `expected a light editor, got ${light}`);
    } finally {
        await context.close();
    }
});

test('detached windows follow the main window over BroadcastChannel', async () => {
    const { context, page } = await openApp(harness, { waitForWorker: false });
    try {
        const popup = await openPopup(page, 'consolePopup');
        assert.equal(await bg(popup, 'body'), DARK, 'popup did not open in the default theme');

        await page.evaluate(() => window.PyNodeTheme.set('light'));
        await popup.waitForFunction(
            () => document.documentElement.getAttribute('data-theme') === 'light', { timeout: 10000 });
        // style.css transitions background-color over 0.2s, and getComputedStyle returns
        // the INTERPOLATED value mid-transition - reading immediately yields the old
        // colour and looks like a sync failure.
        await popup.waitForTimeout(400);
        assert.equal(await bg(popup, 'body'), LIGHT);

        await popup.close();
    } finally {
        await context.close();
    }
});
