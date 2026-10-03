/**
 * Dedicated QodeX Browser — public surface for the integration step.
 *
 * `BROWSER_TOOL_CLASSES` lists every `browser_*` tool class (the original nine
 * plus the extended set and the autonomous `browser_agent`), so the registry can
 * register them with `BROWSER_TOOL_CLASSES.map(C => new C())`. Importing this
 * module also registers the QodexBrowserManager factory (via session.ts).
 */

import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserFillTool,
  BrowserScreenshotTool,
  BrowserConsoleTool,
  BrowserEvaluateTool,
  BrowserGetTextTool,
  BrowserWaitForTool,
  BrowserCloseTool,
} from './tools.js';
import {
  BrowserSnapshotTool,
  BrowserTypeTool,
  BrowserFillFormTool,
  BrowserSelectTool,
  BrowserHoverTool,
  BrowserPressTool,
  BrowserScrollTool,
  BrowserDragTool,
  BrowserUploadTool,
  BrowserHistoryTool,
  BrowserTabsTool,
  BrowserExtractTool,
  BrowserNetworkTool,
  BrowserDownloadsTool,
  BrowserDialogTool,
  BrowserPdfTool,
  BrowserStatusTool,
} from './tools-extra.js';
import { BrowserAgentTool } from './agent-tool.js';

export const BROWSER_TOOL_CLASSES = [
  // original set (names unchanged)
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserFillTool,
  BrowserScreenshotTool,
  BrowserConsoleTool,
  BrowserEvaluateTool,
  BrowserGetTextTool,
  BrowserWaitForTool,
  BrowserCloseTool,
  // extended set
  BrowserSnapshotTool,
  BrowserTypeTool,
  BrowserFillFormTool,
  BrowserSelectTool,
  BrowserHoverTool,
  BrowserPressTool,
  BrowserScrollTool,
  BrowserDragTool,
  BrowserUploadTool,
  BrowserHistoryTool,
  BrowserTabsTool,
  BrowserExtractTool,
  BrowserNetworkTool,
  BrowserDownloadsTool,
  BrowserDialogTool,
  BrowserPdfTool,
  BrowserStatusTool,
  // autonomous sub-agent
  BrowserAgentTool,
] as const;

export {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserFillTool,
  BrowserScreenshotTool,
  BrowserConsoleTool,
  BrowserEvaluateTool,
  BrowserGetTextTool,
  BrowserWaitForTool,
  BrowserCloseTool,
  BrowserSnapshotTool,
  BrowserTypeTool,
  BrowserFillFormTool,
  BrowserSelectTool,
  BrowserHoverTool,
  BrowserPressTool,
  BrowserScrollTool,
  BrowserDragTool,
  BrowserUploadTool,
  BrowserHistoryTool,
  BrowserTabsTool,
  BrowserExtractTool,
  BrowserNetworkTool,
  BrowserDownloadsTool,
  BrowserDialogTool,
  BrowserPdfTool,
  BrowserStatusTool,
  BrowserAgentTool,
};
export {
  QodexBrowserManager, getSession, closeBrowser, isPlaywrightAvailable, normalizeUrl, normalizeKey,
  refFromSelector, isSecretElement, redactTypedArgs, isProtectedQodexPath, isProtectedFileUrl, redactCdpUrl,
} from './session.js';
export type { QodexBrowserManagerOptions, QodexBrowserStatus, DownloadEntry, DialogEntry } from './session.js';
export { resolveBrowserExecutable } from './launcher.js';
export type { ResolvedExecutable, LauncherDeps } from './launcher.js';
export {
  takeSnapshot, takeSnapshotDetailed, snapshotWithBoxes, extractContent, filterInteractive, truncateSnapshot,
  maskSecretValues, maskSecretText, collectSecretValues,
} from './snapshot.js';
export { buildBrowserCommand } from './command.js';
export { buildBrowserAgentPrompt } from './agent-tool.js';
export { getBrowserManager, peekBrowserManager, setBrowserManagerForTests } from './types.js';
export type { BrowserManager, BrowserStatus, TabInfo, ElementInfo, BrowserActionRecord, HumanInputEvent, ScreencastFrame } from './types.js';
