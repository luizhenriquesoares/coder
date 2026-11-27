/** What the poller needs to know about the page: whether anyone can see it. `document` fits. */
export interface PageVisibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `tick` every `intervalMs` while the page is visible. Hidden, it stops; visible again, it
 * ticks at once and starts over. Returns the function that stops it for good.
 */
export function everyWhileVisible(page: PageVisibility, intervalMs: number, tick: () => void): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const pause = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const resume = () => {
    pause();
    timer = setInterval(tick, intervalMs);
  };
  const onChange = () => {
    if (page.hidden) return pause();
    tick();
    resume();
  };
  page.addEventListener("visibilitychange", onChange);
  if (!page.hidden) resume();
  return () => {
    pause();
    page.removeEventListener("visibilitychange", onChange);
  };
}
