/**
 * Public surface of the control layer: the process event bus, the approval broker
 * (foundation contracts) and the Control Center web UI built on top of them.
 *
 *   import { startControlCenter, registerControlAction, getApprovalBroker } from './control/index.js';
 *
 * The `qodex control` CLI builder lives in ./command.js (it pulls in commander and
 * the config loader, so it is not re-exported here).
 */

export * from './bus.js';
export * from './approvals.js';
export {
  startControlCenter,
  stopControlCenter,
  getControlCenter,
  describeControlCenter,
  agentEventToBus,
  publishAgentEvent,
  maskSecrets,
  registerControlAction,
  listControlActions,
  runControlAction,
  setTunnelStarterForTests,
  validateHumanInput,
  normalizeNavigateUrl,
  authenticateRequest,
  originAllowed,
  stripTokenFromUrl,
  controlCookieName,
  tokenMatches,
  MAX_BODY_BYTES,
  type ControlCenterOptions,
  type ControlCenterInfo,
  type ControlActionHandler,
  type SteerHandler,
  type ControlAuth,
} from './server.js';
export { renderDashboard, DASHBOARD_STRINGS, type DashboardLang, type DashboardOptions } from './dashboard.js';
