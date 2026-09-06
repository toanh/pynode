// input() and output streaming - everything that crosses the worker/page boundary while
// user code is blocked.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, runCode, waitIdle, consoleText, state, startHarness, waitForConsole } from './helpers.mjs';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

const hasField = (page) =>
    page.evaluate(() => !!document.querySelector('#console .consoleInput'));

test('input() shows an inline field and feeds the answer back to Python', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'n = int(input("Enter a num: "))\nprint("square is " + str(n * n))\n');
        await page.waitForFunction(
            () => !!document.querySelector('#console .consoleInput'), { timeout: 30000 });

        assert.match(await consoleText(page), /Enter a num:/, 'prompt must paint before we block');

        await page.focus('#console .consoleInput');
        await page.keyboard.type('42');
        await page.keyboard.press('Enter');
        await waitIdle(page, 30000);

        const text = await consoleText(page);
        assert.match(text, /Enter a num: 42/, 'the answer should be echoed into the transcript');
        assert.match(text, /square is 1764/);
        assert.equal(await hasField(page), false, 'the field should be removed after submitting');
    } finally {
        await context.close();
    }
});

// Returning EOF here would surface as an EOFError traceback from user code, and leave the
// queued SIGINT to fire at an arbitrary later bytecode. builtins.input is wrapped so this
// ends the run as a clean "Stopped" instead.
test('Stop during a pending input() ends cleanly, with no traceback', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'x = input("waiting: ")\nprint("never")\n');
        await page.waitForFunction(
            () => !!document.querySelector('#console .consoleInput'), { timeout: 30000 });

        await page.click('#stop');
        await waitIdle(page, 20000);

        const text = await consoleText(page);
        assert.doesNotMatch(text, /Traceback|EOFError/, `got: ${text.slice(-200)}`);
        assert.doesNotMatch(text, /never/);
        assert.equal(await hasField(page), false);

        await runCode(page, 'print("alive after stop")\n');
        await waitIdle(page);
        assert.match(await consoleText(page), /alive after stop/);
    } finally {
        await context.close();
    }
});

test('Escape in the input field stops the run', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'x = input("esc test: ")\nprint("never")\n');
        await page.waitForFunction(
            () => !!document.querySelector('#console .consoleInput'), { timeout: 30000 });

        await page.focus('#console .consoleInput');
        await page.keyboard.press('Escape');
        await waitIdle(page, 20000);

        assert.doesNotMatch(await consoleText(page), /never/);
    } finally {
        await context.close();
    }
});

// time.sleep is monkeypatched onto pump(). Before that, this exact snippet printed
// nothing for ten seconds and then dumped everything at once.
test('time.sleep() streams output as it goes', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'from time import sleep\nfor i in range(10):\n    print(i)\n    sleep(1)\n');

        // Causal assertion, not interval sampling: "2" must be on screen while the run is
        // STILL GOING. If output were buffered to the end (the bug this fixes) it could
        // only ever appear after the state went idle. A slow machine cannot break this;
        // a fixed-interval snapshot comparison would.
        const { elapsed } = await waitForConsole(page, /\b2\b/, 30000);
        assert.equal(await state(page), 'playing', 'output only appeared once the run had ended');
        assert.ok(elapsed >= 1800, `saw "2" after only ${elapsed}ms - sleep() is not really sleeping`);

        await waitIdle(page, 60000);
        assert.match(await consoleText(page), /0 1 2 3 4 5 6 7 8 9/);
    } finally {
        await context.close();
    }
});

// The sleep patch alone does not cover this: sink() only runs when a command is emitted,
// so a loop that prints without sleeping needs the time-budget flush.
test('a CPU-bound loop streams too', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'for i in range(3000000):\n    if i % 100000 == 0:\n        print(i)\n');
        // Same shape: output must arrive while the loop is still running.
        await waitForConsole(page, /\b100000\b/, 30000);
        assert.equal(await state(page), 'playing',
            'output only appeared at the end - the time-budget flush is not working');
        await page.evaluate(() => window.PyNodeHost.stop());
    } finally {
        await context.close();
    }
});

test('Stop interrupts a long sleep', async () => {
    const { context, page } = await openApp(harness);
    try {
        await runCode(page, 'from time import sleep\nprint("sleeping")\nsleep(30)\nprint("never")\n');
        await page.waitForTimeout(2000);
        assert.equal(await state(page), 'playing');

        const t0 = Date.now();
        await page.click('#stop');
        await waitIdle(page, 20000);
        assert.ok(Date.now() - t0 < 10000);
        assert.doesNotMatch(await consoleText(page), /never/);
    } finally {
        await context.close();
    }
});
