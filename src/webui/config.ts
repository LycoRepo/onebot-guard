import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Document } from 'yaml';
import { isMap, isSeq, parseDocument } from 'yaml';
import { validateConfig } from '../config/load.ts';
import type { Config, Route } from '../config/types.ts';
import { PolicyError } from './policies.ts';

const MAX_FILE = 1048576;
function document(raw: string) {
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new PolicyError('配置 YAML 语法无效或键重复');
  try { doc.toJS({ maxAliasCount: 0 }); }
  catch { throw new PolicyError('配置不允许 YAML alias'); }
  return doc;
}
/** 只替换一个顶层节点的源范围，其它字节、注释与缩进保留。 */
function renderRegion(original: string, doc: Document, range: [number, number, number], key: string): string {
  // The first line's indentation belongs to the original prefix. Render subsequent
  // lines at that same depth, including files using four-space indentation.
  const prefix = original.slice(original.lastIndexOf('\n', range[0] - 1) + 1, range[0]);
  const indent = /^ +$/.test(prefix) ? prefix.length : 2;
  const rendered = doc.toString({ indent });
  const next = document(rendered);
  const node = next.get(key, true);
  if ((!isMap(node) && !isSeq(node)) || !node.range) throw new PolicyError(`${key}: 无法生成配置文档`);
  return original.slice(0, range[0]) + rendered.slice(node.range[0], node.range[1]) + original.slice(range[1]);
}
/** 同目录独占创建 + rename 原子替换；失败时清理临时文件并抛出面板可读的错误。 */
function writeAtomic(path: string, updated: string): void {
  const temporary = join(dirname(path), `.webui-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, updated, { flag: 'wx', mode: fs.statSync(path).mode & 0o777 });
    fs.renameSync(temporary, path);
  } catch { throw new PolicyError('配置文件写入失败，请检查目录写入权限及原子替换支持'); }
  finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
}

export class ConfigFile {
  path: string;
  constructor(path: string) { this.path = path; }
  private read(): string {
    try {
      if (fs.statSync(this.path).size > MAX_FILE) throw new PolicyError('配置文件超过 1 MiB 上限');
      const raw = fs.readFileSync(this.path, 'utf8');
      if (Buffer.byteLength(raw) > MAX_FILE) throw new PolicyError('配置文件超过 1 MiB 上限');
      return raw;
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError('配置文件无法读取，请检查读取权限');
    }
  }
  get(running?: Config) {
    try {
      const cfg = validateConfig(document(this.read()).toJS({ maxAliasCount: 0 }));
      // Explicit projection: never return other sections, TLS credentials or environment values.
      const endpoints = Object.fromEntries(Object.entries(cfg.endpoints).map(([id, e]) => [id, {
        id, side: e.side, connection: e.connection, protocol: e.protocol, token_env: e.token_env,
        reconnect: e.reconnect,
        ...(e.connection === 'connect' ? { url: e.url } : { host: e.host, port: e.port }),
        ...(e.side === 'upstream' ? { expected_self_id: e.expected_self_id } : { principal: e.principal, readonly: e.readonly }),
        used: cfg.routes.some(r => r.upstream === id || r.downstream === id),
      }]));
      const { policies: _savedPolicies, ...savedFixed } = cfg;
      const { policies: _runningPolicies, ...runningFixed } = running ?? cfg;
      return { endpoints, routes: cfg.routes, policies: Object.keys(cfg.policies),
        restart_required: !isDeepStrictEqual(savedFixed, runningFixed, { skipPrototype: true }) };
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError(error instanceof Error ? error.message : '配置全量校验失败');
    }
  }
  save(body: unknown): boolean {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3 ||
        !('endpoints' in body) || !('routes' in body) || !('restart' in body) || typeof body.restart !== 'boolean') {
      throw new PolicyError('请求体仅允许 endpoints、routes 和 restart 布尔字段，三者必填');
    }
    const original = this.read();
    const doc = document(original);
    const ranges: { start: number; end: number; key: string }[] = [];
    try {
      const current = doc.toJS({ maxAliasCount: 0 });
      const oldConfig = validateConfig(current);
      // 面板之外的脚本可能不带 enabled：沿用磁盘上的开关状态，避免保存端点/路由时
      // 悄悄把某个后端重新打开，变成两个后端同时回复。
      const routes = Array.isArray(body.routes) ? body.routes.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const route = item as Record<string, unknown>;
        const known = oldConfig.routes.find(old => old.id === route.id);
        return known && !Object.hasOwn(route, 'enabled') ? { ...route, enabled: known.enabled } : route;
      }) : body.routes;
      const validated = validateConfig({ ...current, endpoints: body.endpoints, routes });
      const payload = { endpoints: body.endpoints, routes } as Record<'endpoints' | 'routes', unknown>;
      // TLS editing is outside this batch; do not silently strip existing certificates
      // through a browser projection that deliberately excludes credential fields.
      for (const id of new Set([...Object.keys(oldConfig.endpoints), ...Object.keys(validated.endpoints)])) {
        if (!isDeepStrictEqual(oldConfig.endpoints[id]?.tls, validated.endpoints[id]?.tls)) {
          throw new PolicyError('本批不支持新增、修改或移除 TLS 配置，请保留现有 TLS 字段');
        }
      }
      for (const key of ['endpoints', 'routes'] as const) {
        const old = doc.get(key, true);
        if ((!isMap(old) && !isSeq(old)) || !old.range) throw new PolicyError(`${key}: 当前配置缺少节点`);
        ranges.push({ start: old.range[0], end: old.range[1], key });
        const replacement = doc.createNode(payload[key]);
        if (!isMap(replacement) && !isSeq(replacement)) throw new PolicyError(`${key}: 无法生成配置节点`);
        if (old.flow !== undefined) replacement.flow = old.flow;
        if (old.commentBefore !== undefined) replacement.commentBefore = old.commentBefore;
        doc.set(key, replacement);
      }
      let updated = original;
      for (const range of ranges.sort((a, b) => b.start - a.start)) {
        // The first line's indentation belongs to the original prefix. Render subsequent
        // lines at that same depth, including files using four-space indentation.
        const prefix = original.slice(original.lastIndexOf('\n', range.start - 1) + 1, range.start);
        const indent = /^ +$/.test(prefix) ? prefix.length : 2;
        const rendered = doc.toString({ indent });
        const next = document(rendered);
        const node = next.get(range.key, true);
        if ((!isMap(node) && !isSeq(node)) || !node.range) throw new PolicyError(`${range.key}: 无法生成配置文档`);
        updated = updated.slice(0, range.start) + rendered.slice(node.range[0], node.range[1]) + updated.slice(range.end);
      }
      if (Buffer.byteLength(updated) > MAX_FILE) throw new PolicyError('配置文件超过 1 MiB 上限');
      validateConfig(document(updated).toJS({ maxAliasCount: 0 }));
      // Synchronous transaction, same-directory atomic rename; no runtime reload.
      const temporary = join(dirname(this.path), `.webui-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, updated, { flag: 'wx', mode: fs.statSync(this.path).mode & 0o777 });
        fs.renameSync(temporary, this.path);
      } catch { throw new PolicyError('配置文件写入失败，请检查目录写入权限及原子替换支持'); }
      finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
      return body.restart;
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError(error instanceof Error ? error.message : '配置全量校验失败');
    }
  }
  /**
   * 切换某个上游下生效的路由：同一个上游只留一条 enabled，
   * 只改写每条 route 的 enabled 键，其余字节与注释原样保留。
   */
  switchRoute(routeId: string): Route[] {
    const original = this.read();
    const doc = document(original);
    try {
      const current = doc.toJS({ maxAliasCount: 0 });
      const cfg = validateConfig(current);
      const target = cfg.routes.find(route => route.id === routeId);
      if (!target) throw new PolicyError('未找到该路由，请刷新页面后重试');
      const routes = cfg.routes.map(route => ({ ...route, enabled: route.upstream === target.upstream ? route.id === routeId : route.enabled }));
      const node = doc.get('routes', true);
      if (!isSeq(node) || !node.range) throw new PolicyError('routes: 当前配置缺少节点');
      const range = node.range as [number, number, number];
      node.items.forEach((item, index) => {
        const next = routes[index]!;
        if (isMap(item) && item.get('enabled') !== next.enabled) item.set('enabled', next.enabled);
      });
      const updated = renderRegion(original, doc, range, 'routes');
      if (Buffer.byteLength(updated) > MAX_FILE) throw new PolicyError('配置文件超过 1 MiB 上限');
      validateConfig(document(updated).toJS({ maxAliasCount: 0 }));
      writeAtomic(this.path, updated);
      return routes;
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError(error instanceof Error ? error.message : '路由切换失败，配置未改变');
    }
  }
}
