/// <reference types="vitest" />
import { beforeEach, describe, expect, it } from "vitest";
import { GodotPlatformLocation } from "../location";

/** 一条历史：记录每次 popstate 收到的事件，用于断言“谁该发、谁不该发”。 */
function recordPop(loc: GodotPlatformLocation) {
  const seen: { type: string; state: unknown }[] = [];
  const off = loc.onPopState((e) => seen.push({ type: e.type, state: e.state }));
  return { seen, off };
}

describe("GodotPlatformLocation：内存历史栈", () => {
  let loc: GodotPlatformLocation;

  beforeEach(() => {
    loc = new GodotPlatformLocation("/");
  });

  it("初始状态是根路径，href 长得像个 URL", () => {
    expect(loc.pathname).toBe("/");
    expect(loc.search).toBe("");
    expect(loc.hash).toBe("");
    expect(loc.href).toBe("godot://localhost/");
    expect(loc.protocol).toBe("godot:");
    expect(loc.hostname).toBe("localhost");
    expect(loc.port).toBe("");
    expect(loc.length).toBe(1);
    expect(loc.position).toBe(0);
  });

  it("起始 URL 由构造参数决定（深链启动）", () => {
    const deep = new GodotPlatformLocation("/detail/7?tab=info#top");
    expect(deep.pathname).toBe("/detail/7");
    expect(deep.search).toBe("?tab=info");
    expect(deep.hash).toBe("#top");
  });

  it("getBaseHrefFromDOM 返回空串而不是 undefined", () => {
    // PathLocationStrategy 的形状是 `href ?? getBaseHrefFromDOM() ?? inject(DOCUMENT).location`，
    // 走的是 `??`：空串能断掉这条链，undefined 则会一路走到 inject(DOCUMENT)——
    // 而那个 token 我们不提供（见 location-providers.ts），到那时就是 NG0201。
    expect(loc.getBaseHrefFromDOM()).toBe("");
  });

  it("pushState 拆开 path / query / hash", () => {
    loc.pushState(null, "", "/users/42?page=2#notes");
    expect(loc.pathname).toBe("/users/42");
    expect(loc.search).toBe("?page=2");
    expect(loc.hash).toBe("#notes");
    expect(loc.href).toBe("godot://localhost/users/42?page=2#notes");
  });

  it("不带前导斜杠的相对形式按根解析", () => {
    loc.pushState(null, "", "about");
    expect(loc.pathname).toBe("/about");
  });

  it("带 origin 的绝对地址只取 path 部分", () => {
    loc.pushState(null, "", "https://example.com/base/a?x=1");
    expect(loc.pathname).toBe("/base/a");
    expect(loc.search).toBe("?x=1");
  });

  it("只改锚点：#x 保留 pathname 与 search", () => {
    loc.pushState(null, "", "/page?q=1");
    loc.pushState(null, "", "#section");
    expect(loc.pathname).toBe("/page");
    expect(loc.search).toBe("?q=1");
    expect(loc.hash).toBe("#section");
  });

  it("只改查询：?x 保留 pathname 并清掉锚点", () => {
    loc.pushState(null, "", "/page#section");
    loc.pushState(null, "", "?q=1");
    expect(loc.pathname).toBe("/page");
    expect(loc.search).toBe("?q=1");
    expect(loc.hash).toBe("");
  });

  it("空串表示“地址不变”（浏览器把空 URL 解析成当前地址）", () => {
    loc.pushState(null, "", "/page?q=1");
    loc.pushState({ tag: "same" }, "", "");
    expect(loc.pathname).toBe("/page");
    expect(loc.search).toBe("?q=1");
    expect(loc.getState()).toEqual({ tag: "same" });
  });

  it("getState 跟着当前条目走", () => {
    loc.pushState({ n: 1 }, "", "/a");
    loc.pushState({ n: 2 }, "", "/b");
    expect(loc.getState()).toEqual({ n: 2 });
    loc.back();
    expect(loc.getState()).toEqual({ n: 1 });
  });

  it("replaceState 原地替换，历史长度不变", () => {
    loc.pushState(null, "", "/a");
    const before = loc.length;
    loc.replaceState(null, "", "/b");
    expect(loc.length).toBe(before);
    expect(loc.pathname).toBe("/b");
    loc.back();
    expect(loc.pathname).toBe("/");
  });

  it("pushState 丢弃 forward 分支（与浏览器一致）", () => {
    loc.pushState(null, "", "/a");
    loc.pushState(null, "", "/b");
    loc.back();
    expect(loc.pathname).toBe("/a");
    loc.pushState(null, "", "/c");
    expect(loc.length).toBe(3);
    loc.forward();
    expect(loc.pathname).toBe("/c");
  });
});

