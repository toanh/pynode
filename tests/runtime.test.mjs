// The Pyodide worker and the blocking execution model.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, runCode, waitIdle, consoleText, circleCount, state, startHarness } from './helpers.mjs';

const EXAMPLES = ['dijkstra', 'dfs', 'prims', 'cannibals', 'tictactoe', 'greek_islands'];

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

test('the worker boots real CPython and reports ready', async () => {
    const { context, page } = await openApp(harness);
    try {
        assert.equal(await state(page), 'idle');
        const text = await consoleText(page);
        assert.match(text, /Ready \(Python 3\./, `console said: ${text}`);
    } finally {
        await context.close();
    }
});

test('a script runs, prints, and renders', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page,
            'a = Node(1)\nb = Node(2)\ngraph.add_node(a)\ngraph.add_node(b)\n' +
            'graph.add_edge(Edge(a, b))\nprint("hello from pyodide")\n');
        await waitIdle(page);
        assert.match(await consoleText(page), /hello from pyodide/);
        // Two real nodes plus the two invisible layout boundary nodes.
        assert.ok(await circleCount(page) >= 2);
    } finally {
        await context.close();
    }
});

// pause() used to only queue a marker that was replayed later; it now genuinely sleeps
// the worker. The observable consequence is that output BEFORE the pause is on screen
// while the pause is still running.
test('pause() blocks while the main thread keeps rendering', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, [
            'a = Node(1); graph.add_node(a)',
            'print("first")',
            'pause(2000)',
            'b = Node(2); graph.add_node(b)',
            'print("second")',
        ].join('\n'));

        await page.waitForTimeout(900);
        // Read state and console in ONE evaluate. Two separate round-trips leave a window
        // in which the run can finish between them, which would make this flaky.
        const mid = await page.evaluate(() => ({
            state: window.PyNodeHost.state(),
            text: document.getElementById('console').innerText.replace(/\s+/g, ' ').trim(),
        }));
        assert.equal(mid.state, 'playing', 'the run had already finished - pause() did not block');
        assert.match(mid.text, /first/, 'output before the pause should already be visible');
        assert.doesNotMatch(mid.text, /second/, 'the pause did not actually block');

        // The page must stay responsive while the worker sleeps. This is a generous upper
        // bound on purpose: the claim is "not frozen", not "fast".
        const t0 = Date.now();
        await page.evaluate(() => document.body.offsetHeight);
        assert.ok(Date.now() - t0 < 1000, 'main thread was blocked during pause()');

        await waitIdle(page, 30000);
        assert.match(await consoleText(page), /first second Done/);
    } finally {
        await context.close();
    }
});

// The headline fix of the port: this used to freeze the tab permanently.
test('Stop interrupts an infinite loop, and the page survives', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'print("looping")\nwhile True:\n    pass\n');
        await page.waitForTimeout(2000);
        assert.equal(await state(page), 'playing');

        const t0 = Date.now();
        await page.click('#stop');
        await waitIdle(page, 20000);
        assert.ok(Date.now() - t0 < 10000, 'Stop took too long to bite');

        await runCode(page, 'print("still alive")\n');
        await waitIdle(page);
        assert.match(await consoleText(page), /still alive/);
    } finally {
        await context.close();
    }
});

test('pause and resume', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'for i in range(10):\n    print(i)\n    pause(400)\n');
        await page.waitForTimeout(1200);
        await page.click('#run');                       // -> pause
        assert.equal(await state(page), 'paused');

        const before = await consoleText(page);
        await page.waitForTimeout(2000);
        assert.equal(await consoleText(page), before, 'output moved while paused');

        await page.click('#run');                       // -> resume
        await page.waitForTimeout(1500);
        assert.notEqual(await consoleText(page), before, 'output did not resume');

        await page.evaluate(() => window.PyNodeHost.stop());
    } finally {
        await context.close();
    }
});

test('node.position() returns real coordinates', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, [
            'a = Node(1); graph.add_node(a)',
            'b = Node(2); graph.add_node(b)',
            'graph.add_edge(Edge(a, b))',
            'pause(700)',
            'print("pos=" + str(a.position()))',
        ].join('\n'));
        await waitIdle(page, 30000);

        const m = (await consoleText(page)).match(/pos=\((-?\d+), (-?\d+)\)/);
        assert.ok(m, 'position() printed nothing parseable');
        assert.ok(Math.abs(+m[1]) + Math.abs(+m[2]) > 0, 'position() returned the origin');
    } finally {
        await context.close();
    }
});

// tictactoe registers a click listener and then ENDS; the whole game is delay() chains
// fired from callbacks long after the script returned. That is why the worker keeps a
// JS-owned idle tick rather than a Python loop.
test('click listeners and delay() chains still fire after the script ends', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, [
            'def later():',
            '    print("delayed-after-click")',
            'def on_click(node):',
            '    print("clicked-" + str(node.value()))',
            '    delay(later, 300)',
            'register_click_listener(on_click)',
            'a = Node(7)',
            'graph.add_node(a)',
            'print("script-ended")',
        ].join('\n'));
        await waitIdle(page, 30000);
        assert.match(await consoleText(page), /script-ended/);

        await page.evaluate(() => {
            const n = window.greuler_instance.graph.nodes.filter((x) => x.id < 900);
            if (n.length) window.clickNode(n[0].id);
        });
        await page.waitForFunction(
            () => document.getElementById('console').innerText.includes('delayed-after-click'),
            { timeout: 15000 });

        const text = await consoleText(page);
        assert.match(text, /clicked-7/);
        assert.match(text, /delayed-after-click/);
    } finally {
        await context.close();
    }
});

for (const name of EXAMPLES) {
    test(`shipped example runs without error: ${name}`, async () => {
        const { context, page } = await openApp(harness);
        try {
            const src = await fetch(`${harness.origin}/pynode_projects/${name}.py`).then((r) => r.text());
            await runCode(page, src);
            // Long animations will still be mid-flight; we are asserting "no traceback",
            // not "finished", so give it a slice of time and then inspect.
            await page.waitForTimeout(5000);
            const text = await consoleText(page);
            assert.doesNotMatch(text, /Traceback (most recent call last)/, `${name} produced: ${text.slice(-250)}`);
            assert.ok(await circleCount(page) > 0, `${name} rendered nothing`);
        } finally {
            await context.close();
        }
    });
}
