/** Debounces work per key (e.g. per file path), so one key's pending work never cancels another's. */
export class PathDebouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private delayMs: number) {}

  schedule(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, this.delayMs)
    );
  }

  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** Collapses bursts of calls into one trailing call. */
export class Coalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private delayMs: number, private fn: () => void) {}

  trigger(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fn();
    }, this.delayMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
