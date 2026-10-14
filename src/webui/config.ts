import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isSeq, parseDocument } from 'yaml';
import { validateConfig } from '../config/load.ts';
import { PolicyError } from './policies.ts';

const MAX_FILE = 1048576;
function document(raw: string) {
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new PolicyError('配置 YAML 语法无效或键重复');
  try { doc.toJS({ maxAliasCount: 0 }); }
  catch { throw new PolicyError('配置不允许 YAML alias'); }
  return doc;
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
  get() {
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
      return { endpoints, routes: cfg.routes, policies: Object.keys(cfg.policies) };
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
      const validated = validateConfig({ ...current, endpoints: body.endpoints, routes: body.routes });
      // TLS editing is outside this batch; do not silently strip existing certificates
      // through a browser projection that deliberately excludes credential fields.
      const oldConfig = validateConfig(current);
      for (const id of new Set([...Object.keys(oldConfig.endpoints), ...Object.keys(validated.endpoints)])) {
        if (!isDeepStrictEqual(oldConfig.endpoints[id]?.tls, validated.endpoints[id]?.tls)) {
          throw new PolicyError('本批不支持新增、修改或移除 TLS 配置，请保留现有 TLS 字段');
        }
      }
      for (const key of ['endpoints', 'routes'] as const) {
        const old = doc.get(key, true);
        if ((!isMap(old) && !isSeq(old)) || !old.range) throw new PolicyError(`${key}: 当前配置缺少节点`);
        ranges.push({ start: old.range[0], end: old.range[1], key });
        const replacement = doc.createNode(body[key]);
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
}
