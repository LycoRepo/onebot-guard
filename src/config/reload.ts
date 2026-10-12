import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './types.ts';
import { loadConfig } from './load.ts';

export function reloadPolicies(current: Config, next: Config): Config {
  const { policies: _old, ...fixed } = current;
  const { policies: _new, ...nextFixed } = next;
  if (!isDeepStrictEqual(fixed, nextFixed, { skipPrototype: true })) throw new Error('策略以外的配置已变化（端点、账号、凭据、运行参数等），必须重启进程；保留旧策略');
  return { ...current, policies: next.policies };
}
export class PolicyReloader {
  lastResult: { ok: boolean; reason: string; time: string } | null = null;
  sanitize: (reason: string) => string;
  path: string; current: Config;
  apply: (config: Config) => void;
  report: (success: boolean, reason: string) => void;
  watcher: FSWatcher | undefined; timer: NodeJS.Timeout | undefined;
  constructor(path: string, config: Config, apply: (config: Config) => void, report: (success: boolean, reason: string) => void, sanitize = (reason: string): string => reason) {
    this.path = path; this.current = config; this.apply = apply; this.report = report;
    this.sanitize = sanitize;
  }
  private result(ok: boolean, reason: string): boolean {
    reason = this.sanitize(reason).slice(0, 512);
    this.lastResult = { ok, reason, time: new Date().toISOString() };
    this.report(ok, reason); return ok;
  }
  reload(): boolean {
    try {
      const next = reloadPolicies(this.current, loadConfig(this.path));
      this.apply(next); this.current = next;
      return this.result(true, 'policies_reloaded');
    } catch (error) {
      return this.result(false, error instanceof Error ? error.message : '策略重载失败，保留旧策略');
    }
  }
  start(): void {
    if (!this.current.reload.policy_watch) return;
    // Watch the directory so atomic file replacement also triggers a reload.
    this.watcher = watch(dirname(this.path), (_event, filename) => {
      if (filename !== null && filename.toString() !== basename(this.path)) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = undefined; this.reload(); }, this.current.reload.debounce_ms);
    });
    this.watcher.on('error', () => this.result(false, '策略文件监听失败；保留旧策略，可用 SIGHUP 重载或重启'));
  }
  stop(): void { clearTimeout(this.timer); this.watcher?.close(); }
}
