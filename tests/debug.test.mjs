// The debugger: breakpoints, stepping, the frozen program, and what a pause reports.
//
// Engine: pynode_debug.py (sys.monitoring) in the worker. The host relays commands through
// the shared control block and receives "__debug" / "__trace" reports in-band.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, openPopup, runCode, waitIdle, consoleText, waitForConsole, startHarness, TIMEOUTS } from './helpers.mjs';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

const view = (page) => page.evaluate(() => window.PyNodeHost.debugView());

/** Wait until the debugger reports a stop, and return the snapshot. */
async function stopped(page, timeout = 15000) {
    await page.waitForFunction(() => {
        const v = window.PyNodeHost.debugView();
        return v.state === 'paused' && v.snapshot && v.snapshot.state === 'paused';
    }, null, { timeout });
    return (await view(page)).snapshot;
}

/** Issue a step/continue and wait for the NEXT stop (or for the run to leave the stop). */
async function step(page, fn) {
    await page.evaluate((f) => {
        window.__seen = window.PyNodeHost.debugView().snapshot;
        window.PyNodeHost[f]();
    }, fn);
    await page.waitForFunction(() => {
        const s = window.PyNodeHost.debugView().snapshot;
        return s !== window.__seen && s && s.state === 'paused';
    }, null, { timeout: 15000 });
    return (await view(page)).snapshot;
}

const value = (vars, name) => (vars.find((v) => v.n === name) || {}).r;

const PROGRAM = [
    'def double(x):',          // 1
    '    y = x * 2',            // 2
    '    return y',             // 3
    'a = 1',                    // 4
    'b = double(a)',            // 5
    'print("b is", b)',         // 6
].join('\n') + '\n';

test('a breakpoint stops on its line with the variables, and Continue finishes', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.evaluate(() => window.PyNodeHost.setBreakpoints([5]));
        await runCode(page, PROGRAM);
        const s = await stopped(page);
        assert.equal(s.line, 5);
        assert.deepEqual(s.frames.map((f) => f.name), ['<main>']);
        assert.equal(value(s.globals, 'a'), '1');
        assert.equal(value(s.globals, 'b'), undefined, 'b is not assigned yet');
        assert.equal((await consoleText(page)).includes('b is'), false, 'ran past the breakpoint');

        await page.evaluate(() => window.PyNodeHost.continueRun());
        await waitForConsole(page, 'Done');
        assert.match(await consoleText(page), /b is 2/);
    } finally {
        await context.close();
    }
});

test('step into, step over and step out', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.evaluate(() => window.PyNodeHost.setBreakpoints([5]));
        await runCode(page, PROGRAM);
        await stopped(page);

        let s = await step(page, 'stepInto');
        assert.equal(s.line, 2, 'step into did not enter double()');
        assert.deepEqual(s.frames.map((f) => f.name), ['double', '<main>']);
        assert.equal(value(s.locals, 'x'), '1');

        s = await step(page, 'stepOver');
        assert.equal(s.line, 3);
        assert.equal(value(s.locals, 'y'), '2');

        s = await step(page, 'stepOut');
        assert.deepEqual(s.frames.map((f) => f.name), ['<main>'], 'step out did not return to the caller');
        assert.ok([5, 6].includes(s.line), `step out stopped on line ${s.line}`);

        // Step over a call: from line 5 in a fresh run, the next stop is line 6, not inside.
        await page.evaluate(() => window.PyNodeHost.stop());
        await waitIdle(page);
        await runCode(page, PROGRAM);
        await stopped(page);
        s = await step(page, 'stepOver');
        assert.equal(s.line, 6, 'step over went into the function');
        assert.equal(value(s.globals, 'b'), '2');
        await page.evaluate(() => window.PyNodeHost.continueRun());
        await waitForConsole(page, 'Done');
    } finally {
        await context.close();
    }
});

test('step into from idle starts the run stopped on its first line', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.evaluate((src) => window.editor.setValue(src), PROGRAM);
        await page.evaluate(() => window.PyNodeHost.stepInto());
        const s = await stopped(page);
        assert.equal(s.line, 1);
        await page.evaluate(() => window.PyNodeHost.continueRun());
        await waitForConsole(page, 'Done');
    } finally {
        await context.close();
    }
});

