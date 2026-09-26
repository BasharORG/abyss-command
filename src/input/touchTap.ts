export function installTouchTaps() {
  document.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType !== "touch") return;
      const el = (e.target as Element | null)?.closest?.(
        "button, .select-card, .unit-card"
      ) as HTMLElement | null;
      if (!el || el.hasAttribute("disabled")) return;
      el.click();
      el.setAttribute("data-touch-tapped", "1");
    },
    true
  );
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("[data-touch-tapped]") as HTMLElement | null;
      if (!el) return;
      el.removeAttribute("data-touch-tapped");
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
}
