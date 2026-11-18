/** Types so the host compiles when the frida package is not installed. Not a runtime. */
declare module 'frida' {
  export interface Device {
    spawn(argv: string[]): Promise<number>;
    resume(pid: number): Promise<void>;
    getProcess(name: string): Promise<{ pid: number }>;
    attach(pid: number): Promise<Session>;
  }
  export interface Session {
    createScript(source: string, options?: unknown): Promise<Script>;
    detach(): Promise<void>;
  }
  export interface Script {
    message: { connect(cb: (message: any, data: Buffer | null) => void): void };
    load(): Promise<void>;
    exports: ScriptExports;
    unload(): Promise<void>;
  }
  export type ScriptExports = Record<string, unknown>;
  export interface SendMessage { type: 'send'; payload: unknown; }
  export interface ErrorMessage { type: 'error'; description?: string; stack?: string; }
  export const ScriptRuntime: { QJS: string };
  export function getLocalDevice(): Promise<Device>;
  export function getUsbDevice(): Promise<Device>;
  export function getRemoteDevice(): Promise<Device>;
}
