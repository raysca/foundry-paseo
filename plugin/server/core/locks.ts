// In-process named locks. The feature lock serialises merges, approvals and planning turns on one
// feature; the attempt lock serialises the loop's reactions to one attempt's events.
export class Locks {
  private tails = new Map<string, Promise<void>>();
  private held = new Set<string>();

  async with<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(name, tail);
    await prev;
    this.held.add(name);
    try {
      return await fn();
    } finally {
      this.held.delete(name);
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }

  isHeld(name: string) {
    return this.held.has(name);
  }
}
