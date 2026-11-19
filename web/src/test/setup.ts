import { cleanup } from "@testing-library/react";
import { overlays } from "@ui-sdk/core/overlays";
import { afterEach } from "vitest";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}
// UI SDK's development warnings fail the test.
globalThis.__UI_SDK_STRICT__ = true;

// App mounts the one Toaster; a page test whose action toasts doesn't. UI SDK
// checks for a host once, 1 s after a file's first toast, so whether a test's
// own <Toaster /> was mounted at that instant depended on load (the toast
// flake of UI tickets 13 and 21). Count one host for the whole run; a test
// that reads a toast still renders <Toaster />. See test/toast-host.test.tsx.
overlays.attachHost();

// jsdom gaps UI SDK needs filled (its skill's references/testing.md). Assigned,
// not ??=, because jsdom has some of these without the parts that matter.
HTMLElement.prototype.showPopover = function () {};
HTMLElement.prototype.hidePopover = function () {};
Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView = function () {};
Element.prototype.checkVisibility = () => true;
Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
document.elementFromPoint = () => null;
document.elementsFromPoint = () => [];
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
document.head.append(
  Object.assign(document.createElement("style"), {
    textContent: "[popover] { display: block !important }",
  }),
);

afterEach(cleanup);
