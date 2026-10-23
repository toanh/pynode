"""PyNode debugger: breakpoints, stepping, variables, watches and an execution trace.

Pure Python, like pynode_core: it never imports `js`. The browser reaches it only
through hooks passed to install(), so it can be exercised headlessly.

Engine: sys.monitoring (PEP 669), not sys.settrace. A LINE callback that returns DISABLE
silences that code location until restart_events(), so lines without a breakpoint cost
essentially nothing and animation timing is unaffected. Stepping, a break request and
Record mode call restart_events() so every user line reports again.

User code is compiled under the filename USER_FILE (see pynode_core.run_code); that is
how its frames are told apart from the library's, and why line numbers map one-to-one
onto the editor.

A pause is the debugger blocking inside the callback: it flushes, reports a snapshot
in-band as a synthetic "__debug" command, then waits on the shared control block for a
step/continue command. It deliberately never calls pynode_core.service(), so delay()
callbacks and node clicks stay queued: the program is frozen while you look at it.

Pause during a run and breakpoints changed mid-run reach code that is not reporting
lines - a tight loop, or a pause() - through SIGUSR1 written into Pyodide's interrupt
buffer: the handler below runs at the next bytecode boundary with the running frame.
"""

import json
import reprlib
import signal
import sys

import pynode_core

USER_FILE = "<pynode>"
WATCH_FILE = "<watch>"

mon = sys.monitoring
TOOL = mon.DEBUGGER_ID

# Debug command words (CTRL_DBG_CMD); must match js/pynode_host.js.
CMD_NONE, CMD_CONTINUE, CMD_INTO, CMD_OVER, CMD_OUT, CMD_INSPECT = 0, 1, 2, 3, 4, 5

RUN, INTO, OVER, OUT = "run", "into", "over", "out"

MAX_ITEMS = 50          # children shown per container
MAX_DEPTH = 2           # container nesting expanded in the variables view
SLICE_MS = 16


class _S:
    installed = False
    poll = None            # () -> [cmd, arg, ver, break_requested]; clears cmd and break
    read = None            # () -> JSON string of {breakpoints, watches, record}
    ver = -1
    breakpoints = set()
    watches = []
    record = False
    mode = RUN
    step_depth = 0
    break_requested = False
    paused = False
    hidden = set()         # names of the initial namespace: not the user's variables
    last_locals = {}       # id(frame) -> {name: repr}, for the trace log's "changed"


_repr = reprlib.Repr()
_repr.maxstring = 120
_repr.maxother = 120
_repr.maxlist = _repr.maxtuple = _repr.maxset = _repr.maxdict = 8
_repr.maxlevel = 2


# --- setup -----------------------------------------------------------------

def install(poll, read):
    """Called once by the worker at boot."""
    _S.poll = poll
    _S.read = read
    if _S.installed:
        return
    mon.use_tool_id(TOOL, "pynode")
    mon.register_callback(TOOL, mon.events.LINE, _on_line)
    mon.set_events(TOOL, mon.events.LINE)
    try:
        signal.signal(signal.SIGUSR1, _on_signal)
    except Exception:
        pass   # no wake-up for tight loops; breakpoints still apply at the next pause()
    _S.installed = True


def begin_run(namespace, step_into=False):
    """Called by pynode_core.run_code before exec."""
    # The library's names are not the user's variables - except `graph`, which is.
    _S.hidden = set(namespace.keys()) - {"graph"}
    _S.mode = INTO if step_into else RUN
    _S.step_depth = 0
    _S.break_requested = False
    _S.paused = False
    _S.last_locals = {}
    _sync(force=True)
    mon.restart_events()


# --- shared state ------------------------------------------------------------

def _poll():
    if _S.poll is None:
        return [CMD_NONE, 0, _S.ver, 0]
    r = _S.poll()
    return [int(r[0]), int(r[1]), int(r[2]), int(r[3])]


