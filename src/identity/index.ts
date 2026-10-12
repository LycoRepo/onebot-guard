import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Packet } from '../protocol/onebot11/index.ts';
import { id } from '../protocol/onebot11/index.ts';
export interface Session { generation: string; endpoint: string; account?: string; principal?: string }
export function credential(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`环境变量 ${name} 未设置或为空`);
  return value;
}
export function authenticated(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function newSession(endpoint: string): Session { return { endpoint, generation: randomUUID() }; }
export function boundAccount(packet: Packet, account: string): boolean { return id(packet.self_id) === account; }