// The program is frozen while stopped: a delay() callback that is due must not run until
// the user continues.
test('a stopped program is frozen: delay() callbacks wait for Continue', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.evaluate(() => window.PyNodeHost.setBreakpoints([4]));
        await runCode(page, [
            'def later():',
            '    print("timer fired")',
            'delay(later, 100)',
            'x = 1',
            'pause(300)',
        ].join('\n') + '\n');
        await stopped(page);
        await page.waitForTimeout(800);
        assert.equal((await consoleText(page)).includes('timer fired'), false, 'a timer ran while stopped');
        await page.evaluate(() => window.PyNodeHost.continueRun());
        await waitForConsole(page, 'timer fired');
    } finally {
        await context.close();
    }
});

test('Stop while stopped at a breakpoint ends the run cleanly', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.evaluate(() => window.PyNodeHost.setBreakpoints([5]));
        await runCode(page, PROGRAM);
        await stopped(page);
        await page.click('#stop');
        await waitIdle(page);
        const text = await consoleText(page);
        assert.doesNotMatch(text, /Traceback|Error/, `stop left a traceback: ${text}`);
        // Nothing is live after a run: no stale stack or variables are kept on show.
        const end = (await view(page)).snapshot;
        assert.equal(end.state, 'ended');
        assert.equal(end.reason, 'stopped');
        assert.deepEqual([end.frames, end.locals, end.globals, end.watches], [[], [], [], []]);
    } finally {
        await context.close();
    }
});

// Pause is a debugger break, wherever the program is: inside pause(), or in a loop that
// never reaches pause() at all (reached through SIGUSR1 in Pyodide's interrupt buffer).
test('Pause breaks into a pause() and into a tight loop', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'for i in range(100):\n    pause(3000)\n');
        await page.waitForTimeout(500);
        await page.click('#run');
        let s = await stopped(page);
        assert.equal(s.line, 2, 'did not break on the pause() line');
        assert.equal(value(s.globals, 'i'), '0');
        await page.click('#stop');
        await waitIdle(page);

        await runCode(page, 'n = 0\nwhile True:\n    n += 1\n');
        await page.waitForTimeout(500);
        await page.click('#run');
        s = await stopped(page);
        assert.ok([2, 3].includes(s.line), `broke on line ${s.line}`);
        assert.ok(Number(value(s.globals, 'n')) > 0);
        await page.click('#stop');
        await waitIdle(page);
    } finally {
        await context.close();
    }
});

test('a breakpoint added mid-run takes effect, even in a tight loop', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'n = 0\nwhile True:\n    n += 1\n    m = n\n');
        await page.waitForTimeout(500);
        await page.evaluate(() => window.PyNodeHost.setBreakpoints([4]));
        const s = await stopped(page);
        assert.equal(s.line, 4);
        await page.click('#stop');
        await waitIdle(page);
    } finally {
        await context.close();
    }
});

// tictactoe-style programs end and then run entirely from callbacks.
test('a breakpoint in a click handler fires after the script has ended', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.evaluate(() => window.PyNodeHost.setBreakpoints([2]));
        await runCode(page, [
            'def on_click(node):',
            '    print("clicked", node.value())',
            'register_click_listener(on_click)',
            'graph.add_node(Node(7))',
        ].join('\n') + '\n');
        await waitIdle(page);
        await page.evaluate(() => {
            const n = getGraphNodes();
            if (n.length) window.clickNode(n[0].id);
        });
        const s = await stopped(page);
        assert.equal(s.line, 2);
        assert.deepEqual(s.frames.map((f) => f.name), ['on_click']);
        assert.match(value(s.locals, 'node'), /Node\(7/);
        await page.evaluate(() => window.PyNodeHost.continueRun());
        await waitForConsole(page, 'clicked 7');
        assert.equal(await page.evaluate(() => window.PyNodeHost.state()), 'idle');
    } finally {
        await context.close();
    }
});

