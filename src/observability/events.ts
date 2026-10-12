export type EventType = 'denied' | 'session_open' | 'session_close' | 'transport_issue' | 'reload';
export interface ObservationEvent { time: string; event: EventType; [key: string]: unknown }

// Zero capacity disables retention and publication. No timers or per-event copies when disabled.
export class EventRing {
  private entries: ObservationEvent[] = [];
  private cursor = 0;
  private listeners = new Set<(event: ObservationEvent) => void>();
  capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }
  get subscriberCount(): number { return this.listeners.size; }
  publish(event: ObservationEvent): void {
    if (!this.capacity) return;
    // Metadata may include peer-controlled scope IDs. Bound strings as well as entry count.
    const bounded: ObservationEvent = { time: event.time, event: event.event };
    for (const key of ['level', 'endpoint', 'side', 'connection', 'onebot', 'route', 'direction', 'rule', 'reason', 'generation', 'scope', 'ok', 'preview']) {
      const value = event[key];
      if (typeof value === 'string') bounded[key] = value.slice(0, key === 'preview' ? 4096 : 512);
      else if (typeof value === 'boolean' || typeof value === 'number') bounded[key] = value;
    }
    event = Object.freeze(bounded);
    if (this.entries.length < this.capacity) this.entries.push(event);
    else { this.entries[this.cursor] = event; this.cursor = (this.cursor + 1) % this.capacity; }
    for (const listener of this.listeners) listener(event);
  }
  recent(count = this.capacity): ObservationEvent[] {
    const ordered = [...this.entries.slice(this.cursor), ...this.entries.slice(0, this.cursor)];
    return ordered.slice(ordered.length - Math.max(0, Math.min(ordered.length, count)));
  }
  subscribe(listener: (event: ObservationEvent) => void, count = this.capacity): () => void {
    // Synchronous replay and registration leave no event-loop gap.
    for (const event of this.recent(count)) listener(event);
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
