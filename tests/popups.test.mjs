// The three detached windows.
//
// There is exactly ONE Python runtime, owned by the main page. pynode_output.html used to
// boot its own Brython interpreter; it is now a pure render target that the opener drives
// through graph_api.js, and its buttons call back into window.opener.PyNodeHost.
//
// Exactly ONE output window owns the render stream. Rendering to both was tried and
// reverted - each window runs an independent WebCola layout at its own size, so the two
// pictures never agree. Popping out MOVES the output: while the popup is open it draws every
// run, the docked panel shows a placeholder, and the current graph travels across in both
// directions (PyNodeHost popOut/popIn).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, openPopup, runCode, waitIdle, consoleText, waitForConsole, startHarness } from './helpers.mjs';

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

const popped = (page) => page.evaluate(() => document.body.classList.contains('output-popped'));

// While popped out the popup is THE output: Play on the main page must draw there too,
// rather than on the docked panel the user is no longer looking at.
test('while the output is popped out, every run draws in the popup', async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'outputPopup');
        try {
            assert.equal(await popped(page), true, 'the docked panel is not showing the placeholder');

            await runCode(page, SCRIPT);                   // Play on the MAIN page
            await waitIdle(page, 40000);
            assert.equal(await graphNodes(popup), 2, 'a run started on the main page did not draw in the popup');
            assert.equal(await graphNodes(page), 0, 'the docked panel drew while popped out');

            await page.evaluate((s) => window.editor.setValue(s), SCRIPT3);
            await popup.click('#run');                     // Play in the POPUP
            await waitIdle(page, 40000);
            assert.equal(await graphNodes(popup), 3, 'the popup did not render the run started in it');
            assert.equal(await graphNodes(page), 0, 'the docked panel drew while popped out');
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

// The reported bug: popping out opened a BLANK window and left the graph behind, and closing
// it lost whatever had been drawn there. The graph has to travel both ways, including a
// path coloured by traverse(keep_path=True), which greuler keeps only in the DOM.
test('popping out carries the graph across, and closing brings it back', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, [
            'a = Node("a"); b = Node("b"); c = Node("c")',
            'graph.add_all([a, b, c])',
            'e1 = Edge(a, b); e2 = Edge(b, c)',
            'graph.add_all([e1, e2])',
            'e1.traverse(a, Color.RED, True)',
            'pause(600)',
        ].join('\n'));
        await waitIdle(page, 40000);
        assert.equal(await graphNodes(page), 3);

        const edges = (w) => w.evaluate(() => greuler_instance.graph.edges.map((e) => e.keptStroke || e.stroke));
        const strokesBefore = await edges(page);
        assert.equal(new Set(strokesBefore).size, 2, `expected one traversed and one plain edge: ${strokesBefore}`);
        const popup = await openPopup(page, 'outputPopup');
        let closed = false;
        try {
            assert.equal(await graphNodes(popup), 3, 'the popup opened without the current graph');
            assert.deepEqual((await edges(popup)).sort(), [...strokesBefore].sort(),
                "the edges, or the traversed path's colour, did not come across");
            assert.equal(await graphNodes(page), 0, 'the docked panel kept a stale copy');
            assert.equal(await popped(page), true);
            assert.equal(await page.evaluate(() => typeof clickListener), 'undefined',
                'the docked panel kept a live click listener');

            await popup.close({ runBeforeUnload: true });
            closed = true;
            await page.waitForFunction(() => !document.body.classList.contains('output-popped'));
            assert.equal(await graphNodes(page), 3, 'closing the popup did not bring the graph back');
            assert.deepEqual((await edges(page)).sort(), [...strokesBefore].sort(),
                "the traversed path's colour was lost on the way back");
            assert.equal(await page.evaluate(() => typeof clickListener), 'function',
                'clicks were not handed back to the docked panel');
        } finally {
            if (!closed) await popup.close();
        }
    } finally {
        await context.close();
    }
});

// The button bar is only pushed on a state CHANGE, so a popup opened mid-run read PLAY.
test('popping out mid-run shows PAUSE in the popup', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'graph.add_node(Node(1))\npause(4000)\n');
        await page.waitForFunction(() => window.PyNodeHost.state() === 'playing');
        const popup = await openPopup(page, 'outputPopup');
        try {
            const shown = await popup.evaluate(() =>
                ['runPlay', 'runPause'].map((id) => document.getElementById(id).style.display));
            assert.deepEqual(shown, ['none', 'inherit'], `popup buttons out of step with the run: ${shown}`);
        } finally {
            await popup.close();
        }
        await page.click('#stop');
    } finally {
        await context.close();
    }
});