test('watches are evaluated at each stop, and a broken watch reports its error', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.evaluate(() => {
            window.PyNodeHost.setWatches(['a + 10', 'nope + 1']);
            window.PyNodeHost.setBreakpoints([5]);
        });
        await runCode(page, PROGRAM);
        const s = await stopped(page);
        assert.equal(s.watches[0].r, '11');
        assert.equal(s.watches[0].ok, true);
        assert.equal(s.watches[1].ok, false);
        assert.match(s.watches[1].r, /NameError/);
        await page.evaluate(() => window.PyNodeHost.continueRun());
        await waitForConsole(page, 'Done');
    } finally {
        await context.close();
    }
});

test('Record logs executed lines with changed variables; off, the log stays empty', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'x = 1\nx = 2\n');
        await waitIdle(page);
        assert.deepEqual(await page.evaluate(() => window.PyNodeHost.traceLog()), [], 'traced without Record');

        await page.evaluate(() => window.PyNodeHost.setRecord(true));
        await runCode(page, 'x = 1\nx = 2\ny = x\n');
        await waitIdle(page);
        const log = await page.evaluate(() => window.PyNodeHost.traceLog());
        assert.deepEqual(log.map((e) => e.line), [1, 2, 3]);
        assert.deepEqual(log[1].changed, { x: '1' }, 'line 2 should see x=1 from line 1');
        assert.deepEqual(log[2].changed, { x: '2' });
    } finally {
        await context.close();
    }
});

// Normal runs must not pay for the debugger: the example sweep in runtime.test.mjs guards
// timing; this guards a hot loop with breakpoints set elsewhere.
test('breakpoints elsewhere do not slow a hot loop', async () => {
    const { context, page } = await openApp(harness);
    try {
        // The breakpoint sits in a function that is never called, so the run never stops.
        const timed = async () => {
            const t0 = Date.now();
            await runCode(page, 'def unused():\n    return 1\nfor i in range(300000):\n    x = i * 2\nprint("end")\n');
            await waitIdle(page, TIMEOUTS.run);
            return Date.now() - t0;
        };
        const plain = await timed();
        await page.evaluate(() => window.PyNodeHost.setBreakpoints([2]));
        const withBp = await timed();
        assert.ok(withBp < plain * 2 + 500, `breakpoints elsewhere slowed the loop: ${plain}ms -> ${withBp}ms`);
    } finally {
        await context.close();
    }
});

// --- UI -------------------------------------------------------------------------------

/** Click the editor's glyph margin beside `line`. */
async function clickMargin(page, line) {
    const at = await page.evaluate((n) => {
        const ed = window.editor.monaco;
        ed.revealLineInCenter(n);
        const box = ed.getDomNode().getBoundingClientRect();
        const info = ed.getLayoutInfo();
        return {
            x: box.left + info.glyphMarginLeft + info.glyphMarginWidth / 2,
            y: box.top + ed.getTopForLineNumber(n) - ed.getScrollTop() + 8,
        };
    }, line);
    await page.mouse.click(at.x, at.y);
}

const bps = (w) => w.evaluate(() => JSON.stringify(window.editor.getBreakpoints()));

test('clicking the margin sets and clears a breakpoint, which survives a reload and syncs', async () => {
    const { context, page } = await openApp(harness, { waitForWorker: false });
    try {
        await page.evaluate((src) => window.editor.setValue(src), PROGRAM);
        await clickMargin(page, 5);
        assert.equal(await bps(page), '[5]');
        assert.equal(await page.locator('.pynodeBreakpoint').count(), 1, 'no breakpoint dot drawn');

        // Lines inserted above move it.
        await page.evaluate(() => window.editor.monaco.executeEdits('t', [{
            range: new monaco.Range(1, 1, 1, 1), text: '# comment\n' }]));
        assert.equal(await bps(page), '[6]');

        // The editor popup mirrors it, both ways.
        const popup = await openPopup(page, 'editorPopup');
        try {
            await popup.waitForFunction(() => window.editor_exists === true);
            await popup.waitForFunction(() => JSON.stringify(window.editor.getBreakpoints()) === '[6]');
            await popup.evaluate(() => window.editor.toggleBreakpoint(2));
            await page.waitForFunction(() => JSON.stringify(window.editor.getBreakpoints()) === '[2,6]');
        } finally {
            await popup.close();
        }

        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => window.editor_exists === true);
        await page.waitForFunction(() => JSON.stringify(window.editor.getBreakpoints()) === '[2,6]');

        await clickMargin(page, 6);
        assert.equal(await bps(page), '[2]');
    } finally {
        await context.close();
    }
});

