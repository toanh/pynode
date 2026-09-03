# PyNode core - online version.
#
# Runs inside a Pyodide (real CPython) module worker. This file is the only portability
# seam: pynode_graphlib.py is written entirely against it, and is byte-identical to the
# offline copy apart from its import line.
#
# Compare offline_src/pynode/src/pynode_core.py, which implements this same seam over a
# stdin/stdout pipe to a CEF process. That version already had the blocking model this
# one now uses; the two have converged rather than drifted further apart.
#
# Execution model: user code runs to completion in the worker, blocking for real on
# pause(). Commands are emitted immediately, so the main thread renders live.
#
# The core stays pure Python - it never imports `js`. Everything platform-specific
# arrives through set_hooks():
#   sink(name, args)      deliver a command to the main thread
#   sleep(ms)             block the worker (Atomics.wait on a SharedArrayBuffer)
#   poll()                read shared control state: stop/pause flags + queued clicks
#   read_position(id)     read the position mirror
#
# The hooks matter because a worker parked in Atomics.wait runs no JavaScript, so
# postMessage cannot reach it. Anything the main thread must tell a *running* worker
# has to travel through shared memory.

import sys
import time
import traceback

SLICE_MS = 16.0        # sleep granularity: also the interrupt/callback servicing rate


class PynodeStop(Exception):
    """Raised inside user code when Stop is pressed."""
    pass


class PynodeCoreGlobals:
    GLOBAL_ID = 0
    GLOBAL_USER_ID = 0
    GLOBAL_DELAY_ID = 0

    do_events = True

    # Platform hooks (see set_hooks). While sink is None commands buffer in event_queue,
    # which keeps the core exercisable headlessly.
    sink = None
    sleep = None
    poll = None
    read_position = None
    event_queue = []

    # Cooperative timer wheel. Pyodide has no working threading.Thread, so delay() and
    # set_interval() cannot use the offline core's threads - nothing fires on its own,
    # service() drives everything.
    timers = {}                    # id -> [due_ms, func, period_ms or None]
    delay_type = {}                # id -> 1 interval / 0 timeout   (read by graphlib)

    click_listener_func = {"f": None}
    pending_clicks = []

    canvas = [500, 400]
    error = ""
    depth = 0                      # callback nesting depth
    stopping = False


import pynode_graphlib


# --- platform hooks --------------------------------------------------------

def set_hooks(sink=None, sleep=None, poll=None, read_position=None):
    PynodeCoreGlobals.sink = sink
    PynodeCoreGlobals.sleep = sleep
    PynodeCoreGlobals.poll = poll
    PynodeCoreGlobals.read_position = read_position


def take_queue():
    q = PynodeCoreGlobals.event_queue
    PynodeCoreGlobals.event_queue = []
    return q


def _send(name, args):
    if PynodeCoreGlobals.sink is not None:
        PynodeCoreGlobals.sink(name, args)
    else:
        PynodeCoreGlobals.event_queue.append([name, args])


def enable_events(enable):
    PynodeCoreGlobals.do_events = enable


# --- ids -------------------------------------------------------------------

def next_global_id():
    v = PynodeCoreGlobals.GLOBAL_ID
    PynodeCoreGlobals.GLOBAL_ID += 1
    return v


def next_user_id():
    v = PynodeCoreGlobals.GLOBAL_USER_ID
    PynodeCoreGlobals.GLOBAL_USER_ID += 1
    return v


def next_delay_id():
    v = PynodeCoreGlobals.GLOBAL_DELAY_ID
    PynodeCoreGlobals.GLOBAL_DELAY_ID += 1
    return v


# --- events ----------------------------------------------------------------

class Event:
    def __init__(self, func, args):
        self.func = func
        self.args = args


class EventPrint(Event):
    pass


class EventPause:
    def __init__(self, time):
        self.time = time


def add_event(event, source=None):
    if not PynodeCoreGlobals.do_events:
        return
    if source is not None:
        if isinstance(source, pynode_graphlib.Node) and not pynode_graphlib.graph.has_node(source): return
        if isinstance(source, pynode_graphlib.Edge) and not pynode_graphlib.graph.has_edge(source): return

    if isinstance(event, EventPause):
        # A real sleep, unlike the old online build where this only queued a marker.
        pump(event.time)
    elif isinstance(event.func, str):
        _send(event.func, list(event.args))
    else:
        # A plain Python callable (only the core itself builds these).
        event.func(*event.args)


