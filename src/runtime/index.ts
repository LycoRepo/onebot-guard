import { randomUUID } from 'node:crypto';
import type { Packet } from '../protocol/onebot11/index.ts';
export class Dedupe {
  entries = new Map<string, number>();
  max: number;
  constructor(max: number) { this.max = max; }
  seen(key: string, ttl: number, now = Date.now()): boolean {
    for (const [k, expiry] of this.entries) if (expiry <= now) this.entries.delete(k);
    if ((this.entries.get(key) ?? 0) > now) return true;
    if (ttl > 0) { if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!); this.entries.set(key, now + ttl); }
    return false;
  }
  clear(): void { this.entries.clear(); }
}
export class RateLimiter {
  entries = new Map<string, { start: number; count: number }>();
  max: number;
  constructor(max: number) { this.max = max; }
  consume(dimensions: { key: string; limit: number }[], now = Date.now()): boolean {
    for (const [k, entry] of this.entries) if (entry.start + 60000 <= now) this.entries.delete(k);
    const active = dimensions.filter(d => d.limit > 0);
    const newKeys = new Set(active.filter(d => !this.entries.has(d.key)).map(d => d.key));
    if (this.entries.size + newKeys.size > this.max) return false;
    if (active.some(d => (this.entries.get(d.key)?.count ?? 0) >= d.limit)) return false;
    for (const d of active) {
      const entry = this.entries.get(d.key) ?? { start: now, count: 0 };
      entry.count++; this.entries.set(d.key, entry);
    }
    return true;
  }
  clear(): void { this.entries.clear(); }
}
export interface Pending {
  echo: string; original: Packet; route: string; downstreamGeneration: string; upstreamGeneration: string;
  originalEcho: { present: boolean; type: string; value: unknown };
  expires: number; action: string;
}
export class EchoMap {
  entries = new Map<string, Pending>();
  maxPerRoute: number; timeout: number;
  constructor(max: number, timeout: number) { this.maxPerRoute = max; this.timeout = timeout; }
  add(original: Packet, route: string, downstreamGeneration: string, upstreamGeneration: string, action: string): Pending | undefined {
    if ([...this.entries.values()].filter(p => p.route === route).length >= this.maxPerRoute) return undefined;
    const present = Object.hasOwn(original, 'echo');
    const value: unknown = present ? structuredClone(original.echo) : undefined;
    const pending = { echo: randomUUID(), original: present ? { echo: value } : {}, originalEcho: { present, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, value }, route, downstreamGeneration, upstreamGeneration, action, expires: Date.now() + this.timeout };
    this.entries.set(pending.echo, pending); return pending;
  }
  take(echo: unknown, upstreamGeneration: string, now = Date.now()): Pending | undefined {
    if (typeof echo !== 'string') return undefined;
    const pending = this.entries.get(echo);
    if (!pending || pending.upstreamGeneration !== upstreamGeneration) return undefined;
    // Leave expired entries for the route's timeout sweep to report explicitly.
    if (pending.expires <= now) return undefined;
    this.entries.delete(echo); return pending;
  }
  remove(predicate: (p: Pending) => boolean): Pending[] {
    const removed: Pending[] = [];
    for (const [echo, p] of this.entries) if (predicate(p)) { this.entries.delete(echo); removed.push(p); }
    return removed;
  }
  restore(response: Packet, pending: Pending): Packet {
    const p = { ...response }; delete p.echo;
    if (pending.originalEcho.present) p.echo = pending.originalEcho.value;
    return p;
  }
}
