// The Monaco editor and the ways code gets into it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, openPopup, startHarness, waitForIsolation } from './helpers.mjs';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

test('Monaco loads with Python highlighting and correct sizing', async () => {
    const { context, page } = await openApp(harness, { waitForWorker: false });
    try {
        const s = await page.evaluate(() => ({
            hasMonaco: typeof monaco !== 'undefined',
            hasFacade: !!window.editor,
            language: window.editor.monaco.getModel().getLanguageId(),
            fontSize: window.editor.monaco.getOption(monaco.editor.EditorOption.fontSize),
            editorBoxVisible: getComputedStyle(document.getElementById('editorBox')).visibility,
            mounted: document.querySelectorAll('.monaco-editor').length,
            // Tokenised spans prove the Python grammar actually loaded, not just the editor.
            tokens: document.querySelectorAll('.view-line span[class*="mtk"]').length,
            width: Math.round(document.getElementById('editor').getBoundingClientRect().width),
        }));

        assert.equal(s.hasMonaco, true);
        assert.equal(s.hasFacade, true, 'window.editor facade missing - popups reach through it');
        assert.equal(s.language, 'python');
        assert.equal(s.fontSize, 15);
        assert.equal(s.editorBoxVisible, 'visible');
        assert.equal(s.mounted, 1);
        assert.ok(s.tokens > 10, `expected tokenised source, got ${s.tokens} spans`);
        assert.ok(s.width > 200, `editor did not size to its container (${s.width}px)`);
        assert.deepEqual(page.pynodeErrors, []);
    } finally {
        await context.close();
    }
});

test('the editor facade round-trips code', async () => {
    const { context, page } = await openApp(harness, { waitForWorker: false });
    try {
        const src = '# hello\ngraph.add_node(Node(1))\n';
        const back = await page.evaluate((s) => { window.editor.setValue(s); return window.getCode(); }, src);
        assert.equal(back, src);
    } finally {
        await context.close();
    }
});

// ?project= was doubly broken before the port: it referenced an undefined `pair`
// variable, AND its XHR handler ran on readyState 1/2/3, loading the stored code before
// the request finished. Assert against a project that is NOT the default, or a
// regression would look like a pass.
test('?project= loads the named example, not the default', async () => {
    const context = await harness.browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(`${harness.origin}/index.html?project=tictactoe`, { waitUntil: 'load' });
        
        await waitForIsolation(page);
        await page.waitForFunction(() => window.editor_exists === true, { timeout: 60000 });
        await page.waitForFunction(
            () => window.getCode().length > 0 && window.getCode().indexOf('Tic') !== -1,
            { timeout: 20000 });
        const code = await page.evaluate(() => window.getCode());
        assert.ok(code.includes('Tic Tac Toe'), `got: ${code.slice(0, 60)}`);
    } finally {
        await context.close();
    }
});

// The two editors used to ping-pong full setValue at each other, destroying cursor and
// undo state on every keystroke. They now exchange deltas over BroadcastChannel, which
// also means the editor popup needs no window.opener at all.
test('detached editor stays in sync with the main window, both ways', async () => {
    const { context, page } = await openApp(harness, { waitForWorker: false });
    try {
        await page.evaluate(() => window.editor.setValue('# seed\n'));
        const popup = await openPopup(page, 'editorPopup');
        await popup.waitForFunction(() => window.editor_exists === true, { timeout: 60000 });

        assert.ok((await popup.evaluate(() => window.getCode())).includes('# seed'),
            'popup did not seed from the opener');

        await popup.evaluate(() => window.editor.monaco.setValue('# edited in popup\nx = 1\n'));
        await page.waitForFunction(() => window.getCode().includes('edited in popup'), { timeout: 10000 });

        await page.evaluate(() => window.editor.monaco.setValue('# edited in main\ny = 2\n'));
        await popup.waitForFunction(() => window.getCode().includes('edited in main'), { timeout: 10000 });

        await popup.close();
    } finally {
        await context.close();
    }
});
