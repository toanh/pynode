// The main page fills the viewport: slim header, full-height editor, docs in a drawer.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, openPopup, startHarness, runCode, waitIdle, waitForConsole, consoleText } from './helpers.mjs';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

async function openSized(opts = {}, size = { width: 1400, height: 1000 }) {
    const app = await openApp(harness, { waitForWorker: false, ...opts });
    await app.page.setViewportSize(size);
    // Let Monaco's automaticLayout catch up with the new size.
    await app.page.waitForTimeout(300);
    return app;
}

test('the page does not scroll and the editor takes the spare height', async () => {
    const { context, page } = await openSized();
    try {
        const s = await page.evaluate(() => {
            const r = (id) => document.getElementById(id).getBoundingClientRect();
            return {
                scrollH: document.scrollingElement.scrollHeight,
                innerH: window.innerHeight,
                editorH: Math.round(r('editor').height),
                editorW: Math.round(r('editor').width),
                outputW: Math.round(r('outputBox').width),
                outputH: Math.round(r('outputBox').height),
                consoleH: Math.round(document.querySelector('.consoleWrapper').getBoundingClientRect().height),
            };
        });
        assert.ok(s.scrollH <= s.innerH, `page scrolls: ${s.scrollH} > ${s.innerH}`);
        assert.ok(s.editorH > 750, `editor only ${s.editorH}px tall in a 1000px window`);
        assert.ok(s.editorW > 750, `editor only ${s.editorW}px wide in a 1400px window`);
        // Fixed on purpose: node.set_position uses pixel coordinates against 500x400.
        assert.equal(s.outputW, 500);
        assert.equal(s.outputH, 400);
        assert.ok(s.consoleH > 300, `console did not take the remaining height (${s.consoleH}px)`);
        assert.deepEqual(page.pynodeErrors, []);
    } finally {
        await context.close();
    }
});

test('the docs drawer opens with the documentation and closes on Escape', async () => {
    const { context, page } = await openSized();
    try {
        const visible = () => page.evaluate(() =>
            getComputedStyle(document.getElementById('docsDrawer')).visibility === 'visible');
        assert.equal(await visible(), false, 'drawer visible before it was opened');

        await page.click('.docsButton');
        await page.waitForFunction(() =>
            document.querySelector('#docsDrawer .docsContent').textContent.includes('graph.add_node'));
        await page.waitForFunction(() =>
            getComputedStyle(document.getElementById('docsDrawer')).visibility === 'visible');

        await page.keyboard.press('Escape');
        await page.waitForFunction(() =>
            getComputedStyle(document.getElementById('docsDrawer')).visibility === 'hidden');
        assert.deepEqual(page.pynodeErrors, []);
    } finally {
        await context.close();
    }
});