def get_data(event, source=None):
    if source is not None:
        if isinstance(source, pynode_graphlib.Node) and not pynode_graphlib.graph.has_node(source): return None
        if isinstance(source, pynode_graphlib.Edge) and not pynode_graphlib.graph.has_edge(source): return None
    if event.func == js_node_get_position:
        w, h = PynodeCoreGlobals.canvas[0], PynodeCoreGlobals.canvas[1]
        if PynodeCoreGlobals.read_position is None:
            return [None, None, w, h]
        # Hook returns [known, x, y, canvas_w, canvas_h].
        r = PynodeCoreGlobals.read_position(event.args[0])
        if r is None or not r[0]:
            return [None, None, int(r[3]) if r else w, int(r[4]) if r else h]
        PynodeCoreGlobals.canvas = [int(r[3]), int(r[4])]
        return [int(r[1]), int(r[2]), int(r[3]), int(r[4])]
    return None


# --- console ---------------------------------------------------------------

def format_string_HTML(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace("\n", "<br>").replace("\"", "&quot;").replace("'", "&apos;")
             .replace(" ", "&nbsp;"))


def do_print(s, color=None):
    style = "display:inline;"
    if color is not None:
        style += "color:" + color + ";"
    _send("print", ["<p style='" + style + "'>" + format_string_HTML(str(s)) + "</p>"])


def do_print_formatted(s):
    _send("print", [s])


class PrintOutput:
    def write(self, data):
        do_print(str(data))
    def flush(self):
        pass


class ErrorOutput:
    def write(self, data):
        PynodeCoreGlobals.error += ("<p style='display:inline;color:red;'>"
                                    + format_string_HTML(str(data)) + "</p>")
    def flush(self):
        pass


sys.stdout = PrintOutput()
sys.stderr = ErrorOutput()


def handle_exception():
    try:
        if PynodeCoreGlobals.error:
            do_print_formatted(PynodeCoreGlobals.error)
            PynodeCoreGlobals.error = ""
    except Exception:
        pass


# --- cooperative scheduling ------------------------------------------------

def _now():
    return time.monotonic() * 1000.0


class Timer:
    """Same four-method surface pynode_graphlib.py expects from browser.timer,
    backed by a due-time table instead of real timers."""

    def set_timeout(self, func, time):
        i = next_delay_id()
        PynodeCoreGlobals.timers[i] = [_now() + time, func, None]
        return i

    def set_interval(self, func, time):
        i = next_delay_id()
        PynodeCoreGlobals.timers[i] = [_now() + time, func, time]
        return i

    def clear_timeout(self, i):
        PynodeCoreGlobals.timers.pop(i, None)

    def clear_interval(self, i):
        PynodeCoreGlobals.timers.pop(i, None)


timer = Timer()


def execute_function(func, args):
    PynodeCoreGlobals.depth += 1
    try:
        func(*args)
    except PynodeStop:
        raise
    except Exception:
        traceback.print_exc(file=sys.stderr)
        handle_exception()
    finally:
        PynodeCoreGlobals.depth -= 1


def node_click(node_id):
    listener = PynodeCoreGlobals.click_listener_func["f"]
    if pynode_graphlib.graph is None or listener is None:
        return
    for n in pynode_graphlib.graph.nodes():
        if n._internal_id == node_id:
            execute_function(listener, [n])
            return


def _control():
    """Read shared control state. Returns (stop, pause)."""
    if PynodeCoreGlobals.poll is None:
        return (False, False)
    r = PynodeCoreGlobals.poll()
    # Hook returns [stop, pause, click_id, click_id, ...].
    if r is None:
        return (False, False)
    for i in range(2, len(r)):
        PynodeCoreGlobals.pending_clicks.append(int(r[i]))
    return (bool(r[0]), bool(r[1]))


def _sleep(ms):
    if PynodeCoreGlobals.sleep is not None and ms > 0:
        PynodeCoreGlobals.sleep(ms)


