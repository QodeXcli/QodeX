/**
 * Workflows — record a browser task once (agent or human demonstration), save it
 * as a parameterized JSON workflow + a discoverable skill, replay it later with
 * self-healing targets and Sentinel checks.
 *
 * Integration surface:
 *   - WORKFLOW_TOOL_CLASSES  → register in the tool registry (`new C()` each)
 *   - buildWorkflowCommand() → `program.addCommand(buildWorkflowCommand())`
 *   - setWorkflowGuard / setWorkflowSecretFiller → optional explicit wiring of
 *     Sentinel / the vault (both are auto-detected when those modules exist)
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