test('the docs pop out into their own themed window', async () => {
    const { context, page } = await openSized();
    try {
        const popup = await openPopup(page, 'docsPopup');
        try {
            const s = await popup.evaluate(() => ({
                text: document.querySelector('.docsContent').textContent,
                toggle: !!document.querySelector('.appSectionTitle .themeToggle'),
            }));
            assert.ok(s.text.includes('graph.add_node'), 'popup has no documentation');
            assert.ok(s.text.includes('Alex Socha'), 'popup has no About / credits');
            assert.equal(s.toggle, true, 'theme toggle was not injected into the docs popup');
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});

test('the Examples menu loads an example and closes', async () => {
    const { context, page } = await openSized();
    try {
        await page.evaluate(() => window.editor.setValue('# blank'));
        await page.click('.examplesMenu summary');
        await page.click('.examplesMenuList >> text=Depth First Search');
        await page.waitForFunction(() => window.editor.getValue() !== '# blank');
        const open = await page.evaluate(() => document.querySelector('.examplesMenu').open);
        assert.equal(open, false, 'menu stayed open after choosing an example');
    } finally {
        await context.close();
    }
});

// ~1280x630 CSS px is 1080p at 150% scaling, the common laptop default and the size the
// layout is tuned for: the output is full size AND the console fits below it. On a shorter
// screen the output box scales down instead of pushing the console off the bottom.
const LAPTOP = { width: 1280, height: 630 };
const SHORT = { width: 1280, height: 540 };

for (const [label, size, fullSize] of [['laptop', LAPTOP, true], ['short', SHORT, false]]) test(`at ${label} size everything fits and the console is visible`, async () => {
    const { context, page } = await openSized({}, size);
    try {
        const s = await page.evaluate(() => {
            const r = (el) => (typeof el === 'string' ? document.querySelector(el) : el).getBoundingClientRect();
            const panel = r('.outputWrapper');
            const header = r('.pageHeader');
            const box = (sel) => { const b = r(sel); return { sel, left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
            const buttons = ['#run', '#stop', '#restart'].map(box);
            const controls = r('.runControls');
            return {
                scrollH: document.scrollingElement.scrollHeight,
                innerH: window.innerHeight,
                consoleBottom: r('.consoleWrapper').bottom,
                consoleH: r('.consoleWrapper').height,
                outW: r('#outputBox').width,
                outH: r('#outputBox').height,
                editorW: r('#editor').width,
                panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
                header: { top: header.top, bottom: header.bottom },
                layout: ['#layout1', '#layout2'].map(box),
                buttons,
                controlsMid: (controls.left + controls.right) / 2,
                innerW: window.innerWidth,
            };
        });
        assert.ok(s.scrollH <= s.innerH, `page scrolls: ${s.scrollH} > ${s.innerH}`);
        assert.ok(s.consoleBottom <= s.innerH, `console cut off at ${s.consoleBottom} of ${s.innerH}`);
        assert.ok(s.consoleH >= 120, `console squeezed to ${s.consoleH}px`);
        if (fullSize) {
            assert.equal(s.outW, 500, `output not full width at ${label} size`);
            assert.equal(s.outH, 400, `output not full height at ${label} size`);
        } else {
            assert.ok(s.outW < 500 && s.outH < 400, `output did not scale: ${s.outW}x${s.outH}`);
        }
        assert.ok(Math.abs(s.outW / s.outH - 1.25) < 0.01, `output lost its 5:4 shape: ${s.outW}x${s.outH}`);
        assert.ok(s.editorW > 730, `editor only ${s.editorW}px wide`);
        // Layout toggles stay with the output; run controls live in the header, centred.
        for (const b of s.layout) {
            assert.ok(b.left >= s.panel.left && b.right <= s.panel.right + 0.5
                && b.top >= s.panel.top && b.bottom <= s.panel.bottom,
                `${b.sel} spills out of the output panel`);
        }
        for (const b of s.buttons) {
            assert.ok(b.top >= s.header.top && b.bottom <= s.header.bottom, `${b.sel} is not in the header`);
        }
        assert.ok(Math.abs(s.controlsMid - s.innerW / 2) <= 1,
            `run controls are not centred: middle at ${s.controlsMid} of ${s.innerW}`);
        for (let i = 1; i < 3; i++) {
            assert.ok(s.buttons[i].left >= s.buttons[i - 1].right, `${s.buttons[i].sel} overlaps its neighbour`);
            assert.equal(s.buttons[i].top, s.buttons[0].top, `${s.buttons[i].sel} wrapped onto another row`);
        }
        assert.deepEqual(page.pynodeErrors, []);
    } finally {
        await context.close();
    }
});

// The box shrinks but the graph's coordinate space must not: the docs promise 500x400 and
// node.set_position takes pixels against it. A layout that read the box's clientWidth
// would put the boundary nodes at the on-screen size and squash every graph.
test('a scaled output keeps 500x400 coordinates, and clicks still hit the right node', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.setViewportSize(SHORT);   // short enough that the box really is scaled
        await page.waitForTimeout(300);
        await runCode(page, [
            'def on_click(node):',
            '    print("clicked-" + str(node.value()))',
            'register_click_listener(on_click)',
            'graph.add_node(Node(1))',
            'n = Node(7); graph.add_node(n)',
            'n.set_position(450, 350)',
            'pause(800)',
            'print("pos=" + str(n.position()))',
        ].join('\n'));
        await waitIdle(page, 30000);

        const m = (await consoleText(page)).match(/pos=\((-?[\d.]+), (-?[\d.]+)\)/);
        assert.ok(m, 'position() printed nothing parseable');
        assert.ok(Math.abs(+m[1] - 450) < 1 && Math.abs(+m[2] - 350) < 1,
            `set_position(450, 350) came back as (${m[1]}, ${m[2]})`);

        const corner = await page.evaluate(() => {
            const br = greuler_instance.graph.nodes.find((n) => n.id === 837457);
            return br && [br.x, br.y];
        });
        assert.deepEqual(corner, [499, 399], 'layout boundary is not the 500x400 logical canvas');

        // A real mouse click at the circle's on-screen centre, through the viewBox scaling.
        const target = await page.evaluate(() => {
            const g = [...document.querySelectorAll('#output g.node')]
                // The renderer's ids are internal, not the Python id, so find the node by
                // where set_position put it.
                .find((el) => el.__data__ && Math.abs(el.__data__.x - 450) < 1 && Math.abs(el.__data__.y - 350) < 1);
            const r = g.querySelector('circle').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(target.x, target.y);
        await waitForConsole(page, 'clicked-7', 10000);
        assert.deepEqual(page.pynodeErrors, []);
    } finally {
        await context.close();
    }
});

// The output starts in autosize, and says so. The selected mode used to be applied only
// on a CLICK, so the page showed pan/zoom while running autosize and the canvas ignored
// scroll and drag until you toggled away and back. One click on pan/zoom must be enough.
test('the output starts in autosize, and one click turns pan/zoom on', async () => {
    const { context, page } = await openApp(harness);
    try {
        const shown = await page.evaluate(() =>
            ['layout1On', 'layout2On'].map((id) => document.getElementById(id).style.display));
        assert.deepEqual(shown, ['none', 'inherit'], 'autosize is not the selected layout');
        assert.equal(await page.evaluate(() => doConstraints), true, 'autosize is shown but not applied');

        await runCode(page, 'graph.add_node(Node(1))\ngraph.add_node(Node(2))\n');
        await waitIdle(page, 30000);
        await page.click('#layout1');
        await page.waitForTimeout(600);   // set_layout_type eases the transform back to 1.0
        const transform = () => page.evaluate(() =>
            document.querySelector('#output g.nodes').getAttribute('transform') || '');
        const box = await page.evaluate(() => {
            const r = document.getElementById('outputBox').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        const before = await transform();
        await page.mouse.move(box.x, box.y);
        await page.mouse.wheel(0, -300);
        await page.waitForFunction((b) =>
            (document.querySelector('#output g.nodes').getAttribute('transform') || '') !== b, before, { timeout: 5000 });
        assert.match(await transform(), /scale\((?!1\))/, 'scrolling did not zoom the graph');
    } finally {
        await context.close();
    }
});

test('every button and icon has a tooltip', async () => {
    const { context, page } = await openSized();
    try {
        const missing = await page.evaluate(() =>
            [...document.querySelectorAll(
                '.appSectionEnlarge a, .themeToggle, .docsButton, .examplesMenu summary, ' +
                '#run, #stop, #restart, #layout1, #layout2, .outputPoppedNote a')]
                .filter((el) => !(el.getAttribute('title') || '').trim())
                .map((el) => el.outerHTML.slice(0, 80)));
        assert.deepEqual(missing, [], 'controls without a title');

        for (const fn of ['outputPopup', 'editorPopup']) {
            const popup = await openPopup(page, fn);
            try {
                const bare = await popup.evaluate(() =>
                    [...document.querySelectorAll('.appSectionEnlarge a, #run, #stop, #restart, #layout1, #layout2')]
                        .filter((el) => !(el.getAttribute('title') || '').trim())
                        .map((el) => el.outerHTML.slice(0, 80)));
                assert.deepEqual(bare, [], `${fn}: controls without a title`);
            } finally {
                await popup.close();
            }
        }
    } finally {
        await context.close();
    }
});

// Console spaces arrive as &nbsp;, so a long print never wraps. It used to widen the right
// column (a flex item will not shrink below its content) and push the editor off screen.
test('a long console line scrolls sideways instead of widening the layout', async () => {
    const { context, page } = await openApp(harness);
    try {
        await page.setViewportSize(LAPTOP);
        await page.waitForTimeout(300);
        const widths = () => page.evaluate(() => ({
            editor: Math.round(document.getElementById('editor').getBoundingClientRect().width),
            right: Math.round(document.querySelector('.appRight').getBoundingClientRect().width),
            page: document.scrollingElement.scrollWidth,
            inner: window.innerWidth,
        }));
        const before = await widths();
        await runCode(page, 'print([[0, 10, i] for i in range(200)])\n');
        await waitIdle(page, 30000);
        const after = await widths();
        assert.deepEqual(after, before, 'a long console line changed the layout');
        assert.ok(after.page <= after.inner, `the page scrolls sideways: ${after.page} > ${after.inner}`);
        const scrolls = await page.evaluate(() => {
            const c = document.getElementById('console');
            return c.scrollWidth > c.clientWidth && getComputedStyle(c).overflowX === 'auto';
        });
        assert.equal(scrolls, true, 'the console does not scroll horizontally');
    } finally {
        await context.close();
    }
});

// Icon-only, colour-coded run controls in the header: green play, amber pause, red stop,
// blue restart - and Stop must not look live when there is nothing to stop.
test('the header run controls are colour-coded and Stop is dimmed while idle', async () => {
    const { context, page } = await openApp(harness);
    try {
        const look = () => page.evaluate(() => {
            const shown = ['runPlay', 'runPlayLoad', 'runPause', 'runResume']
                .map((id) => document.getElementById(id))
                .find((el) => getComputedStyle(el).display !== 'none');
            const token = (name) => {
                const probe = document.createElement('span');
                probe.style.color = `var(${name})`;
                document.body.appendChild(probe);
                const c = getComputedStyle(probe).color;
                probe.remove();
                return c;
            };
            return {
                shown: shown && shown.id,
                runColour: getComputedStyle(shown).color,
                stopColour: getComputedStyle(document.querySelector('#stop .runIcon')).color,
                restartColour: getComputedStyle(document.querySelector('#restart .runIcon')).color,
                stopOpacity: +getComputedStyle(document.getElementById('stop')).opacity,
                labels: [...document.querySelectorAll('.runControls h4')].length,
                play: token('--run-play'), pause: token('--run-pause'),
                stop: token('--run-stop'), restart: token('--run-restart'),
            };
        });

        let s = await look();
        assert.equal(s.shown, 'runPlay');
        assert.equal(s.labels, 0, 'the run controls have text labels');
        assert.equal(s.runColour, s.play, 'play is not green');
        assert.equal(s.stopColour, s.stop, 'stop is not red');
        assert.equal(s.restartColour, s.restart, 'restart is not blue');
        assert.ok(s.stopOpacity < 0.5, `stop looks live while idle (opacity ${s.stopOpacity})`);

        await runCode(page, 'graph.add_node(Node(1))\npause(4000)\n');
        await page.waitForFunction(() => window.PyNodeHost.state() === 'playing');
        await page.waitForTimeout(250);   // the opacity transition
        s = await look();
        assert.equal(s.shown, 'runPause');
        assert.equal(s.runColour, s.pause, 'pause is not amber');
        assert.equal(s.stopOpacity, 1, 'stop is still dimmed during a run');
        await page.click('#stop');
    } finally {
        await context.close();
    }
});

// The popped-out output keeps its own run controls - it may be on another screen with the
// main window hidden - but they must be the SAME controls as the header: icon-only,
// colour-coded, centred in its title bar, and driving the one shared run.
test('the output popup has the same run controls as the header', async () => {
    const { context, page } = await openApp(harness);
    try {
        const popup = await openPopup(page, 'outputPopup');
        try {
            const markup = (w) => w.evaluate(() => document.querySelector('.runControls').innerHTML.replace(/\s+/g, ' '));
            assert.equal(await markup(popup), await markup(page), 'the popup run controls differ from the header');

            const s = await popup.evaluate(() => {
                const bar = document.querySelector('.outputTitle').getBoundingClientRect();
                const c = document.querySelector('.runControls').getBoundingClientRect();
                return {
                    labels: document.querySelectorAll('.runControls h4').length,
                    centreOffset: (c.left + c.right) / 2 - (bar.left + bar.right) / 2,
                    inBar: c.top >= bar.top && c.bottom <= bar.bottom,
                    stopOpacity: +getComputedStyle(document.getElementById('stop')).opacity,
                    playColour: getComputedStyle(document.getElementById('runPlay')).color,
                };
            });
            assert.equal(s.labels, 0);
            assert.ok(s.inBar, 'the run controls are not in the popup title bar');
            assert.ok(Math.abs(s.centreOffset) <= 1, `the run controls are off-centre by ${s.centreOffset}px`);
            assert.ok(s.stopOpacity < 0.5, 'stop looks live in the popup while idle');
            assert.equal(s.playColour, await page.evaluate(() =>
                getComputedStyle(document.getElementById('runPlay')).color), 'play is a different colour in the popup');

            // And they drive the shared run: Play in the popup flips BOTH windows to pause.
            await page.evaluate(() => window.editor.setValue('graph.add_node(Node(1))\npause(4000)\n'));
            await popup.click('#run');
            await page.waitForFunction(() => window.PyNodeHost.state() === 'playing');
            for (const w of [page, popup]) {
                assert.equal(await w.evaluate(() => document.getElementById('runPause').style.display), 'inherit');
            }
            await popup.click('#stop');
        } finally {
            await popup.close();
        }
    } finally {
        await context.close();
    }
});