def service():
    """Dispatch due timers and queued clicks.

    Only at depth 0, so a pause() inside a callback flushes renders and sleeps but does
    not recursively dispatch further callbacks - without this, nested dispatch recurses
    without bound. Clicks arriving during a callback stay queued until it returns.
    """
    if PynodeCoreGlobals.depth != 0:
        return

    while PynodeCoreGlobals.pending_clicks:
        node_click(PynodeCoreGlobals.pending_clicks.pop(0))

    now = _now()
    for i in sorted(PynodeCoreGlobals.timers.keys()):
        entry = PynodeCoreGlobals.timers.get(i)
        if entry is None or entry[0] > now:
            continue
        func, period = entry[1], entry[2]
        if period is None:
            PynodeCoreGlobals.timers.pop(i, None)
            PynodeCoreGlobals.delay_type.pop(i, None)
        else:
            entry[0] = now + period
        execute_function(func, [])


def pump(total_ms):
    """Sleep for total_ms, in slices, servicing timers and clicks in between.

    Slicing is what gives Pyodide bytecode boundaries at which the interrupt buffer is
    honoured, and what lets delay() callbacks and clicks run while user code sits inside
    a pause(). Paused time does not count against the deadline.
    """
    deadline = _now() + total_ms
    while True:
        stop, paused = _control()
        if stop:
            raise PynodeStop()

        if paused:
            # Hold without consuming the pause budget.
            before = _now()
            _sleep(SLICE_MS)
            deadline += _now() - before
            continue

        service()

        remaining = deadline - _now()
        if remaining <= 0:
            return
        _sleep(min(remaining, SLICE_MS))


def service_idle():
    """Called from the worker's JS idle tick once a run has finished.

    Deliberately not a Python loop: the worker must return to its own event loop between
    ticks or postMessage can never be delivered to it.
    """
    stop, paused = _control()
    if stop or paused:
        return
    service()


# --- run control -----------------------------------------------------------

def reset():
    PynodeCoreGlobals.GLOBAL_USER_ID = 0
    pynode_graphlib.graph._reset()
    pynode_graphlib.clear_delays()
    PynodeCoreGlobals.timers = {}
    PynodeCoreGlobals.delay_type = {}
    PynodeCoreGlobals.pending_clicks = []
    PynodeCoreGlobals.click_listener_func = {"f": None}
    PynodeCoreGlobals.error = ""
    PynodeCoreGlobals.depth = 0
    PynodeCoreGlobals.do_events = True
    PynodeCoreGlobals.event_queue = []
    PynodeCoreGlobals.stopping = False
    _send("js_clear", [])


def run_code(src):
    """Execute a user script.

    Deliberately NOT pynode_graphlib._exec_code(): that does `namespace = locals()`
    inside a function, which under CPython is just {'src': ...}, so user code cannot
    see graph/Node/Edge/Color/pause. Brython chains function-scope locals() to module
    globals, which is why it works there. graphlib is frozen, so we build the namespace
    from a copy of its own module dict instead - which is what the docs promise users.

    Returns "ok", "stopped" or "error".
    """
    ns = dict(pynode_graphlib.__dict__)
    ns["__name__"] = "__main__"
    try:
        exec(src, ns, ns)
        return "ok"
    except PynodeStop:
        return "stopped"
    except KeyboardInterrupt:
        # Pyodide's interrupt buffer raises this for a loop that never reaches pump().
        return "stopped"
    except Exception:
        traceback.print_exc(file=sys.stderr)
        handle_exception()
        return "error"


# --- the js_* protocol -----------------------------------------------------
# These names must match the function names in js/graph_api.js exactly.

js_add_node = "js_add_node"
js_remove_node = "js_remove_node"
js_add_edge = "js_add_edge"
js_remove_edge = "js_remove_edge"
js_add_all = "js_add_all"
js_remove_all = "js_remove_all"
js_set_spread = "js_set_spread"
js_clear = "js_clear"
js_update = "js_update"
js_node_set_value = "js_node_set_value"
js_node_set_position = "js_node_set_position"
js_node_get_position = "js_node_get_position"
js_node_set_label = "js_node_set_label"
js_node_set_size = "js_node_set_size"
js_node_set_color = "js_node_set_color"
js_node_set_value_style = "js_node_set_value_style"
js_node_set_label_style = "js_node_set_label_style"
js_node_highlight = "js_node_highlight"
js_edge_set_weight = "js_edge_set_weight"
js_edge_set_directed = "js_edge_set_directed"
js_edge_set_width = "js_edge_set_width"
js_edge_set_color = "js_edge_set_color"
js_edge_set_weight_style = "js_edge_set_weight_style"
js_edge_highlight = "js_edge_highlight"
js_edge_traverse = "js_edge_traverse"