test('the editor marks the stopped line, and the header step buttons drive the session', async () => {
    const { context, page } = await openApp(harness);
    try {
        const dimmed = (id) => page.evaluate((i) => +getComputedStyle(document.getElementById(i)).opacity < 0.5, id);
        await page.waitForTimeout(300);   // the buttons fade in from the boot state
        assert.equal(await dimmed('stepOver'), true, 'step over looks live while idle');
        assert.equal(await dimmed('stepInto'), false, 'step into should be live while idle');

        await page.evaluate((src) => window.editor.setValue(src), PROGRAM);
        await page.evaluate(() => window.editor.setBreakpoints([5]));
        await page.click('#run');
        await stopped(page);
        await page.waitForTimeout(300);   // opacity transition
        assert.equal(await dimmed('stepOver'), false, 'step over looks dead while stopped');
        const marked = await page.evaluate(() =>
            window.editor.monaco.getLineDecorations(5).some((d) => d.options.className === 'pynodeDebugLine'));
        assert.equal(marked, true, 'line 5 is not highlighted as the stopped line');

        await page.evaluate(() => { window.__seen = window.PyNodeHost.debugView().snapshot; });
        await page.click('#stepInto');
        await page.waitForFunction(() => window.PyNodeHost.debugView().snapshot !== window.__seen &&
            window.PyNodeHost.debugView().snapshot.state === 'paused');
        assert.equal((await view(page)).snapshot.line, 2);

        await page.click('#run');           // Continue
        await waitForConsole(page, 'Done');
        const left = await page.evaluate(() => window.editor.monaco.getModel().getAllDecorations()
            .filter((d) => d.options.className === 'pynodeDebugLine').length);
        assert.equal(left, 0, 'the stopped-line highlight outlived the run');
    } finally {
        await context.close();
    }
});

test('the debugger window shows the stack, variables, watches and trace', async () => {
    const { context, page } = await openApp(harness);
    try {
        const [win] = await Promise.all([page.waitForEvent('popup'), page.click('#debugWindowButton')]);
        await win.waitForLoadState('load');
        const status = (re) => win.waitForFunction((src) =>
            new RegExp(src).test(document.getElementById('debugStatus').textContent), re.source);
        await status(/Not running/);

        // A watch added in the window, then a stop inside double().
        await win.fill('#watchInput', 'x * 100');
        await win.press('#watchInput', 'Enter');
        await page.evaluate((src) => window.editor.setValue(src), PROGRAM);
        await page.evaluate(() => window.editor.setBreakpoints([3]));
        await page.click('#run');
        await stopped(page);
        await status(/Stopped at line 3 in double/);

        const stack = await win.$$eval('#stackList .debugFrameName', (els) => els.map((e) => e.textContent));
        assert.deepEqual(stack, ['double', '<main>']);
        const vars = await win.$eval('#varsTree', (e) => e.innerText);
        assert.match(vars, /Locals[\s\S]*x = 1[\s\S]*y = 2/);
        assert.match(await win.$eval('#watchList', (e) => e.innerText), /x \* 100 = 100/);

        // Selecting the caller frame shows its variables, and the watch no longer resolves.
        await win.click('#stackList li:nth-child(2)');
        await status(/Stopped at line 5 in <main>/);
        assert.doesNotMatch(await win.$eval('#varsTree', (e) => e.innerText), /Locals/);
        assert.match(await win.$eval('#watchList', (e) => e.innerText), /NameError/);

        // The window's own step buttons, and the trace log they produce.
        await win.click('#stepOver');
        await status(/Stopped at line 6/);
        const trace = await win.$$eval('#traceList .traceLine', (els) => els.map((e) => e.textContent));
        assert.ok(trace.includes('L3') && trace.includes('L6'), `trace: ${trace.join(' ')}`);

        await win.click('#run');
        await waitForConsole(page, 'Done');
        await status(/Run ended/);
        assert.equal(await win.$$eval('#stackList li', (els) => els.length), 0, 'the stack outlived the run');
        assert.doesNotMatch(await win.$eval('#varsTree', (e) => e.innerText), /=/, 'variables outlived the run');
        assert.ok(await win.$$eval('#traceList li', (els) => els.length) > 0, 'the trace log should be kept');

        // Record from the window logs a whole run.
        await win.check('#traceRecord');
        await page.evaluate(() => window.editor.setBreakpoints([]));
        await runCode(page, 'p = 1\nq = p + 1\n');
        await waitIdle(page);
        await win.waitForFunction(() => document.querySelectorAll('#traceList li').length === 2);
        assert.match(await win.$eval('#traceList', (e) => e.innerText), /L2[\s\S]*p = 1/);
        await win.click('#traceClear');
        await win.waitForFunction(() => document.querySelectorAll('#traceList li').length === 0);
        await win.close();
    } finally {
        await context.close();
    }
});

