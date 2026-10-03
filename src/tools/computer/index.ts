/**
 * Desktop control (computer_use_*) — public surface.
 *
 * `COMPUTER_TOOL_CLASSES` lists every desktop tool class; the registry
 * instantiates them (`...COMPUTER_TOOL_CLASSES.map(T => new T())`). All names
 * keep the `computer_use_` prefix so relevance gating, tool display, the
 * /tools categories and the 'computer' sub-agent role pick them up.
 */

import {
  ComputerUseScreenshotTool,
  ComputerUseClickTool,
  ComputerUseTypeTool,
  ComputerUseKeyTool,
  ComputerUseActiveWindowTool,
  ComputerUseListWindowsTool,
  ComputerUseMoveTool,
  ComputerUseDragTool,
  ComputerUseScrollTool,
  ComputerUseClipboardTool,
  ComputerUseOpenTool,
  ComputerUseScreenInfoTool,
  ComputerUseFocusWindowTool,
} from './use.js';
import { ComputerUseLocateTool } from './locate.js';
import { ComputerUseAgentTool } from './agent-tool.js';
import type { ToolContext } from '../base.js';

export const COMPUTER_TOOL_CLASSES = [
  ComputerUseScreenshotTool,
  ComputerUseClickTool,
  ComputerUseTypeTool,
  ComputerUseKeyTool,
  ComputerUseActiveWindowTool,
  ComputerUseListWindowsTool,
  ComputerUseMoveTool,
  ComputerUseDragTool,
  ComputerUseScrollTool,
  ComputerUseClipboardTool,
  ComputerUseOpenTool,
  ComputerUseScreenInfoTool,
  ComputerUseFocusWindowTool,
  ComputerUseLocateTool,
  ComputerUseAgentTool,
] as const;

/** Every computer_use_* tool name (for allowlists, docs and tests). */
export const COMPUTER_TOOL_NAMES: string[] = COMPUTER_TOOL_CLASSES.map(T => new T().name);

/**
 * Human-readable desktop-control status (backend, screen, capabilities, or the
 * exact missing binaries + install command) — for a `/desktop` slash command or
 * `qodex doctor`. Never throws.
 */
export async function desktopStatusText(cwd: string = process.cwd()): Promise<string> {
  const ctx = {
    cwd,
    sessionId: 'desktop-status',
    transaction: {} as ToolContext['transaction'],
    permissions: {} as ToolContext['permissions'],
    askUser: async () => 'no',
    emit: () => {},
  } as ToolContext;
  try {
    const r = await new ComputerUseScreenInfoTool().execute({}, ctx);
    return r.content;
  } catch (e: any) {
    return `[COMPUTER_USE_ERROR] ${e?.message ?? e}`;
  }
}

export {
  ComputerUseScreenshotTool,
  ComputerUseClickTool,
  ComputerUseTypeTool,
  ComputerUseKeyTool,
  ComputerUseActiveWindowTool,
  ComputerUseListWindowsTool,
  ComputerUseMoveTool,
  ComputerUseDragTool,
  ComputerUseScrollTool,
  ComputerUseClipboardTool,
  ComputerUseOpenTool,
  ComputerUseScreenInfoTool,
  ComputerUseFocusWindowTool,
  ComputerUseLocateTool,
  ComputerUseAgentTool,
};
export { openDesktop, runDesktopTool, desktopErrorResult, unavailableMessage, formatWindow } from './use.js';
export { parseLocateResponse, buildLocatePrompt, setLocateAnalyzer, type LocateAnalyzer, type LocateBox } from './locate.js';
export { buildComputerAgentPrompt, DEFAULT_COMPUTER_AGENT_STEPS } from './agent-tool.js';
export {
  selectBackendName,
  createDesktopBackend,
  getDesktopBackend,
  setDesktopBackendForTests,
  setDesktopScreenshotsDir,
  getLastCapture,
  resetDesktopState,
  toScreenPoint,
  type DesktopBackend,
  type DesktopBackendName,
  type BackendAvailability,
  type WindowInfo,
} from './backends/index.js';
export { setDesktopExec, runCommand, which, type DesktopExecFake, type ExecResult } from './exec.js';
