// PyNode worker - owns the Pyodide (CPython) runtime and blocks for real on pause().
//
// MUST be started as a module worker: new Worker(url, { type: "module" }).
// Pyodide 0.28+ refuses to run in a classic worker ("Classic web workers are not supported").
//
// While user code is running the worker spends most of its time parked in Atomics.wait,
// which means it runs no JavaScript and postMessage CANNOT reach it. Everything the main
// thread needs to tell a running worker therefore travels through the SharedArrayBuffer
// control block; postMessage is only used for the reverse direction and for setup.

import { loadPyodide } from './pyodide/pyodide.mjs';

const VERSION = '0.9.9';
const here = (p) => new URL(p, location.href).href;

// --- SAB layout. Must match js/pynode_host.js exactly. ---
const CTRL_NOTIFY = 0;   // wait word; host increments + notifies to wake us
const CTRL_STOP = 1;
const CTRL_PAUSE = 2;
const CTRL_CLICK_W = 3;
const CTRL_CLICK_R = 4;
const CLICK_BASE = 8;
const CLICK_CAP = 64;

const POS_W = 0;         // Float64Array: canvas width / height, then [known,x,y] per node id
const POS_H = 1;
const POS_BASE = 4;
const POS_MAX = 1024;

let pyodide = null;
let core = null;
let ctrl = null;         // Int32Array on shared memory
let pos = null;          // Float64Array on shared memory
let interrupt = null;    // Uint8Array on shared memory
let idleTimer = null;

const post = (msg) => self.postMessage(msg);

// Commands accumulate here and are flushed as one batch whenever the worker is about to
// sleep, so everything between two pause() calls reaches the renderer together.
let outbox = [];

function flush() {
    if (outbox.length) {
        post({ t: 'events', events: outbox });
        outbox = [];
    }
}

// --- hooks handed to pynode_core.set_hooks() ---

function sink(name, args) {
    // args arrives as a PyProxy list; toJs gives plain JS values.
    let a;
    try { a = args.toJs ? args.toJs({ dict_converter: Object.fromEntries }) : args; }
    catch (e) { a = []; }
    outbox.push([name, a]);
    if (outbox.length >= 512) flush();   // guard against unbounded growth
}

let canWait = true;

function sleep(ms) {
    flush();
    if (canWait) {
        try {
            const v = Atomics.load(ctrl, CTRL_NOTIFY);
            Atomics.wait(ctrl, CTRL_NOTIFY, v, ms);
            return;
        } catch (e) {
            // Atomics.wait throws on a non-shared buffer, i.e. when the page is not
            // cross-origin isolated. Fall back to a spin for the rest of the session.
            canWait = false;
        }
    }
    const until = performance.now() + ms;
    while (performance.now() < until) { /* burn */ }
}

function poll() {
    const out = [Atomics.load(ctrl, CTRL_STOP), Atomics.load(ctrl, CTRL_PAUSE)];
    let r = Atomics.load(ctrl, CTRL_CLICK_R);
    const w = Atomics.load(ctrl, CTRL_CLICK_W);
    while (r !== w) {
        out.push(Atomics.load(ctrl, CLICK_BASE + (r % CLICK_CAP)));
        r = (r + 1) | 0;
    }
    Atomics.store(ctrl, CTRL_CLICK_R, r);
    return out;
}

function readPosition(id) {
    const w = pos[POS_W] || 500, h = pos[POS_H] || 400;
    if (id < 0 || id >= POS_MAX) return [0, 0, 0, w, h];
    const b = POS_BASE + id * 3;
    return [pos[b], pos[b + 1], pos[b + 2], w, h];
}

async function boot(buffers) {
    ctrl = new Int32Array(buffers.ctrl);
    pos = new Float64Array(buffers.pos);
    interrupt = new Uint8Array(buffers.interrupt);

    post({ t: 'progress', step: 'loading python' });
    pyodide = await loadPyodide({ indexURL: here('pyodide/') });

    // Lets the main thread break a tight loop that never reaches pump(): Pyodide checks
    // this buffer at bytecode boundaries and raises KeyboardInterrupt.
    pyodide.setInterruptBuffer(interrupt);

    // Fetch the two .py files rather than bundling them: they stay on disk at the repo
    // root, where the crawler anchors at the end of index.html still point, and they stay
    // byte-diffable against offline_src/pynode/src/.
    const [coreSrc, libSrc] = await Promise.all([
        fetch(here('../pynode_core.py?version=' + VERSION)).then(r => r.text()),
        fetch(here('../pynode_graphlib.py?version=' + VERSION)).then(r => r.text()),
    ]);
    pyodide.FS.writeFile('/home/pyodide/pynode_core.py', coreSrc);
    pyodide.FS.writeFile('/home/pyodide/pynode_graphlib.py', libSrc);

    pyodide.runPython('import pynode_core');
    core = pyodide.pyimport('pynode_core');
    core.set_hooks(sink, sleep, poll, readPosition);

    startIdle();
    post({ t: 'ready', python: pyodide.runPython('import sys; sys.version').split(' ')[0] });
}

// Timers and click callbacks keep firing after a run returns - tictactoe registers a
// click listener and then ends, and its whole game is delay() chains from callbacks.
// This is a JS tick, never a Python loop: the worker has to return to its own event loop
// between ticks or postMessage could never be delivered.
function startIdle() {
    if (idleTimer !== null) return;
    idleTimer = setInterval(() => {
        if (!core) return;
        try {
            core.service_idle();
            flush();
        } catch (e) {
            post({ t: 'error', message: String(e) });
        }
    }, 16);
}

function clearStop() {
    Atomics.store(ctrl, CTRL_STOP, 0);
    Atomics.store(ctrl, CTRL_PAUSE, 0);
    interrupt[0] = 0;
}

self.onmessage = async (ev) => {
    const msg = ev.data || {};
    try {
        switch (msg.t) {
            case 'boot':
                await boot(msg.buffers);
                break;

            case 'run': {
                clearStop();
                core.reset();
                pyodide.globals.set('__pynode_src', msg.src);
                let result = 'error';
                try {
                    result = pyodide.runPython('pynode_core.run_code(__pynode_src)');
                } catch (e) {
                    // A KeyboardInterrupt from the interrupt buffer can surface here.
                    result = /KeyboardInterrupt/.test(String(e)) ? 'stopped' : 'error';
                    if (result === 'error') post({ t: 'error', message: String(e).slice(0, 400) });
                }
                clearStop();
                flush();
                post({ t: 'done', result: result });
                break;
            }

            case 'reset':
                clearStop();
                if (core) { core.reset(); flush(); }
                post({ t: 'stopped' });
                break;
        }
    } catch (e) {
        post({ t: 'error', message: String((e && e.message) || e) });
    }
};

post({ t: 'boot-needed' });