describe("GodotPlatformLocation：popstate 派发", () => {
  let loc: GodotPlatformLocation;

  beforeEach(() => {
    loc = new GodotPlatformLocation("/");
  });

  it("pushState / replaceState 不发 popstate", () => {
    // 浏览器也不发。发了会让 Router 每次导航后再收到一次“外部导航”
    const pop = recordPop(loc);
    const hashEvents: unknown[] = [];
    loc.onHashChange((e) => hashEvents.push(e));

    loc.pushState({ n: 1 }, "", "/a");
    loc.replaceState({ n: 2 }, "", "/b");
    expect(pop.seen).toEqual([]);
    expect(hashEvents).toEqual([]);
  });

  it("back / forward 发 popstate 并带上目标条目的 state", () => {
    loc.pushState({ n: 1 }, "", "/a");
    const pop = recordPop(loc);

    loc.back();
    expect(pop.seen).toEqual([{ type: "popstate", state: null }]);
    expect(loc.pathname).toBe("/");

    loc.forward();
    expect(pop.seen.length).toBe(2);
    expect(pop.seen[1]).toEqual({ type: "popstate", state: { n: 1 } });
    expect(loc.pathname).toBe("/a");
  });

  it("越界不动游标、不发事件", () => {
    loc.pushState(null, "", "/a");
    const pop = recordPop(loc);

    loc.back();
    pop.seen.length = 0;
    loc.back();
    expect(loc.position).toBe(0);
    expect(pop.seen).toEqual([]);

    loc.historyGo(-5);
    expect(pop.seen).toEqual([]);

    loc.historyGo(99);
    expect(loc.position).toBe(1);
    expect(pop.seen.length).toBe(1);
  });

  it("historyGo 一次跨多格，只发一次事件", () => {
    loc.pushState(null, "", "/a");
    loc.pushState(null, "", "/b");
    loc.pushState(null, "", "/c");
    const pop = recordPop(loc);

    loc.historyGo(-2);
    expect(loc.pathname).toBe("/a");
    expect(pop.seen.length).toBe(1);
  });

  it("退订后不再收事件", () => {
    const pop = recordPop(loc);
    loc.pushState(null, "", "/a");
    loc.back();
    expect(pop.seen.length).toBe(1);

    pop.off();
    loc.forward();
    expect(pop.seen.length).toBe(1);
  });

  it("多个监听者都收到；回调里退订不影响本轮派发", () => {
    loc.pushState(null, "", "/a");
    const hits: string[] = [];
    const offSecond = loc.onPopState(() => {
      hits.push("second");
      offSecond();
    });
    loc.onPopState(() => hits.push("third"));

    loc.back();
    loc.forward();
    expect(hits).toEqual(["second", "third", "third"]);
  });
});


describe("GodotPlatformLocation：URL 三段切分", () => {
  const TABLE: [string, string, string, string, string][] = [
    ["/", "/about", "/about", "", ""],
    ["/", "about", "/about", "", ""],
    ["/", "./x", "/x", "", ""],
    ["/", "../x", "/x", "", ""],
    ["/a/b/c", "about", "/a/b/about", "", ""],
    ["/a/b/c", "../x", "/a/x", "", ""],
    ["/a/b/c", "./x", "/a/b/x", "", ""],
    ["/detail/7", "/a/../b", "/b", "", ""],
    ["/detail/7", "/a/./b", "/a/b", "", ""],
    ["/a/b/c", "/x/./y/../z", "/x/z", "", ""],
    ["/", "/..", "/", "", ""],
    ["/", "/.", "/", "", ""],
    ["/", "/./../x", "/x", "", ""],
    ["/a/b/", "../x", "/a/x", "", ""],
    ["/detail/7?q=x#f", "#", "/detail/7", "?q=x", ""],
    ["/detail/7?q=x#f", "?q=1", "/detail/7", "?q=1", ""],
    ["/detail/7?q=x#f", "", "/detail/7", "?q=x", ""],
    ["/detail/7?q=x#f", "?q=1#frag", "/detail/7", "?q=1", "#frag"],
    ["/", "#f#g", "/", "", "#f#g"],
    ["/", "#a?b", "/", "", "#a?b"],
    ["/", "?q=", "/", "?q=", ""],
    ["/detail/7?q=x#f", "#new", "/detail/7", "?q=x", "#new"],
    ["/about", "?q=1#f", "/about", "?q=1", "#f"],
    ["/", "godot://localhost/x", "/x", "", ""],
    ["/", "http://h/p?q#f", "/p", "?q", "#f"],
    ["/", "HTTP://H/P", "/P", "", ""],
    ["/", "/a b", "/a%20b", "", ""],
    ["/", "/x\ty", "/xy", "", ""],
    ["/", "  /pad  ", "/pad", "", ""],
    ["/", "/a//b", "/a//b", "", ""],
    ["/", "/%2e/x", "/x", "", ""],
    ["/", "/a/%2E%2E/b", "/b", "", ""],
    ["/", "/中文/x", "/%E4%B8%AD%E6%96%87/x", "", ""],
    ["/", "/a?q=中文", "/a", "?q=%E4%B8%AD%E6%96%87", ""],
    ["/", "/a#中文", "/a", "", "#%E4%B8%AD%E6%96%87"],
    ["/", "/a%2Fb", "/a%2Fb", "", ""],
    ["/", "/a%zz", "/a%zz", "", ""],
    ["/", "/a?b#c#d", "/a", "?b", "#c#d"],
  ];

  for (const [base, raw, pathname, search, hash] of TABLE) {
    it(`base ${base} + ${JSON.stringify(raw)}`, () => {
      const loc = new GodotPlatformLocation(base);
      loc.pushState(null, "", raw);
      expect(loc.pathname).toBe(pathname);
      expect(loc.search).toBe(search);
      expect(loc.hash).toBe(hash);
    });
  }

  it("replaceState 走同一套解析", () => {
    const loc = new GodotPlatformLocation("/a/b/c");
    loc.replaceState(null, "", "../x");
    expect(loc.pathname).toBe("/a/x");
  });

  it("起始 URL 本身也走这套解析", () => {
    expect(new GodotPlatformLocation("/a/../b").pathname).toBe("/b");
    expect(new GodotPlatformLocation("godot://localhost/x?q=1").pathname).toBe("/x");
    expect(new GodotPlatformLocation("godot://localhost/x?q=1").search).toBe("?q=1");
  });
});
