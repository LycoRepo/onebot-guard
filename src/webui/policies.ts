import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Document, isMap, parseDocument } from 'yaml';
import { validateConfig } from '../config/load.ts';
import { reloadPolicies, PolicyReloader } from '../config/reload.ts';

const MAX_FILE = 1048576;
export class PolicyError extends Error {}

function document(raw: string) {
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new PolicyError('policies: YAML 语法无效或键重复，请检查缩进与键名');
  try { doc.toJS({ maxAliasCount: 0 }); }
  catch { throw new PolicyError('policies: 不允许 YAML alias'); }
  return doc;
}

export class PolicyFile {
  path: string;
  reloader: PolicyReloader;
  constructor(path: string, reloader: PolicyReloader) { this.path = path; this.reloader = reloader; }
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
  get(): { yaml: string; parsed: unknown } {
    const doc = document(this.read());
    // An external edit may have inserted forbidden credential fields since startup.
    // Never return an unvalidated file's contents through the read API.
    try { validateConfig(doc.toJS({ maxAliasCount: 0 })); }
    catch (error) { throw new PolicyError(error instanceof Error ? error.message : '配置全量校验失败'); }
    const node = doc.get('policies', true);
    if (!isMap(node)) throw new PolicyError('policies: 必须是对象');
    // Return only the policies node, never the containing configuration or credentials.
    const policies = new Document(node.clone());
    return { yaml: policies.toString(), parsed: policies.toJS({ maxAliasCount: 0 }) };
  }
  save(yaml: string): { ok: true; reload: NonNullable<PolicyReloader['lastResult']> } {
    const incoming = document(yaml);
    if (!isMap(incoming.contents)) throw new PolicyError('policies: 必须是策略名称到策略的映射');
    const original = this.read();
    const doc = document(original);
    const old = doc.get('policies', true);
    if (!isMap(old) || !old.range) throw new PolicyError('policies: 当前配置缺少策略映射');
    const replacement = incoming.contents.clone();
    // Keep flow/block layout so the edited value fits its original YAML context.
    if (old.flow !== undefined) replacement.flow = old.flow;
    if (old.commentBefore !== undefined) replacement.commentBefore = old.commentBefore;
    doc.set('policies', replacement);
    const rendered = doc.toString();
    const nextNode = document(rendered).get('policies', true);
    if (!isMap(nextNode) || !nextNode.range) throw new PolicyError('policies: 无法生成策略文档');
    // The Document API supplies the new value; source ranges preserve every byte outside it.
    const updated = original.slice(0, old.range[0]) + rendered.slice(nextNode.range[0], nextNode.range[1]) + original.slice(old.range[1]);
    if (Buffer.byteLength(updated) > MAX_FILE) throw new PolicyError('配置文件超过 1 MiB 上限');
    try {
      const next = validateConfig(document(updated).toJS({ maxAliasCount: 0 }));
      reloadPolicies(this.reloader.current, next);
    } catch (error) { throw new PolicyError(error instanceof Error ? error.message : '配置全量校验失败'); }

    // No await in the transaction: requests, watchers and signals cannot interleave it.
    const temporary = join(dirname(this.path), `.webui-${randomUUID()}.tmp`);
    let replaced = false;
    try {
      const mode = fs.statSync(this.path).mode & 0o777;
      fs.writeFileSync(temporary, updated, { flag: 'wx', mode });
      fs.renameSync(temporary, this.path); replaced = true;
      if (!this.reloader.reload()) {
        throw new PolicyError(this.reloader.lastResult?.reason ?? '策略重载失败，保留旧策略');
      }
      return { ok: true, reload: this.reloader.lastResult! };
    } catch (error) {
      if (replaced) {
        try { fs.writeFileSync(temporary, original, { flag: 'wx', mode: fs.statSync(this.path).mode & 0o777 }); fs.renameSync(temporary, this.path); }
        catch { throw new PolicyError('策略重载及文件恢复失败，请检查文件系统；内存保留旧策略'); }
      }
      if (error instanceof PolicyError) throw error;
      throw new PolicyError('配置文件写入失败，请检查目录写入权限及原子替换支持');
    } finally { try { fs.unlinkSync(temporary); } catch { /* No temporary file remains after rename. */ } }
  }
}