// The window itself must never scroll - only its panels, and only when they overflow -
// so the title bar and run controls cannot be scrolled out of reach. A long unbreakable
// trace line used to widen the grid until the whole window scrolled both ways.
test('the debugger window does not scroll; only its panels do', async () => {
    const { context, page } = await openApp(harness);
    try {
        const win = await openPopup(page, 'debugPopup');
        await win.setViewportSize({ width: 700, height: 500 });
        await win.check('#traceRecord');
        await page.evaluate(() => window.editor.setBreakpoints([3]));
        await runCode(page, 'h = [1, 5, 27]\nlong_text = "x" * 300\nx = 1\n');
        await stopped(page);
        await win.waitForFunction(() => document.querySelectorAll('#traceList li').length >= 2);

        const s = await win.evaluate(() => ({
            scrollW: document.scrollingElement.scrollWidth, innerW: window.innerWidth,
            scrollH: document.scrollingElement.scrollHeight, innerH: window.innerHeight,
            titleTop: document.querySelector('.outputTitle').getBoundingClientRect().top,
            traceScrolls: (() => { const t = document.getElementById('traceList'); return t.scrollWidth > t.clientWidth; })(),
            emptyStackScrolls: (() => { const t = document.getElementById('watchList'); return t.scrollHeight > t.clientHeight; })(),
        }));
        assert.ok(s.scrollW <= s.innerW, `the window scrolls sideways: ${s.scrollW} > ${s.innerW}`);
        assert.ok(s.scrollH <= s.innerH, `the window scrolls vertically: ${s.scrollH} > ${s.innerH}`);
        assert.equal(s.titleTop, 0, 'the title bar is not pinned to the top');
        assert.equal(s.traceScrolls, true, 'the long trace line should scroll inside its panel');
        assert.equal(s.emptyStackScrolls, false, 'an empty panel shows a scrollbar');

        await page.evaluate(() => window.PyNodeHost.continueRun());
        await waitForConsole(page, 'Done');
        await win.close();
    } finally {
        await context.close();
    }
});

// Stop is SIGINT through Pyodide's interrupt buffer, so it surfaces wherever Python runs
// next - including the worker's idle tick between runs. It used to reach the console as a
// bare "PythonError".
test('pressing Stop never shows a raw Python error', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'print("hello")\n');
        await waitForConsole(page, 'Done');
        for (let i = 0; i < 15; i++) {
            await page.click('#stop');
            await page.waitForTimeout(7 * (i % 4));
        }
        await page.waitForTimeout(500);
        assert.doesNotMatch(await consoleText(page), /PythonError|KeyboardInterrupt|Traceback/,
            'Stop while idle printed a raw error');

        await page.evaluate(() => window.editor.setBreakpoints([2]));
        await runCode(page, 'def fib(n):\n    return n if n <= 1 else fib(n - 1) + fib(n - 2)\nprint(fib(10))\n');
        await stopped(page);
        await page.click('#stop');
        await waitIdle(page);
        await page.waitForTimeout(500);
        const text = await consoleText(page);
        assert.doesNotMatch(text, /PythonError|KeyboardInterrupt|Traceback/, `Stop at a breakpoint printed: ${text}`);
        assert.match(text, /Stopped/);
    } finally {
        await context.close();
    }
});
