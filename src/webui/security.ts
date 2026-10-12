import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config/types.ts';

export function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}

export function redactor(config: Config, env: NodeJS.ProcessEnv): (text: string) => string {
  const names = [config.webui.read_token_env, config.webui.write_token_env,
    ...Object.values(config.endpoints).flatMap(e => [e.token_env, e.tls?.cert_env, e.tls?.key_env])];
  const values = [...new Set(names.flatMap(name => name && env[name] ? [env[name]!] : []))]
    .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]).sort((a, b) => b.length - a.length);
  return text => { for (const value of values) text = text.split(value).join('[REDACTED]'); return text; };
}
