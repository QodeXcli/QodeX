/**
 * Workflows — record a browser task once (agent or human demonstration), save it
 * as a parameterized JSON workflow + a discoverable skill, replay it later with
 * self-healing targets and Sentinel checks.
 *
 * Integration surface:
 *   - WORKFLOW_TOOL_CLASSES  → register in the tool registry (`new C()` each)
 *   - buildWorkflowCommand() → `program.addCommand(buildWorkflowCommand())`
 *   - setWorkflowGuard / setWorkflowSecretFiller → explicit wiring of the guard /
 *     the vault (defaults: Sentinel — fail closed — and the vault's
 *     browser_fill_secret)
 */

export * from './types.js';
export {
  WorkflowStore,
  WorkflowError,
  validateWorkflow,
  requiredParams,
  summarize,
  getWorkflowsDir,
  setWorkflowsDirForTests,
  type ValidationResult,
} from './store.js';
export {
  WorkflowRecorder,
  getWorkflowRecorder,
  getActiveRecording,
  buildWorkflowFromRecords,
  selectRecords,
  canonicalAction,
  captureScript,
  captureToRecord,
  captureTag,
  parameterizeUrl,
  targetKey,
  CAPTURE_BINDING,
  type RawRecord,
  type BuildMeta,
  type StartRecordingOptions,
  type RecordingStatus,
} from './recorder.js';
export {
  runWorkflow,
  resolveParams,
  substituteStep,
  normalizeParamInput,
  formatReplayReport,
  setWorkflowGuard,
  setWorkflowSecretFiller,
  resolveDefaultGuard,
  resolveDefaultSecretFiller,
  resolveDefaultFence,
  localFence,
  isForbiddenUpload,
  isFragileSelector,
  type Fence,
  type ReplayOptions,
  type ReplayReport,
  type ReplayStepResult,
  type ReplayStepEvent,
  type SecretFiller,
  type ParamInput,
  type ResolvedParams,
} from './replay.js';
export {
  buildWorkflowSkillMarkdown,
  writeWorkflowSkill,
  removeWorkflowSkill,
  deriveTriggers,
  workflowInjectionFindings,
  workflowSkillName,
  getWorkflowSkillsDir,
  setWorkflowSkillsDirForTests,
  WORKFLOW_SKILL_TOOLS,
  type SkillWriteResult,
} from './skillgen.js';
export {
  WorkflowRecordTool,
  WorkflowListTool,
  WorkflowShowTool,
  WorkflowRunTool,
  WORKFLOW_TOOL_CLASSES,
  renderWorkflowList,
  renderWorkflowDetail,
} from './tools.js';
export { buildWorkflowCommand } from './command.js';
