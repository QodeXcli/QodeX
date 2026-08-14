/**
 * Execution runtime — where the agent's shell actually runs.
 *
 * OperatorHub multiplexes operator I/O. Git sandbox isolates branches.
 * This layer isolates the PROCESS: local (today's bare metal) or docker
 * (project bind-mounted, host $HOME / docker.sock not visible).
 */

export type RuntimeBackend = 'local' | 'docker';

export interface ExecRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  backend: RuntimeBackend;
  /** Set when the chosen backend cannot start (docker CLI missing, etc.). */
  unavailable?: string;
}

export interface ExecutionRuntime {
  readonly backend: RuntimeBackend;
  exec(req: ExecRequest): Promise<ExecResult>;
}

export interface DockerRuntimeConfig {
  image: string;
  network?: 'none' | 'bridge';
  memory?: string;
  cpus?: string;
  workdir?: string;
  user?: string;
}

export interface RuntimeConfig {
  backend?: RuntimeBackend;
  docker?: Partial<DockerRuntimeConfig>;
}
