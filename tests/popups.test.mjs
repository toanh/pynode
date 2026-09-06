// The three detached windows.
//
// There is exactly ONE Python runtime, owned by the main page. pynode_output.html used to
// boot its own Brython interpreter; it is now a pure render target that the opener drives
// through graph_api.js, and its buttons call back into window.opener.PyNodeHost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, openPopup, runCode, waitIdle, consoleText, startHarness } from './helpers.mjs';

const SCRIPT =
    'a = Node(1)\nb = Node(2)\ngraph.add_node(a)\ngraph.add_node(b)\n' +
    'graph.add_edge(Edge(a, b))\nprint("popup test output")\n';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

// The old build suppressed the forward to the detached console whenever the output popup
// was open, so the detached console silently went dead. With one runtime there is one
// output stream and both transcripts get it.
test('a detached console receives output alongside the main one', async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'consolePopup');
        try {
            await runCode(page, SCRIPT);
            await waitIdle(page, 30000);

            const inPopup = await popup.evaluate(() =>
                document.getElementById('console').innerText.replace(/\s+/g, ' ').trim());
            assert.match(inPopup, /popup test output/, 'the detached console got nothing');
            assert.match(await consoleText(page), /popup test output/, 'the main console got nothing');
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

test('a detached output window renders, and runs no Python of its own', async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'outputPopup');
        try {
            assert.equal(await popup.evaluate(() => typeof greuler_instance !== 'undefined'), true,
                'the popup has no greuler instance of its own');
            assert.equal(await popup.evaluate(() => typeof brython === 'undefined'), true,
                'the popup is booting a second Python runtime');

            // Run from the MAIN window; the graph must appear in the POPUP.
            await runCode(page, SCRIPT);
            await waitIdle(page, 30000);
            const drawn = await popup.evaluate(() => document.querySelectorAll('#output circle').length);
            assert.ok(drawn >= 2, `commands were not routed to the popup (${drawn} circles)`);
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

test("the output popup's own Play button drives the opener's worker", async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'outputPopup');
        try {
            await page.evaluate((s) => window.editor.setValue(s), SCRIPT);
            await popup.click('#run');
            await popup.waitForFunction(
                () => document.querySelectorAll('#output circle').length >= 2, { timeout: 40000 });
            // The nodes are drawn by the first commands; the print arrives later. Wait for
            // the run to finish rather than racing it.
            await waitIdle(page, 40000);
            assert.match(await consoleText(page), /popup test output/);
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});
