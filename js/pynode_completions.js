// Monaco completion provider for the PyNode Graphlib API.
// Signatures mirror pynode_graphlib.py; descriptions mirror the documentation in index.html.
// Loaded by monaco_setup.js, which calls registerPynodeCompletions(monaco) once Monaco is ready.

function registerPynodeCompletions(monaco) {
    "use strict";

    // [label, insertText (snippet), detail, documentation]
    var API = [
        // --- top level ---
        ["pause", "pause(${1:time})", "pause(time)",
            "Pauses execution for the given number of milliseconds while the graph keeps rendering."],
        ["delay", "delay(${1:func}, ${2:time})", "delay(func, time, args=[], repeat=False)",
            "Executes a function after the given number of milliseconds. Set repeat=True to run it on an interval."],
        ["cancel_delay", "cancel_delay(${1:delay_id})", "cancel_delay(delay_id)",
            "Cancels a delay previously scheduled with delay()."],
        ["clear_delays", "clear_delays()", "clear_delays()", "Cancels every scheduled delay."],
        ["register_click_listener", "register_click_listener(${1:func})", "register_click_listener(func)",
            "Registers a function called with the clicked Node whenever the user clicks a node."],
        ["print_debug", "print_debug(${1:value})", "print_debug(value)", "Prints a value to the PyNode console."],

        // --- graph ---
        ["graph", "graph", "graph: Graph", "The global graph instance."],
        ["graph.add_node", "graph.add_node(${1:node})", "graph.add_node(node)", "Adds a node to the graph."],
        ["graph.remove_node", "graph.remove_node(${1:node})", "graph.remove_node(node)",
            "Removes a node and all of its edges."],
        ["graph.add_edge", "graph.add_edge(${1:edge})", "graph.add_edge(edge)", "Adds an edge to the graph."],
        ["graph.remove_edge", "graph.remove_edge(${1:edge})", "graph.remove_edge(edge)", "Removes an edge."],
        ["graph.add_all", "graph.add_all(${1:elements})", "graph.add_all(elements)",
            "Adds a list of nodes and/or edges in one animation step."],
        ["graph.remove_all", "graph.remove_all(${1:elements})", "graph.remove_all(elements)",
            "Removes a list of nodes and/or edges in one animation step."],
        ["graph.node", "graph.node(${1:id})", "graph.node(id)", "Returns the node with the given id."],
        ["graph.nodes", "graph.nodes()", "graph.nodes()", "Returns a list of all nodes."],
        ["graph.edges", "graph.edges()", "graph.edges()", "Returns a list of all edges."],
        ["graph.has_node", "graph.has_node(${1:node})", "graph.has_node(node)", "Whether the node is in the graph."],
        ["graph.has_edge", "graph.has_edge(${1:edge})", "graph.has_edge(edge)", "Whether the edge is in the graph."],
        ["graph.set_spread", "graph.set_spread(${1:spread})", "graph.set_spread(spread)",
            "Sets how far apart nodes are laid out."],
        ["graph.clear", "graph.clear()", "graph.clear()", "Removes everything from the graph."],

        // --- node ---
        ["Node", "Node(${1:id})", "Node(id, value=None, ...)", "Creates a node."],
        ["node.set_value", "set_value(${1:value})", "node.set_value(value)", "Sets the value shown inside the node."],
        ["node.value", "value()", "node.value()", "Returns the node's value."],
        ["node.set_color", "set_color(${1:color})", "node.set_color(color)", "Sets the node's fill colour."],
        ["node.set_size", "set_size(${1:size})", "node.set_size(size)", "Sets the node's radius."],
        ["node.set_position", "set_position(${1:x}, ${2:y})", "node.set_position(x, y, relative=False)",
            "Moves the node. With relative=True, x and y are fractions (0.0-1.0) of the window."],
        ["node.position", "position()", "node.position()",
            "Returns the node's (x, y) coordinates. Should be used in asynchronous calls."],
        ["node.set_label", "set_label(${1:value})", "node.set_label(value, label_id=0)",
            "Sets an extra label. label_id=0 is top-right, label_id=1 is top-left."],
        ["node.highlight", "highlight()", "node.highlight(size=None, color=None)",
            "Briefly animates the node to draw attention to it."],
        ["node.set_attribute", "set_attribute(${1:key}, ${2:value})", "node.set_attribute(key, value)",
            "Stores arbitrary user data on the node."],
        ["node.attribute", "attribute(${1:key})", "node.attribute(key)", "Reads user data from the node."],

        // --- edge ---
        ["Edge", "Edge(${1:node_a}, ${2:node_b})", "Edge(node_a, node_b, weight=None, directed=False)",
            "Creates an edge between two nodes."],
        ["edge.set_weight", "set_weight(${1:weight})", "edge.set_weight(weight)", "Sets the edge's weight label."],
        ["edge.weight", "weight()", "edge.weight()", "Returns the edge's weight."],
        ["edge.set_color", "set_color(${1:color})", "edge.set_color(color)", "Sets the edge's colour."],
        ["edge.set_width", "set_width(${1:width})", "edge.set_width(width)", "Sets the edge's thickness."],
        ["edge.set_directed", "set_directed(${1:True})", "edge.set_directed(directed)",
            "Shows or hides the direction arrow."],
        ["edge.highlight", "highlight()", "edge.highlight(width=None, color=None)", "Briefly animates the edge."],
        ["edge.traverse", "traverse(${1:start})", "edge.traverse(start, color=None, keep_path=False)",
            "Animates a pulse travelling along the edge from the given node."],

        // --- colour ---
        ["Color.rgb", "Color.rgb(${1:r}, ${2:g}, ${3:b})", "Color.rgb(red, green, blue)", "Creates a colour."],
        ["Color.hex", "Color.hex(${1:'#ff0000'})", "Color.hex(string)", "Creates a colour from a hex string."]
    ];

    ["RED", "GREEN", "BLUE", "YELLOW", "WHITE", "LIGHT_GREY", "GREY", "DARK_GREY", "BLACK", "TRANSPARENT"]
        .forEach(function (name) {
            API.push(["Color." + name, "Color." + name, "Color." + name, "Predefined colour."]);
        });

    monaco.languages.registerCompletionItemProvider("python", {
        provideCompletionItems: function (model, position) {
            var word = model.getWordUntilPosition(position);
            var range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn
            };
            return {
                suggestions: API.map(function (a) {
                    return {
                        label: a[0],
                        kind: a[0].indexOf("Color.") === 0
                            ? monaco.languages.CompletionItemKind.Constant
                            : monaco.languages.CompletionItemKind.Function,
                        insertText: a[1],
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        detail: a[2],
                        documentation: a[3],
                        range: range
                    };
                })
            };
        }
    });
}
