import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export const credentials = { username: 'test-owner', password: '123' };
export async function startServer(directory) {
  const dataDir = directory || await mkdtemp(join(tmpdir(), 'shanwei-test-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { ...process.env, APP_USERNAME: credentials.username, APP_PASSWORD: credentials.password, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, PUBLIC_URL: '', CERT_FILE: '', KEY_FILE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', data => { logs += data; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Server startup timeout: ${logs}`)); }, 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exit ${code}: ${logs}`)); });
    child.stdout.on('data', data => { const match = data.toString().match(/http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timeout); resolve(`http://localhost:${match[1]}`); } });
  });
  return { url, dataDir, async stop(remove = !directory) {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if (remove) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } };
}
export async function client(server) {
  let cookie = '';
  const request = async (path, method = 'GET', body, extra = {}) => {
    const res = await fetch(`${server.url}/api${path}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-App-Request': '1', Origin: server.url, Cookie: cookie, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    const value = res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, value, headers: res.headers };
  };
  return request;
}
