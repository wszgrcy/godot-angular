// Godot-side entry. Hand-written CommonJS.
// Two hard GodotJS constraints (both measured):
//   1. .js files are executed as CommonJS; the script class must be on exports.default
//   2. require("./x") is broken (joins to "res:/x"); use the res:// absolute form
// Keep this file ASCII-only: GodotJS reads it byte-wise and the engine log truncates
// multi-byte characters.
const godot = require("godot");
const { Node, Control, Vector2, OS } = godot;
const bundle = require("res://dist/app.bundle.js");

/** Angular error details usually live on ngErrorMessage / ngTokenPath,
 *  while the bare message is just "NG0201". */
function describeError(err) {
    if (!err) return String(err);
    const parts = [err.stack || err.toString()];
    if (err.ngErrorMessage) parts.push("ngErrorMessage: " + err.ngErrorMessage);
    if (err.ngTokenPath) parts.push("ngTokenPath: " + String(err.ngTokenPath));
    return parts.join("\n  ");
}

/** Recursively dump the node tree: this is the "visible result" in headless mode. */
function printTree(node, depth) {
    const pad = "  ".repeat(depth);
    const size = node.size ? Math.round(node.size.x) + "x" + Math.round(node.size.y) : "-";
    const pos = node.position ? "@" + Math.round(node.position.x) + "," + Math.round(node.position.y) : "";
    const text = node.text ? ' text="' + node.text + '"' : "";
    console.log(pad + node.get_class() + " " + node.name + " " + size + " " + pos + text);
    for (let i = 0; i < node.get_child_count(); i++) {
        printTree(node.get_child(i), depth + 1);
    }
}

// Frames to wait before snapshotting, so layout + change detection settle.
const SNAPSHOT_AFTER_FRAMES = 5;

class Main extends Node {
    _ready() {
        this.snapshot = OS.get_environment("CUJ_MODE") === "snapshot";
        this.frames = 0;
        this.app = null;

        // Angular's mount point. A real project would do set_anchors_preset(FULL_RECT)
        // to follow the window; a fixed size keeps headless layout assertions stable.
        const root = new Control();
        root.name = "AngularRoot";
        root.size = new Vector2(1024, 768);
        this.add_child(root);
        this.root_node = root;

        bundle
            .create(godot, root)
            .then((app) => {
                this.app = app;
                console.log("[demo] Angular bootstrapped");
            })
            .catch((err) => {
                console.error("[demo] Angular bootstrap failed\n  " + describeError(err));
                this.get_tree().quit(1);
            });
    }

    _process(delta) {
        this.frames++;
        if (this.app) this.app.tick(delta * 1000);

        if (this.snapshot && this.app && this.frames >= SNAPSHOT_AFTER_FRAMES) {
            console.log("[demo] --- node tree ---");
            printTree(this.root_node, 0);
            this.get_tree().quit(0);
        }
    }
}

module.exports = Main;
module.exports.default = Main;
