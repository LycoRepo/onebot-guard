import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/load.ts';
import { PolicyReloader } from './config/reload.ts';
import { Observability } from './observability/index.ts';
import { Gateway } from './route/index.ts';
import { WebUI } from './webui/index.ts';
import { redactor } from './webui/security.ts';

export async function startGateway(path: string, env: NodeJS.ProcessEnv = process.env, write?: (line: string) => void, restart?: () => void): Promise<{
  gateway: Gateway; observation: Observability; reloader: PolicyReloader; webui: WebUI; stop(): Promise<void>;
}> {
  const config = loadConfig(path);
  const observation = new Observability(config, write);
  const gateway = new Gateway(config, observation, env);
  const reloader = new PolicyReloader(path, config, next => gateway.replacePolicies(next.policies), (success, reason) => {
    observation.log(success ? 'info' : 'error', success ? 'policy_reload_success' : 'policy_reload_failure', { reason });
    if (observation.events.capacity) observation.events.publish({ time: new Date().toISOString(), event: 'reload', ok: success, reason });
  }, redactor(config, env));
  const webui = new WebUI(config, () => gateway.snapshot(), observation, reloader, path, env, Date.now, restart);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopping) {
      reloader.stop();
      stopping = (async () => { await webui.stop(); await gateway.stop(); await observation.stop(); observation.log('info', 'gateway_stopped'); })();
    }
    return stopping;
  };
  try { await gateway.start(); await observation.start(() => gateway.snapshot()); await webui.start(); reloader.start(); }
  catch (error) { await stop(); throw error; }
  observation.log('info', 'gateway_started');
  return { gateway, observation, reloader, webui, stop };
}

export function installSignals(app: Awaited<ReturnType<typeof startGateway>>): () => void {
  const reload = (): void => { app.reloader.reload(); };
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return; stopping = true;
    app.stop().catch(() => { process.exitCode = 1; }).finally(uninstall);
  };
  const uninstall = (): void => {
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    if (process.platform !== 'win32') process.off('SIGHUP', reload);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  if (process.platform !== 'win32') process.on('SIGHUP', reload);
  return uninstall;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await startGateway(resolve(process.env.GATEWAY_CONFIG ?? 'config/gateway.yaml'), process.env, undefined, () => {
      void app.stop().then(() => process.exit(0), () => process.exit(1));
    });
    installSignals(app);
  } catch (error) {
    // Config/credential diagnostics never include packets, tokens, or filesystem paths.
    process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level: 'error', event: 'startup_failed', reason: error instanceof Error ? error.message.slice(0, 512) : '启动失败' }) + '\n');
    process.exitCode = 1;
  }
}
