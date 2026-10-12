import { randomBytes } from 'node:crypto';
import type { Config } from '../config/types.ts';

export function sessionOptions(config: Config['webui']) {
  return { ttlSeconds: (config.session_ttl_minutes ?? 720) * 60,
    capacity: config.max_sessions ?? 64, attempts: config.login_attempts_per_min ?? 10 };
}

export function sessionCookie(header: string | undefined): string | undefined {
  const matches = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('guard_session='));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice('guard_session='.length);
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function cookie(value: string, ttlSeconds: number): string {
  // Plain HTTP deployments require a cookie without Secure. See docs/webui.md.
  return `guard_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttlSeconds}`;
}

export class Sessions {
  private entries = new Map<string, number>();
  private failures = new Map<string, { count: number; until: number }>();
  readonly options: ReturnType<typeof sessionOptions>;
  private now: () => number;
  constructor(config: Config['webui'], now = Date.now) { this.options = sessionOptions(config); this.now = now; }
  private prune(): void {
    const now = this.now();
    for (const [id, expires] of this.entries) if (expires <= now) this.entries.delete(id);
    for (const [ip, entry] of this.failures) if (entry.until <= now) this.failures.delete(ip);
  }
  valid(id: string | undefined): boolean { this.prune(); return id !== undefined && this.entries.has(id); }
  create(): string {
    this.prune();
    while (this.entries.size >= this.options.capacity) this.entries.delete(this.entries.keys().next().value!);
    const id = randomBytes(32).toString('hex');
    this.entries.set(id, this.now() + this.options.ttlSeconds * 1000); return id;
  }
  remove(id: string | undefined): void { if (id !== undefined) this.entries.delete(id); }
  limited(ip: string): boolean {
    this.prune(); return this.options.attempts > 0 && (this.failures.get(ip)?.count ?? 0) >= this.options.attempts;
  }
  failed(ip: string): void {
    this.prune(); if (!this.options.attempts) return;
    const previous = this.failures.get(ip);
    if (previous) { previous.count++; return; }
    if (this.failures.size >= 1024) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(ip, { count: 1, until: this.now() + 60000 });
  }
  clear(): void { this.entries.clear(); this.failures.clear(); }
}
