import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type ManagedProcess = {
  name: string;
  child: ChildProcessWithoutNullStreams;
  output: string[];
};

export type LocalUiStackOptions = {
  frontendPort: number;
  nodePorts: [number] | [number, number];
  workerMode: 'in-process' | 'worker';
  operationsToken?: string;
};

export type LocalUiStack = {
  frontendBaseUrl: string;
  nodeUrls: string[];
  nodeAUrl: string;
  nodeBUrl?: string;
  operationsToken: string;
  stop: () => Promise<void>;
};

export async function startLocalUiStack(options: LocalUiStackOptions): Promise<LocalUiStack> {
  const repoRoot = process.cwd();
  const nodeBin = resolveNode22Binary();
  const frontendBaseUrl = `http://127.0.0.1:${options.frontendPort}`;
  const nodeUrls = options.nodePorts.map((port) => `http://127.0.0.1:${port}`);
  const operationsToken = options.operationsToken ?? 'u2a-local-operations-token';
  const managed: ManagedProcess[] = [];

  try {
    for (const [index, port] of options.nodePorts.entries()) {
      const nodeId = index === 0 ? 'u2a-node-a' : 'u2a-node-b';
      const hostCandidateStart = 46000 + index * 50;
      const processHandle = spawnManagedProcess({
        name: `backend-${nodeId}`,
        command: nodeBin,
        args: ['dist/main.js'],
        cwd: path.join(repoRoot, 'apps/backend'),
        env: {
          ...process.env,
          NODE_ENV: 'development',
          PORT: String(port),
          PUBLIC_URL: nodeUrls[index]!,
          NODE_PUBLIC_URL: nodeUrls[index]!,
          FRONTEND_URL: frontendBaseUrl,
          CORS_ALLOWED_ORIGINS: frontendBaseUrl,
          NODE_ID: nodeId,
          NODE_REGION: 'local',
          NODE_ZONE: index === 0 ? 'local-a' : 'local-b',
          MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/native_sfu',
          REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
          REDIS_REQUIRED: 'true',
          OPERATIONS_TOKEN: operationsToken,
          ENABLE_PIPE_TRANSPORT: 'false',
          MEDIA_WORKER_MODE: options.workerMode,
          MEDIA_WORKER_COUNT: '1',
          HOST_CANDIDATE_PORT_RANGE: `${hostCandidateStart}-${hostCandidateStart + 49}`,
          PIPE_PORT_RANGE: `${47000 + index * 50}-${47049 + index * 50}`,
          TURN_URIS: 'turn:127.0.0.1:3478?transport=udp'
        }
      });
      managed.push(processHandle);
    }

    const frontend = spawnManagedProcess({
      name: 'frontend-dev-server',
      command: nodeBin,
      args: ['../../node_modules/@angular/cli/bin/ng.js', 'serve', '--host', '127.0.0.1', '--port', String(options.frontendPort)],
      cwd: path.join(repoRoot, 'apps/frontend'),
      env: {
        ...process.env,
        SFU_BACKEND_ORIGIN: nodeUrls[0]!
      }
    });
    managed.push(frontend);

    await Promise.all(nodeUrls.map((url) => waitForHttpOk(`${url}/health/live`, managed)));
    await runManagedCommand({
      name: 'seed-dummy-users',
      command: nodeBin,
      args: ['dist/database/seed-dummy-users.js'],
      cwd: path.join(repoRoot, 'apps/backend'),
      env: {
        ...process.env,
        MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/native_sfu',
        SEED_USER_PASSWORD: 'Password@12345'
      }
    });
    await waitForHttpOk(`${frontendBaseUrl}/sfu-forms`, managed, 90_000);

    return {
      frontendBaseUrl,
      nodeUrls,
      nodeAUrl: nodeUrls[0]!,
      nodeBUrl: nodeUrls[1],
      operationsToken,
      stop: async () => {
        for (const processHandle of managed.reverse()) {
          await stopManagedProcess(processHandle);
        }
      }
    };
  } catch (error) {
    for (const processHandle of managed.reverse()) {
      await stopManagedProcess(processHandle);
    }
    const details = managed
      .map((processHandle) => formatProcessOutput(processHandle))
      .filter((entry) => entry.length > 0)
      .join('\n\n');
    throw new Error(
      `Unable to start local browser validation stack: ${error instanceof Error ? error.message : String(error)}${details ? `\n\n${details}` : ''}`
    );
  }
}

export function runtimeUrl(frontendBaseUrl: string, nodeUrl: string, pathName = '/sfu-forms'): string {
  const url = new URL(pathName, `${frontendBaseUrl}/`);
  url.searchParams.set('apiBaseUrl', `${nodeUrl}/api/v1`);
  url.searchParams.set('socketUrl', `${nodeUrl}/sfu`);
  return url.toString();
}

function resolveNode22Binary(): string {
  const explicit = process.env.SFU_NODE_BIN?.trim();
  if (explicit) {
    return explicit;
  }

  if (process.version.startsWith('v22.')) {
    return process.execPath;
  }

  const versionsRoot = path.join(os.homedir(), '.nvm/versions/node');
  const preferred = path.join(versionsRoot, 'v22.22.3/bin/node');
  if (existsSync(preferred)) {
    return preferred;
  }

  throw new Error('Node 22.22.3 is required for the local Angular browser harness. Set SFU_NODE_BIN to a Node 22 binary.');
}

function spawnManagedProcess(options: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ManagedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output: string[] = [];
  const append = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed) {
      output.push(trimmed);
      if (output.length > 200) {
        output.shift();
      }
    }
  };

  child.stdout.on('data', (chunk) => append(String(chunk)));
  child.stderr.on('data', (chunk) => append(String(chunk)));

  return {
    name: options.name,
    child,
    output
  };
}

async function runManagedCommand(options: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const processHandle = spawnManagedProcess(options);
  const exitCode = await new Promise<number>((resolve, reject) => {
    processHandle.child.once('error', reject);
    processHandle.child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`${options.name} failed with exit code ${exitCode}\n${formatProcessOutput(processHandle)}`);
  }
}

async function waitForHttpOk(url: string, managed: ManagedProcess[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exited = managed.find((processHandle) => processHandle.child.exitCode !== null);
    if (exited) {
      throw new Error(`${exited.name} exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the deadline expires.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopManagedProcess(processHandle: ManagedProcess): Promise<void> {
  if (processHandle.child.exitCode !== null) {
    return;
  }
  processHandle.child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (processHandle.child.exitCode === null && Date.now() < deadline) {
    await delay(200);
  }
  if (processHandle.child.exitCode === null) {
    processHandle.child.kill('SIGKILL');
  }
}

function formatProcessOutput(processHandle: ManagedProcess): string {
  if (processHandle.output.length === 0) {
    return '';
  }
  return `[${processHandle.name}]\n${processHandle.output.slice(-25).join('\n')}`;
}