// Positions copied across at pop-out do not survive the layout, and nothing pulled the
// graph back to the middle: it settled in a corner of the bigger popup canvas. It must be
// re-centred on pop-out, and again on the way back.
const graphCentre = (w) => w.evaluate(() => {
    const ns = getGraphNodes();
    const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
    const [W, H] = layoutSize();
    return {
        dx: (Math.min(...xs) + Math.max(...xs)) / 2 - W / 2,
        dy: (Math.min(...ys) + Math.max(...ys)) / 2 - H / 2,
    };
});

test('a popped-out graph is centred, and so is the graph brought back', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'graph.add_all(graph.random(12, 15))\n');
        await waitIdle(page, 30000);
        const popup = await openPopup(page, 'outputPopup');
        let closed = false;
        try {
            await popup.waitForTimeout(2000);
            let c = await graphCentre(popup);
            assert.ok(Math.abs(c.dx) < 15 && Math.abs(c.dy) < 15,
                `the popped-out graph is off-centre by (${Math.round(c.dx)}, ${Math.round(c.dy)})`);

            await popup.close({ runBeforeUnload: true });
            closed = true;
            await page.waitForTimeout(2000);
            c = await graphCentre(page);
            assert.ok(Math.abs(c.dx) < 15 && Math.abs(c.dy) < 15,
                `the graph brought back is off-centre by (${Math.round(c.dx)}, ${Math.round(c.dy)})`);
        } finally {
            if (!closed) await popup.close();
        }
    } finally {
        await context.close();
    }
});

test('a popped-out console starts with the transcript so far', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'print("first line")\nprint("second line")\n');
        await waitIdle(page, 30000);
        const popup = await openPopup(page, 'consolePopup');
        try {
            const text = await popup.evaluate(() =>
                document.getElementById('console').innerText.replace(/\s+/g, ' ').trim());
            assert.match(text, /first line/, `the popup console is missing earlier output: ${text}`);
            assert.match(text, /second line/);
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

// A pending input() prompt must follow the console into the popup, or the program sits
// waiting on a field the user can no longer see.
test('a pending input() moves into the popped-out console, and back', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'name = input("Name? ")\nprint("hello " + name)\nname = input("Again? ")\nprint("bye " + name)\n');
        await page.waitForFunction(() => !!document.querySelector('#console .consoleInput'), null, { timeout: 30000 });

        const popup = await openPopup(page, 'consolePopup');
        let closed = false;
        try {
            assert.equal(await popup.evaluate(() => !!document.querySelector('#console .consoleInput')), true,
                'the input field did not move into the popup');
            assert.equal(await page.evaluate(() => !!document.querySelector('#console .consoleInput')), false,
                'the main console kept a second input field');
            await popup.fill('#console .consoleInput', 'Ada');
            await popup.press('#console .consoleInput', 'Enter');
            await waitForConsole(page, 'hello Ada', 15000);

            // The second prompt is asked in the popup; closing it must hand the field back.
            await popup.waitForFunction(() => !!document.querySelector('#console .consoleInput'), null, { timeout: 15000 });
            await popup.close({ runBeforeUnload: true });
            closed = true;
            await page.waitForFunction(() => !!document.querySelector('#console .consoleInput'), null, { timeout: 5000 });
            await page.fill('#console .consoleInput', 'Bob');
            await page.press('#console .consoleInput', 'Enter');
            await waitForConsole(page, 'bye Bob', 15000);
            await waitIdle(page, 15000);
        } finally {
            if (!closed) await popup.close();
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
        const listener = (w) => w.evaluate(() => typeof clickListener);
        await runCode(page, SCRIPT);
        await waitIdle(page, 40000);
        assert.equal(await listener(page), 'function', 'the docked panel has no listener');

        const popup = await openPopup(page, 'outputPopup');
        try {
            // Whichever window's Play is pressed, the popup owns the stream while open.
            for (const where of [page, popup]) {
                await where.click('#run');
                await waitIdle(page, 40000);
                assert.equal(await listener(popup), 'function', 'the popped-out output has no listener');
                assert.equal(await listener(page), 'undefined',
                    'the docked panel kept a live click listener while popped out');
            }
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
