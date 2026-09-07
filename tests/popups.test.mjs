// The three detached windows.
//
// There is exactly ONE Python runtime, owned by the main page. pynode_output.html used to
// boot its own Brython interpreter; it is now a pure render target that the opener drives
// through graph_api.js, and its buttons call back into window.opener.PyNodeHost.
//
// Exactly ONE output window owns the render stream, and it is the window whose Play button
// was clicked; the other is blanked. Rendering to both was tried and reverted - each window
// runs an independent WebCola layout at its own size, so the two pictures never agree.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, openPopup, runCode, waitIdle, consoleText, startHarness } from './helpers.mjs';

const SCRIPT =
    'a = Node(1)\nb = Node(2)\ngraph.add_node(a)\ngraph.add_node(b)\n' +
    'graph.add_edge(Edge(a, b))\nprint("popup test output")\n';

// Three nodes, so a re-run is distinguishable from the two-node graph left by SCRIPT.
const SCRIPT3 =
    'ns = [Node(i) for i in range(3)]\n' +
    'for n in ns: graph.add_node(n)\nprint("three nodes")\n';

const popupCircles = (popup) =>
    popup.evaluate(() => document.querySelectorAll('#output circle').length);

// The real node count in a window. NOT a circle count: resize.js injects two invisible
// boundary nodes, and js_clear() re-adds them through updateLayout(), so a blanked window
// still has two zero-radius circles. getGraphNodes() (js/resize.js) filters them out.
const graphNodes = (w) => w.evaluate(() => getGraphNodes().length);

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

            // Play in the POPUP, so the popup owns the stream and must draw the graph.
            await page.evaluate((s) => window.editor.setValue(s), SCRIPT);
            await popup.click('#run');
            await waitIdle(page, 30000);
            const drawn = await popupCircles(popup);
            assert.ok(drawn >= 2, `commands were not routed to the popup (${drawn} circles)`);
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

// The originally reported bug was that Play on the main page left the embedded canvas
// frozen, because the popup owned the stream unconditionally. Ownership now follows the
// Play button that was clicked - and the window that is NOT running is blanked, so there is
// never a stale graph on screen to be mistaken for the current run.
test('only the window where Play was clicked renders; the other is blanked', async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'outputPopup');
        try {
            // Opening the popup does not hand it the stream: it starts blank.
            assert.equal(await graphNodes(popup), 0, 'the popup did not open blank');

            // Play on the MAIN page - main renders, popup stays empty.
            await runCode(page, SCRIPT);
            await waitIdle(page, 40000);
            assert.equal(await graphNodes(page), 2, 'the embedded output did not render');
            assert.equal(await graphNodes(popup), 0,
                'the popup rendered a run that was started on the main page');

            // Play in the POPUP - ownership moves, and the main page is cleared.
            await page.evaluate((s) => window.editor.setValue(s), SCRIPT3);
            await popup.click('#run');
            await waitIdle(page, 40000);
            assert.equal(await graphNodes(popup), 3, 'the popup did not render the run started in it');
            assert.equal(await graphNodes(page), 0,
                'the embedded output was not blanked when the popup took over');
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

// HTML pages carry no ?version=, so a returning browser can hold a stale pynode_output.html
// indefinitely. A stale copy's inline handler calls play() with NO origin, which routes the
// run to the main page - the popup's own Play button appeared to do nothing. PyNodeHost
// binds these buttons itself, from versioned JS, so the page's inline handlers cannot
// mis-route. Ordering here matches reality: the popup's own script binds during load, and
// index.html's pynode_output.onload fires onRenderTargetChanged only afterwards.
test('a stale cached popup page cannot mis-route Play to the main window', async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'outputPopup');
        try {
            await popup.evaluate(() => {
                document.getElementById('run').onclick = function () {
                    var h = window.opener.PyNodeHost, s = h.state();
                    if (s === 'idle') h.play();            // the pre-fix call, no origin
                    else if (s === 'playing') h.pause();
                    else if (s === 'paused') h.resume();
                };
            });
            await page.evaluate(() => window.PyNodeHost.onRenderTargetChanged());

            await page.evaluate((s) => window.editor.setValue(s), SCRIPT3);
            await popup.click('#run');
            await waitIdle(page, 40000);

            assert.equal(await graphNodes(popup), 3,
                'Play in the popup rendered somewhere else');
            assert.equal(await graphNodes(page), 0,
                'the run was routed to the main page');
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

// Clicks follow ownership. A live listener on the window that is not rendering let a click
// on a stale graph feed a bogus node id to the running program.
test('node clicks are only registered in the window that owns the stream', async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'outputPopup');
        try {
            const listener = (w) => w.evaluate(() => typeof clickListener);

            await runCode(page, SCRIPT);
            await waitIdle(page, 40000);
            assert.equal(await listener(page), 'function', 'the active main page has no listener');
            assert.equal(await listener(popup), 'undefined',
                'the inactive popup kept a live click listener');

            await popup.click('#run');
            await waitIdle(page, 40000);
            assert.equal(await listener(popup), 'function', 'the active popup has no listener');
            assert.equal(await listener(page), 'undefined',
                'the inactive main page kept a live click listener');
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
