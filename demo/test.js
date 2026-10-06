// Engine-side integration test. Run with:
//   godot --headless --path demo res://test.tscn
// It drives the real demo bundle: emits real Godot signals on real nodes and
// asserts the node tree Angular produced. This is the only way to prove the
// signal -> Angular listener -> change detection -> re-render loop closes.
const godot = require("godot");
const { Node, Control, Vector2 } = godot;
const bundle = require("res://dist/app.bundle.js");

let passed = 0;
const failures = [];

function check(label, got, expected) {
    const ok = String(got) === String(expected);
    if (ok) {
        passed++;
        console.log("[TEST] ok   " + label);
    } else {
        failures.push(label + "  got=" + JSON.stringify(String(got)) + " want=" + JSON.stringify(String(expected)));
        console.log("[TEST] FAIL " + label + "  got=" + JSON.stringify(String(got)) + " want=" + JSON.stringify(String(expected)));
    }
}

function checkTrue(label, cond) {
    if (cond) {
        passed++;
        console.log("[TEST] ok   " + label);
    } else {
        failures.push(label);
        console.log("[TEST] FAIL " + label);
    }
}

/** depth-first collect every node whose class matches */
function all(node, cls, out) {
    out = out || [];
    if (node.get_class() === cls) out.push(node);
    for (let i = 0; i < node.get_child_count(); i++) all(node.get_child(i), cls, out);
    return out;
}

/** first node whose text equals `text` */
function byText(root, text) {
    const labels = all(root, "Label").concat(all(root, "Button"));
    for (const n of labels) if (n.text === text) return n;
    return null;
}

function texts(root, cls) {
    return all(root, cls || "Label").map((n) => n.text);
}

class TestRunner extends Node {
    _ready() {
        this.frames = 0;
        this.app = null;
        this._frameWaiters = [];

        const root = new Control();
        root.name = "AngularRoot";
        root.size = new Vector2(1024, 768);
        this.add_child(root);
        this.root_node = root;

        bundle
            .create(godot, root)
            .then((app) => {
                this.app = app;
                this._run().catch((err) => {
                    console.log("[TEST] crashed: " + (err && err.stack ? err.stack : err));
                    this.get_tree().quit(2);
                });
            })
            .catch((err) => {
                console.log("[TEST] bootstrap failed: " + (err && err.stack ? err.stack : err));
                this.get_tree().quit(2);
            });
    }

    _process(delta) {
        this.frames++;
        if (this.app) this.app.tick(delta * 1000);
        const waiters = this._frameWaiters;
        this._frameWaiters = [];
        for (const resolve of waiters) resolve();
    }

    /** resolve after the engine has run `n` more frames (change detection included) */
    frames_(n) {
        n = n || 2;
        let p = Promise.resolve();
        for (let i = 0; i < n; i++) {
            p = p.then(() => new Promise((resolve) => this._frameWaiters.push(resolve)));
        }
        return p;
    }

    async _run() {
        const root = this.root_node;
        await this.frames_(3);

        console.log("[TEST] --- initial render ---");
        checkTrue("root component mounted", all(root, "VBoxContainer").length > 0);
        checkTrue("title label present", !!byText(root, "control-ui-js \u2014 Angular in Godot"));
        check("initial counter", (byText(root, "count = 0") ? "count = 0" : "missing"), "count = 0");
        check("@if true branch", (byText(root, "@if \u4e3a\u771f\u65f6\u5b58\u5728") ? "shown" : "missing"), "shown");
        check("@for item count", all(root, "Label").filter((l) => /^item-\d$/.test(l.text)).length, 3);
        check("@switch default case", (byText(root, "\u6a21\u5f0f A") ? "A" : "missing"), "A");
        check("ng-content projected", (byText(root, "\u8fd9\u884c\u662f\u88ab\u6295\u5f71\u8fdb\u6765\u7684\u5185\u5bb9") ? "projected" : "missing"), "projected");

        console.log("[TEST] --- Button.pressed -> (click) -> signal -> re-render ---");
        const plus = byText(root, "+1");
        checkTrue("+1 button found", !!plus);
        plus.emit_signal("pressed");
        await this.frames_();
        check("counter after one click", (byText(root, "count = 1") ? "count = 1" : "missing"), "count = 1");
        plus.emit_signal("pressed");
        plus.emit_signal("pressed");
        await this.frames_();
        check("counter after three clicks", (byText(root, "count = 3") ? "count = 3" : "missing"), "count = 3");

        console.log("[TEST] --- @if toggles ---");
        byText(root, "toggle @if").emit_signal("pressed");
        await this.frames_();
        checkTrue("@if else branch rendered", !!byText(root, "@if \u4e3a\u5047"));
        checkTrue("@if true branch removed", byText(root, "@if \u4e3a\u771f\u65f6\u5b58\u5728") === null);
        byText(root, "toggle @if").emit_signal("pressed");
        await this.frames_();
        checkTrue("@if branch restored", !!byText(root, "@if \u4e3a\u771f\u65f6\u5b58\u5728"));

        console.log("[TEST] --- @for add / remove ---");
        byText(root, "add").emit_signal("pressed");
        await this.frames_();
        check("items after add", all(root, "Label").filter((l) => /^item-\d$/.test(l.text)).length, 4);
        byText(root, "remove").emit_signal("pressed");
        await this.frames_();
        check("items after remove", all(root, "Label").filter((l) => /^item-\d$/.test(l.text)).length, 3);
        check("first item is item-2", all(root, "Label").filter((l) => /^item-\d$/.test(l.text))[0].text, "item-2");

        console.log("[TEST] --- @switch cycles ---");
        byText(root, "cycle @switch").emit_signal("pressed");
        await this.frames_();
        checkTrue("@switch case B", !!byText(root, "\u6a21\u5f0f B"));
        checkTrue("@switch case A removed", byText(root, "\u6a21\u5f0f A") === null);

        console.log("[TEST] --- LineEdit.text_changed -> (input) ---");
        const edit = all(root, "LineEdit")[0];
        checkTrue("LineEdit found", !!edit);
        edit.text = "typed text";
        edit.emit_signal("text_changed", "typed text");
        await this.frames_();
        check("input binding round-trip", (byText(root, "input: typed text") ? "ok" : "missing"), "ok");

        console.log("[TEST] --- layout actually ran ---");
        const demo = all(root, "VBoxContainer")[0];
        checkTrue("root container got a real size", demo.size.x > 0 && demo.size.y > 0);
        const kids = [];
        for (let i = 0; i < demo.get_child_count(); i++) {
            const c = demo.get_child(i);
            if (c.get_class() !== "Node") kids.push(c);
        }
        checkTrue("children stacked vertically by the container", kids[1].position.y > kids[0].position.y);
        checkTrue("container width propagated to children", kids[0].size.x === demo.size.x);

        console.log("[TEST] --- property coercion ---");
        const styled = byText(root, "styled label");
        checkTrue("customMinimumSize coercion (y=40)", Math.round(styled.size.y) >= 40);
        checkTrue("theme color override applied", styled.has_theme_color_override("font_color"));
        checkTrue("theme font size override applied", styled.has_theme_font_size_override("font_size"));

        console.log("[TEST] --- summary ---");
        console.log("[TEST] passed=" + passed + " failed=" + failures.length);
        if (failures.length) {
            for (const f of failures) console.log("[TEST]   FAILED: " + f);
        }
        this.get_tree().quit(failures.length ? 1 : 0);
    }
}

module.exports = TestRunner;
module.exports.default = TestRunner;
