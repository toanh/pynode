# PyNode: Graph Theory Visualizer
<a href="https://alexsocha.github.io/pynode/"><img src="https://alexsocha.github.io/pynode/images/logo.png" align="left" hspace="10" vspace="6" width="100px" height="100px"></a>
**PyNode** is a Python library for visualizing Graph Theory. It can be used to develop algorithm prototypes, or to demonstrate how algorithms work in a visual, interactive way. It is available in both an online version (current directory) and offline version (<a href="https://github.com/alexsocha/pynode/tree/master/offline_src">/offline_src</a>). The official website can be found <a href="https://alexsocha.github.io/pynode">here</a>.
<br><br>

## How It Works
### Online Version
* The Python code is written in the editor, provided by <a href="https://microsoft.github.io/monaco-editor/">Monaco</a>, the editor component from VS Code.
* When the 'Play' button is pressed, the code runs as real <a href="https://www.python.org/">CPython</a> in a web worker, using <a href="https://pyodide.org/">Pyodide</a> (CPython compiled to WebAssembly). Because it runs off the main thread, the interface stays responsive and a runaway loop can be stopped.
* Each Graph API call emits a command to the main thread, which applies it to the visualization (using a modified version of <a href="https://github.com/maurizzzio/greuler">Greuler</a>, built on <a href="https://github.com/d3/d3">D3</a> and <a href="https://github.com/tgdwyer/WebCola">WebCola</a>).

## Project Structure
### Online Version
* **pynode_graphlib.py\*** - The PyNode Graphlib API, which provides all Graph-related functions. This file maintains the current state of the graph, and informs graph_api.js of all the events that need to be visually displayed.
* **pynode_core.py** - Handles the internal functions of the API, and acts as a bridge between pynode_graphlib.py and graph_api.js, allowing the API to be compatible with both the online and offline versions of PyNode.
* **coi-serviceworker.js** - Supplies the COOP/COEP headers that GitHub Pages cannot send, which are required for `SharedArrayBuffer`. Must stay at the repository root so its service-worker scope covers every page.
* **index.html** - The main page of the online version, which includes the editor, console, and output window. Also provides documentation for all features.
* **pynode_editor.html, pynode_console.html, pynode_output.html** - Detachable editor/console/output windows.
* **pynode_pojects/** - Contains the Python code for the examples provided on the website.
* **/css/\*** - Contains custom fonts and the main style sheet.
* **/images/pynode\*** - Contains all icons used in the interface.
* **/js/\*** - Contains all JavaScript code.
    * **graph_api.js** - Visually updates the graph, in parallel with the calls that were made to the GraphLib API.
    * **pynode_worker.js** - Runs Pyodide and the Python API inside a module worker.
    * **pynode_host.js** - Main-thread owner of the worker. Applies the command stream to the visualization, routes console output, and drives the play/pause/stop/restart controls.
    * **monaco_setup.js, pynode_completions.js** - Editor setup, cross-window sync, and autocompletion for the PyNode API.
    * **d3_controls.js** - Handles interface events such as panning and zooming.
    * **resize.js** - Handles resizing of the window, and includes functions which manage node layout/positioning.
    * **/greuler** - The (modified) <a href="https://github.com/maurizzzio/greuler">Greuler API</a>.
    * **/cola** - The <a href="https://github.com/tgdwyer/WebCola">WebCola API</a>.
    * **/d3** - The <a href="https://github.com/d3/d3">D3 API</a>.
    * **/monaco** - The <a href="https://microsoft.github.io/monaco-editor/">Monaco Editor</a>.
    * **/pyodide** - The <a href="https://pyodide.org/">Pyodide</a> CPython/WebAssembly runtime.
### Offline Version
* **offline_src/** - Contains the source code for the offline version of PyNode. Further details are provided within the directory.
* **offline_downloads/** - Contains packaged downloads for the offline version.
    * **latest_version.zip** - Contains the latest version of the <a href="https://github.com/alexsocha/pynode/tree/master/offline_src/pynode/src">/offline_src/pynode/src</a> folder packaged in a zip file, allowing for automatic updates.
    * **latest_version.txt** - Specifies the current version number.
    * **pynode_win64.zip, pynode_macosx.zip, etc.** - Contains the fully packaged offline versions of PyNode for various operating systems.

_\* These files should be kept in sync between the online and offline versions._

## Contributing
All pull requests should be made to the master branch. Once merged, the changes will be automatically deployed to the gh-pages branch, and can be viewed at <a href="https://alexsocha.github.io/pynode/">alexsocha.github.io/pynode</a>.

### Offline Version
If changes are made to files that are also used in the offline version (indicated by a '\*'), the corresponding files in the <a href="https://github.com/alexsocha/pynode/tree/master/offline_src">/offline_src</a> folder should also be updated, and the procedure for publishing the offline version (specifically the "PyNode Files" section) should be followed.
