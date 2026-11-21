export async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      if (copyWithTextarea(text)) return;
      throw e;
    }
  }
  if (!copyWithTextarea(text)) throw new Error("The browser refused to copy.");
}

function copyWithTextarea(text: string): boolean {
  const before = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  before?.focus?.({ preventScroll: true });
  return ok;
}
