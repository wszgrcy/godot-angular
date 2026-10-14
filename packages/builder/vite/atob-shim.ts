import base64 from "base-64";

if (typeof (globalThis as { atob?: unknown }).atob !== "function") {
  (globalThis as { atob?: (input: string) => string }).atob = function atobShim(input: string): string {
    return base64.decode(input);
  };
}