def _sync(force=False):
    """Pick up breakpoint / watch / record changes and break requests.

    Returns True when breakpoints, watches or record changed.
    """
    cmd, arg, ver, brk = _poll()
    if brk:
        _S.break_requested = True
        mon.restart_events()
    if not force and ver == _S.ver:
        return False
    _S.ver = ver
    try:
        data = json.loads(_S.read() or "{}") if _S.read is not None else {}
    except Exception:
        data = {}
    _S.breakpoints = set(int(n) for n in data.get("breakpoints", []))
    _S.watches = [str(w) for w in data.get("watches", [])]
    record = bool(data.get("record", False))
    if record and not _S.record:
        _S.last_locals = {}
    _S.record = record
    mon.restart_events()     # lines disabled earlier may now have a breakpoint
    return True


# --- stopping logic ------------------------------------------------------------

def _user_frames(frame):
    """User frames, innermost first."""
    out = []
    f = frame
    while f is not None:
        if f.f_code.co_filename == USER_FILE:
            out.append(f)
        f = f.f_back
    return out


def _depth(frame):
    return len(_user_frames(frame))


def _should_stop(frame, line):
    if _S.break_requested or line in _S.breakpoints:
        return True
    if _S.mode == INTO:
        return True
    if _S.mode == OVER:
        return _depth(frame) <= _S.step_depth
    if _S.mode == OUT:
        return _depth(frame) < _S.step_depth
    return False


def _on_line(code, line):
    if code.co_filename != USER_FILE:
        return mon.DISABLE
    if _S.paused:
        return None          # a watch calling a user function while we are stopped
    _sync()
    frame = sys._getframe(1)
    if _should_stop(frame, line):
        _break_here(frame, line)
        return None
    if _S.record or _S.mode != RUN:
        _trace(frame, line)
        return None
    if line in _S.breakpoints:
        return None
    return mon.DISABLE


def _on_signal(signum, frame):
    """SIGUSR1 from the host: settings changed, or Pause was pressed mid-run."""
    if _S.paused:
        return
    _sync()
    if not _S.break_requested:
        return
    users = _user_frames(frame)
    if users:
        _break_here(users[0], users[0].f_lineno)
    # Not in user code (e.g. the idle tick between callbacks): the request stays set and
    # the next user line breaks, since _sync() re-enabled line events.


# --- pausing -----------------------------------------------------------------

def _break_here(frame, line):
    _S.paused = True
    _S.break_requested = False
    frames = _user_frames(frame)
    selected = 0
    try:
        _trace(frame, line)
        _send_snapshot(frames, selected, line)
        while True:
            stop, _ = pynode_core._control()
            if stop:
                raise pynode_core.PynodeStop()
            cmd, arg, ver, brk = _poll()
            if ver != _S.ver:
                _sync()
                _send_snapshot(frames, selected, line)
            if cmd == CMD_CONTINUE:
                _S.mode = RUN
                break
            if cmd in (CMD_INTO, CMD_OVER, CMD_OUT):
                _S.mode = {CMD_INTO: INTO, CMD_OVER: OVER, CMD_OUT: OUT}[cmd]
                _S.step_depth = len(frames)
                mon.restart_events()
                break
            if cmd == CMD_INSPECT:
                selected = max(0, min(arg, len(frames) - 1))
                _send_snapshot(frames, selected, line)
            # Sleeping through the hook flushes and blocks on the control block. Never
            # service(): delay() callbacks and clicks must wait until we resume.
            pynode_core._sleep(SLICE_MS)
    finally:
        _S.paused = False
    pynode_core._send("__debug", [{"state": "running"}])


