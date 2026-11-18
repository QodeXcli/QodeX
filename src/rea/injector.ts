/**
 * Frida-based process injector — the host-side half of REA.
 *
 * Loads a compiled TypeScript agent bundle (built with frida-compile from
 * `src/rea/agent/`) into a target process, over a local, USB, or remote
 * Frida device, and exposes the agent's RPC exports plus a telemetry stream
 * for everything the agent `send()`s back (keys, plaintext buffers, logs).
 *
 * Runs on the user's own machine (or a device they attached) against a
 * process they own or have explicit permission to instrument. The native
 * Frida binding must be present (`frida` package); without it the import
 * fails at runtime and the constructor throws a clear error.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as frida from 'frida';

const execFileAsync = promisify(execFile);

export type DeviceKind = 'local' | 'usb' | 'remote';

export interface InjectionOptions {
  deviceType: DeviceKind;
  /** Process name (e.g. "Safari") or pid. */
  targetProcess: string | number;
  /** True: spawn the program suspended, instrument, then resume. */
  spawnMode: boolean;
  /** Compiled agent bundle (frida-compile output, .js). */
  agentBundlePath: string;
  /** Called for every telemetry message the agent sends back. */
  onTelemetry?: (payload: unknown, data: Buffer | null) => void;
  /** Name shown for the injected script in Frida tooling. */
  scriptName?: string;
}

export interface TelemetryEntry {
  payload: unknown;
  dataLength: number;
  receivedAt: Date;
}

export class ProcessInjector {
  private device: frida.Device | null = null;
  private session: frida.Session | null = null;
  private script: frida.Script | null = null;
  private spawnedPid: number | null = null;
  private readonly telemetryLog: TelemetryEntry[] = [];

  /** Everything the agent sent back, in arrival order. */
  public get telemetry(): readonly TelemetryEntry[] {
    return this.telemetryLog;
  }

  public get pid(): number | null {
    return this.spawnedPid;
  }

  public async inject(options: InjectionOptions): Promise<frida.ScriptExports> {
    this.device = await this.resolveDevice(options.deviceType);

    let pid: number;
    if (options.spawnMode && typeof options.targetProcess === 'string') {
      // Spawn suspended so hooks land before the entry point runs.
      pid = await this.device.spawn([options.targetProcess]);
      this.spawnedPid = pid;
    } else if (typeof options.targetProcess === 'number') {
      pid = options.targetProcess;
    } else {
      const proc = await this.device.getProcess(options.targetProcess);
      pid = proc.pid;
    }

    this.session = await this.device.attach(pid);

    const agentSource = await fs.readFile(options.agentBundlePath, 'utf8');
    this.script = await this.session.createScript(agentSource, {
      name: options.scriptName ?? 'qodex-rea-agent',
      runtime: frida.ScriptRuntime.QJS,
    });

    this.script.message.connect((message, data) => {
      if (message.type === 'send') {
        const payload = (message as frida.SendMessage).payload;
        this.telemetryLog.push({
          payload,
          dataLength: data?.byteLength ?? 0,
          receivedAt: new Date(),
        });
        options.onTelemetry?.(payload, data);
      } else if (message.type === 'error') {
        const err = message as frida.ErrorMessage;
        const payload = { type: 'AGENT_ERROR', message: err.description, stack: err.stack };
        this.telemetryLog.push({ payload, dataLength: 0, receivedAt: new Date() });
        options.onTelemetry?.(payload, null);
      }
    });

    await this.script.load();

    if (options.spawnMode && this.spawnedPid !== null) {
      await this.device.resume(this.spawnedPid);
    }

    return this.script.exports;
  }

  /** Unload the agent script and detach from the process. */
  public async detach(): Promise<void> {
    if (this.script) {
      try {
        await this.script.unload();
      } catch {
        // Already gone (target exited, or detach raced the unload).
      }
      this.script = null;
    }
    if (this.session) {
      try {
        await this.session.detach();
      } catch {
        // Session already detached.
      }
      this.session = null;
    }
    this.spawnedPid = null;
  }

  private async resolveDevice(kind: DeviceKind): Promise<frida.Device> {
    switch (kind) {
      case 'local':
        return frida.getLocalDevice();
      case 'usb':
        return frida.getUsbDevice();
      case 'remote':
        return frida.getRemoteDevice();
    }
  }
}

export interface AgentBuildOptions {
  /** TypeScript entry (e.g. src/rea/agent/index.ts). */
  entry: string;
  /** Output bundle path (e.g. dist/rea-agent.js). */
  out: string;
  /** Explicit frida-compile binary; defaults to the one on PATH. */
  compilerBinary?: string;
}

/**
 * Compile a TypeScript agent entry into a single JS bundle the injector can
 * load, using frida-compile. The agent entry must only use GumJS globals
 * (Module, Interceptor, send, Java, ObjC, ...) — no Node.js APIs.
 */
export async function buildAgentBundle(options: AgentBuildOptions): Promise<string> {
  const binary = options.compilerBinary ?? 'frida-compile';
  const outDir = path.dirname(path.resolve(options.out));
  await fs.mkdir(outDir, { recursive: true });
  await execFileAsync(binary, [options.entry, '-o', options.out], {
    timeout: 120_000,
  });
  return options.out;
}
