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

const VERSION = '0.9.10';
const here = (p) => new URL(p, location.href).href;

// --- SAB layout. Must match js/pynode_host.js exactly. ---
const CTRL_NOTIFY = 0;   // wait word; host increments + notifies to wake us
const CTRL_STOP = 1;
const CTRL_PAUSE = 2;
const CTRL_CLICK_W = 3;
const CTRL_CLICK_R = 4;
const CTRL_IO_STATE = 5;   // 0 idle | 1 pending | 2 ready | 3 cancelled
const CTRL_IO_LEN = 6;     // byte length of the answer in the io buffer
const CTRL_IO_SEQ = 7;     // request id, so a stale answer cannot be consumed by a later run
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
let io = null;           // Uint8Array on shared memory - UTF-8 answer from input()
let shared = true;       // false when the page is not cross-origin isolated
let idleTimer = null;

const post = (msg) => self.postMessage(msg);

// Commands accumulate here and are flushed as one batch whenever the worker is about to
// sleep, so everything between two pause() calls reaches the renderer together.
let outbox = [];
let lastFlush = 0;

function flush() {
    if (outbox.length) {
        post({ t: 'events', events: outbox });
        outbox = [];
    }
    lastFlush = performance.now();
}

// --- hooks handed to pynode_core.set_hooks() ---

function sink(name, args) {
    // args arrives as a PyProxy list; toJs gives plain JS values.
    let a;
    try { a = args.toJs ? args.toJs({ dict_converter: Object.fromEntries }) : args; }
    catch (e) { a = []; }
    outbox.push([name, a]);
    // Flush on a time budget as well as a size cap, so output streams during a CPU-bound
    // loop that never sleeps. postMessage from a running (not blocked) worker is safe -
    // the main thread's event loop is free to receive it.
    if (outbox.length >= 512 || (performance.now() - lastFlush) > 50) flush();
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

// Blocking stdin, so input() works.
//
// Pyodide's default stdin handler calls window.prompt, which does not exist in a worker,
// so Pyodide installs an erroring handler instead - that is the OSError: [Errno 29] users
// were hitting. Because the worker already blocks on Atomics.wait, a genuinely blocking
// input() drops straight into the existing design.
//
// autoEOF defaults to true when `stdin` is supplied, so Pyodide terminates each returned
// string as one line itself: return the raw answer, never append "\n".
function stdin() {
    // Without real shared memory the host's answer can never reach us (postMessage COPIES
    // a plain ArrayBuffer), so fail fast as EOF instead of spinning a core forever.
    if (!shared) return null;

    const seq = (Atomics.load(ctrl, CTRL_IO_SEQ) + 1) | 0;
    Atomics.store(ctrl, CTRL_IO_SEQ, seq);
    Atomics.store(ctrl, CTRL_IO_STATE, 1);

    // Ordered with the output stream rather than raced against it: the prompt was just
    // written by Python, and this rides the same outbox, so the host appends the field
    // in the very same pass that renders the prompt.
    outbox.push(['__input', [seq]]);
    flush();

    for (;;) {
        if (Atomics.load(ctrl, CTRL_STOP)) {
            Atomics.store(ctrl, CTRL_IO_STATE, 0);
            return null;           // pynode_core._pynode_input turns this into PynodeStop
        }
        const state = Atomics.load(ctrl, CTRL_IO_STATE);
        if (state === 2) {
            const len = Atomics.load(ctrl, CTRL_IO_LEN);
            // TextDecoder refuses a view backed by a SharedArrayBuffer, so copy out first.
            const bytes = new Uint8Array(len);
            bytes.set(io.subarray(0, len));
            Atomics.store(ctrl, CTRL_IO_STATE, 0);
            return new TextDecoder().decode(bytes);
        }
        if (state === 3) {
            Atomics.store(ctrl, CTRL_IO_STATE, 0);
            return null;           // EOF
        }
        const v = Atomics.load(ctrl, CTRL_NOTIFY);
        Atomics.wait(ctrl, CTRL_NOTIFY, v, 50);
    }
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
    io = new Uint8Array(buffers.io);
    shared = (typeof SharedArrayBuffer !== 'undefined') && (buffers.ctrl instanceof SharedArrayBuffer);

    post({ t: 'progress', step: 'loading python' });
    pyodide = await loadPyodide({ indexURL: here('pyodide/') });

    // Lets the main thread break a tight loop that never reaches pump(): Pyodide checks
    // this buffer at bytecode boundaries and raises KeyboardInterrupt.
    pyodide.setInterruptBuffer(interrupt);
    pyodide.setStdin({ stdin: stdin, isatty: false });

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
    Atomics.store(ctrl, CTRL_IO_STATE, 0);
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