def _send_snapshot(frames, selected, line):
    snap = {
        "state": "paused",
        "line": line,
        "selected": selected,
        "frames": [{"name": _frame_name(f), "line": f.f_lineno if i else line}
                   for i, f in enumerate(frames)],
        "locals": [],
        "globals": [],
        "watches": [],
    }
    if frames:
        f = frames[selected]
        if f.f_code.co_name != "<module>":
            snap["locals"] = _vars(f.f_locals)
        snap["globals"] = _vars(f.f_globals, user_only=True)
        snap["watches"] = [_watch(expr, f) for expr in _S.watches]
    pynode_core._send("__debug", [snap])


def _frame_name(f):
    return "<main>" if f.f_code.co_name == "<module>" else f.f_code.co_name


# --- values ------------------------------------------------------------------

def _hidden_value(v):
    t = type(v)
    return t.__name__ in ("module", "function", "builtin_function_or_method", "type") \
        or isinstance(v, type)


def _vars(mapping, user_only=False):
    out = []
    for name in sorted(mapping.keys()):
        if name.startswith("__"):
            continue
        if user_only and name in _S.hidden:
            continue
        v = mapping[name]
        if _hidden_value(v):
            continue
        out.append(summarise(name, v))
    return out


def _short(v):
    """One-line summary. Node/Edge/graph get domain-aware text."""
    try:
        import pynode_graphlib as g
        if isinstance(v, g.Node):
            return "Node(%s, value=%s)" % (_repr.repr(v.id()), _repr.repr(v.value()))
        if isinstance(v, g.Edge):
            return "Edge(%s → %s, weight=%s)" % (
                _repr.repr(v.source().id()), _repr.repr(v.target().id()), _repr.repr(v.weight()))
        if isinstance(v, g.Graph):
            return "Graph(%d nodes, %d edges)" % (v.order(), v.size())
    except Exception:
        pass
    try:
        return _repr.repr(v)
    except Exception as e:
        return "<unrepresentable: %s>" % type(e).__name__


def summarise(name, v, depth=0):
    item = {"n": str(name), "t": type(v).__name__, "r": _short(v)}
    if depth >= MAX_DEPTH:
        return item
    children = None
    try:
        if isinstance(v, dict):
            children = [summarise(_repr.repr(k), v[k], depth + 1) for k in list(v.keys())[:MAX_ITEMS]]
        elif isinstance(v, (list, tuple)):
            children = [summarise("[%d]" % i, x, depth + 1) for i, x in enumerate(v[:MAX_ITEMS])]
        elif isinstance(v, (set, frozenset)):
            children = [summarise("•", x, depth + 1) for x in list(v)[:MAX_ITEMS]]
    except Exception:
        children = None
    if children:
        item["c"] = children
        try:
            if len(v) > MAX_ITEMS:
                item["more"] = len(v) - MAX_ITEMS
        except Exception:
            pass
    return item


def _watch(expr, frame):
    try:
        v = eval(compile(expr, WATCH_FILE, "eval"), frame.f_globals, frame.f_locals)
        return dict(summarise(expr, v), ok=True)
    except Exception as e:
        return {"n": expr, "ok": False, "r": "%s: %s" % (type(e).__name__, e)}


# --- execution trace -----------------------------------------------------------

def _trace(frame, line):
    """One trace-log entry: the line about to run, and which locals changed since this
    frame's previous line. Sent through the ordinary command stream, so it stays in
    order with prints and graph changes."""
    if not (_S.record or _S.mode != RUN or _S.paused):
        return
    try:
        scope = frame.f_locals if frame.f_code.co_name != "<module>" else {
            k: v for k, v in frame.f_globals.items() if k not in _S.hidden}
        now = {}
        for k, v in scope.items():
            if k.startswith("__") or _hidden_value(v):
                continue
            now[k] = _short(v)
        before = _S.last_locals.get(id(frame), {})
        changed = {k: r for k, r in now.items() if before.get(k) != r}
        _S.last_locals[id(frame)] = now
        pynode_core._send("__trace", [{"line": line, "func": _frame_name(frame), "changed": changed}])
    except Exception:
        pass
