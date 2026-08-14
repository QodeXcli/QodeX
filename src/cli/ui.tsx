/*
 * QodeX — Local-first agentic coding CLI
 * Copyright 2026 7 SEVEN
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { ChatInput } from './components/chat-input.js';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { parseSteerInput } from '../agent/steering.js';
import type { ModelRouter } from '../llm/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionEngine } from '../security/permissions.js';
import {
  type ApprovalMode,
  getApprovalMode,
  cycleApprovalMode,
  setApprovalMode as setApprovalModeGlobal,
  APPROVAL_MODE_META,
} from '../security/permissions.js';
import type { QodexConfig } from '../config/defaults.js';
import type { Message } from '../session/store.js';
import { getSessionStore } from '../session/store.js';
import { messagesToHistory } from './resume-transcript.js';
import { stripThinkingForDisplay, stripLeakedToolTags } from '../llm/thinking.js';
import { isRedundantAssistantText, dedupeSelfRepeatedText } from './modes/final-dedupe.js';
import { DiffViewer } from './prompts/diff-viewer.js';
import { Confirmation } from './prompts/confirmation.js';
import { AssistantMessage, StreamingView } from './render/assistant-message.js';
import { tailForViewport, didShrink, CLEAR_SCREEN, formatContextMeter } from './viewport.js';
import { summarizeToolResult } from './render/tool-summary.js';
import { handleSlashCommand } from './slash-commands.js';
import { slashAliasMap } from '../skills/registry.js';
import { annotateImagePrompt } from '../utils/image-paths.js';
import { Welcome } from './prompts/welcome.js';
import { BootSplash } from './prompts/boot-splash.js';
import { GradientText, AURORA, useShimmer } from './prompts/gradient.js';
import { describeToolActivity, extractTarget, formatTarget } from './prompts/tool-display.js';
import { getOperatorHub } from '../operator/hub.js';
import { pickWorkingCwd } from '../session/handoff.js';
import { getActiveProfile } from '../config/profile.js';
import { SideRunDock } from './prompts/side-run-dock.js';
import {
  appendLaneLine,
  applyRunToLanes,
  markLanesRead,
  type Lane,
} from '../operator/live-lanes.js';

type HistoryItem =
  | { type: 'user'; text: string; id: string }
  | { type: 'assistant'; text: string; id: string }
  | { type: 'tool'; name: string; result: string; isError?: boolean; id: string }
  | { type: 'system'; text: string; id: string }
  | { type: 'error'; text: string; id: string };

interface PendingPrompt {
  prompt: string;
  options: string[];
  resolve: (answer: string) => void;
  diff?: { path: string; before: string | null; after: string };
  hubId?: string;
}

export interface AppProps {
  cwd: string;
  config: QodexConfig;
  router: ModelRouter;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  initialPrompt?: string;
  resumeSessionId?: string;
  /** Model id from the `--model` CLI flag. Overrides config.defaults.model for the
   *  whole interactive session (until changed with /model). */
  explicitModel?: string;
  /** Reports the active session id (and any time it changes) so the caller can print
   *  a resume hint on exit. */
  onSessionActive?: (id: string) => void;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  // Pre-compute resumed-session metadata for the welcome banner
  const resumedMeta = (() => {
    if (!props.resumeSessionId) return undefined;
    try {
      const loaded = getSessionStore().loadSession(props.resumeSessionId);
      if (loaded) return { id: props.resumeSessionId, turnCount: loaded.meta.turn_count };
    } catch { /* ignore */ }
    return undefined;
  })();
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    // On resume, repaint the prior Q&A so the user sees the conversation they're
    // continuing — not a blank screen. (The model's context is rehydrated separately
    // via `messages` below; this is purely the on-screen transcript.)
    if (props.resumeSessionId) {
      try {
        const loaded = getSessionStore().loadSession(props.resumeSessionId);
        if (loaded) return messagesToHistory(loaded.messages);
      } catch { /* ignore — fall back to empty */ }
    }
    return [];
  });
  const [input, setInput] = useState('');
  // Type-ahead queue: prompts the user submits while a turn is running. They run
  // one at a time as soon as the agent goes idle (drained by an effect below), so
  // the input box stays usable mid-task — like Claude Code's queued input.
  const [queued, setQueued] = useState<string[]>([]);
  // Bumped after each queued prompt finishes to re-trigger the drain effect even
  // when the prompt didn't flip `busy` (e.g. an instant slash command).
  const [drainTick, setDrainTick] = useState(0);
  const dispatchingRef = useRef(false);
  // Up/Down-arrow recall of previously submitted prompts (shell-style history),
  // consumed by ChatInput.
  const promptHistoryRef = useRef<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  // Hidden reasoning tokens (Ollama `message.thinking` / LM Studio reasoning_content).
  // Count only — we don't dump the trace into the transcript, but we MUST show
  // that the model is working or the TUI looks frozen after a fast model load.
  const [thinkingChars, setThinkingChars] = useState(0);
  const [liveShell, setLiveShell] = useState<string[]>([]);
  const liveShellRef = useRef<string[]>([]);
  const liveShellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const lanesRef = useRef<Lane[]>([]);
  const [dockOpen, setDockOpen] = useState(false);
  const dockOpenRef = useRef(false);
  const [activeTools, setActiveTools] = useState<Array<{ id: string; name: string; partialArgs: string }>>([]);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => {
    const store = getSessionStore();
    if (props.resumeSessionId) {
      const loaded = store.loadSession(props.resumeSessionId);
      if (loaded) return props.resumeSessionId;
    }
    return store.createSession(props.cwd, props.config.defaults.model);
  });
  // Session cwd, not the host process. After --resume / switch_session / phone
  // handoff, tools must keep editing the project the transcript belongs to.
  const [activeCwd, setActiveCwd] = useState<string>(() => {
    if (props.resumeSessionId) {
      const loaded = getSessionStore().loadSession(props.resumeSessionId);
      return pickWorkingCwd({ sessionCwd: loaded?.meta.cwd, hostCwd: props.cwd });
    }
    return props.cwd;
  });
  const [messages, setMessages] = useState<Message[]>(() => {
    if (props.resumeSessionId) {
      const loaded = getSessionStore().loadSession(props.resumeSessionId);
      if (loaded) return loaded.messages;
    }
    return [];
  });
  const [mode, setMode] = useState<'normal' | 'plan'>('normal');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() => getApprovalMode());
  // Gates the main UI behind the animated boot splash. Flips to true when the splash
  // finishes (or immediately when motion is disabled / not a TTY).
  const [booted, setBooted] = useState(false);
  const [explicitModel, setExplicitModel] = useState<string | undefined>(props.explicitModel);
  const [budgetStatus, setBudgetStatus] = useState({ tokens: 0, costUsd: 0, contextTokens: 0, contextWindow: 0, providerName: '', providerIsLocal: true });
  // Live throughput + elapsed readout for the status bar. taskStartedAt marks when
  // the current task began (busy → true); nowTick is bumped by an interval while
  // busy so the readout refreshes; lastElapsedMs freezes the finished task's total
  // so it stays visible until the next task starts.
  const [taskStartedAt, setTaskStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [lastElapsedMs, setLastElapsedMs] = useState<number>(0);
  // The ticker goes QUIET while a permission prompt is open: each tick re-renders the
  // whole dynamic frame, and with a tall diff+confirmation on screen that 4Hz re-paint
  // reads as violent scroll-jumping. A ref (not an effect dep) keeps the timer and the
  // task's start time intact — the readout just freezes until the prompt resolves.
  const pendingPromptRef = useRef<unknown>(null);
  pendingPromptRef.current = pendingPrompt;
  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setTaskStartedAt(start);
    setNowTick(start);
    const iv = setInterval(() => { if (!pendingPromptRef.current) setNowTick(Date.now()); }, 250);
    return () => {
      clearInterval(iv);
      setLastElapsedMs(Date.now() - start);
      setTaskStartedAt(null);
    };
  }, [busy]);
  // Terminal width drives the full-width input box / status bar; track resizes live.
  const { stdout } = useStdout();
  const [cols, setCols] = useState<number>(stdout?.columns ?? 80);
  const [rows, setRows] = useState<number>(stdout?.rows ?? 24);
  // Bumped on a terminal SHRINK to force <Static> to remount and repaint history
  // cleanly (see the resize effect below).
  const [staticEpoch, setStaticEpoch] = useState(0);
  // Whether to run continuous animations (gradient shimmer, live activity). Off when
  // output isn't a TTY (piped) or the user opted out via QODEX_NO_MOTION=1.
  const motion = !!stdout?.isTTY && process.env.QODEX_NO_MOTION !== '1';
  const abortRef = useRef<AbortController | null>(null);
  // Exit guard: a stray Ctrl+C while idle shouldn't quit. The first press "arms" an
  // exit prompt; a second Ctrl+C within the window actually exits. Any other key (or
  // the timeout) disarms it. This mirrors what people expect from Claude Code et al.
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-session iteration cap override (set by /unlimited or /iterations). undefined = config default.
  const maxIterOverrideRef = useRef<number | undefined>(undefined);
  // Per-session reasoning effort (set by /effort). undefined = model default.
  const effortOverrideRef = useRef<'low' | 'medium' | 'high' | undefined>(undefined);
  const agentRef = useRef<AgentLoop | null>(null);
  const idCounterRef = useRef(0);
  const submittedFirstRef = useRef(false);
  const pendingDiffRef = useRef<{ path: string; before: string | null; after: string } | null>(null);
  // One-shot override for the next agent run. Custom slash commands set this so allowed-tools/
  // model/mode apply only for the command's invocation, then auto-reset.
  const nextRunOverrideRef = useRef<{
    allowedTools?: string[];
    model?: string;
    mode?: 'plan' | 'normal';
  } | null>(null);

  const nextId = useCallback(() => {
    idCounterRef.current++;
    return String(idCounterRef.current);
  }, []);

  // Throttle the live streaming region: setting state on every text_delta (one per
  // token) repaints the multi-line region dozens of times a second, which the user
  // sees as flicker/jitter. We coalesce bursts into at most one repaint per ~50ms.
  // The trailing pending text is intentionally discarded on clear — the FINAL text
  // commits to <Static> separately, so nothing is lost.
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamPendingRef = useRef<string | null>(null);
  const flushStreaming = useCallback(() => {
    streamTimerRef.current = null;
    if (streamPendingRef.current !== null) {
      setStreamingText(streamPendingRef.current);
      streamPendingRef.current = null;
    }
  }, []);
  const pushStreaming = useCallback((text: string) => {
    streamPendingRef.current = text;
    if (streamTimerRef.current === null) {
      streamTimerRef.current = setTimeout(flushStreaming, 50);
    }
  }, [flushStreaming]);
  const clearStreaming = useCallback(() => {
    if (streamTimerRef.current !== null) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamPendingRef.current = null;
    setStreamingText('');
  }, []);

  // Initialize agent
  useEffect(() => {
    const agent = new AgentLoop({
      router: props.router,
      registry: props.registry,
      permissions: props.permissions,
      config: props.config,
      cwd: activeCwd,
    });
    agentRef.current = agent;
    // Publish to singletons so slash commands and the task tool can find this agent
    // without taking it as a parameter through every call site.
    void import('../agent/loop.js').then(m => m.setActiveAgent(agent));
    void import('../tools/builtin/task.js').then(m => {
      m.setSubAgentRunner((prompt, opts) => agent.runSubagent(prompt, opts));
    });
    return () => {
      void import('../agent/loop.js').then(m => m.setActiveAgent(null));
      void import('../tools/builtin/task.js').then(m => m.setSubAgentRunner(null));
    };
  }, [props.router, props.registry, props.permissions, props.config, props.cwd]);

  // Keep the input box / status bar matched to the terminal width on resize, and
  // fix the shrink-duplication bug: when the terminal gets smaller, every already
  // printed line reflows to the narrower width, desyncing Ink's <Static> cursor math
  // so committed history reprints as a duplicate. On a shrink we clear the screen and
  // bump staticEpoch (which keys <Static>), forcing a single clean repaint. Growing
  // is harmless and left alone. Debounced so a drag-resize repaints once on settle,
  // not on every intermediate event.
  useEffect(() => {
    if (!stdout) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      const next = { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
      const shrank = didShrink({ cols, rows }, next);
      setCols(next.cols);
      setRows(next.rows);
      if (shrank) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          try { stdout.write(CLEAR_SCREEN); } catch { /* non-TTY */ }
          setStaticEpoch(e => e + 1); // remount <Static> → repaint history once, clean
        }, 120);
      }
    };
    stdout.on('resize', onResize);
    return () => { if (timer) clearTimeout(timer); stdout.off('resize', onResize); };
  }, [stdout, cols, rows]);

  // Auto-submit initial prompt — but only after the boot splash has handed off, so the
  // agent doesn't start working underneath the launch animation.
  useEffect(() => {
    if (!booted) return;
    if (props.initialPrompt && !submittedFirstRef.current && agentRef.current) {
      submittedFirstRef.current = true;
      void submitPrompt(props.initialPrompt);
    }
  }, [props.initialPrompt, booted]);

  // Ctrl+C handler
  useInput((_input, key) => {
    // Any keypress other than a confirming Ctrl+C disarms the exit prompt — so if you
    // armed it then went back to work, you won't quit on the next stray press.
    if (exitArmed && !(key.ctrl && _input === 'c')) {
      setExitArmed(false);
      if (exitTimer.current) { clearTimeout(exitTimer.current); exitTimer.current = null; }
    }

    // Ctrl+B toggles the side-run dock (background live stays out of the transcript).
    if (key.ctrl && _input === 'b') {
      setDockOpen(open => {
        const next = !open;
        dockOpenRef.current = next;
        if (next) {
          lanesRef.current = markLanesRead(lanesRef.current);
          setLanes(lanesRef.current);
        }
        return next;
      });
      return;
    }

    // Shift+Tab cycles approval: manual → auto → always yes → manual.
    // If a prompt is already on screen, auto-answer it when the new mode would
    // have skipped the ask (always yes; or auto + a file-edit diff).
    if ((key.tab && key.shift) || _input === '\u001b[Z') {
      const next = cycleApprovalMode();
      setApprovalMode(next);
      const meta = APPROVAL_MODE_META[next];
      setHistory(h => [...h, {
        type: 'system',
        text: `Approval: ${meta.label} — ${meta.hint}  (Shift+Tab to cycle)`,
        id: nextId(),
      }]);
      const pending = pendingPromptRef.current as PendingPrompt | null;
      if (pending) {
        const shouldAccept = next === 'always' || (next === 'auto' && !!pending.diff);
        const answer = shouldAccept ? pickAutoAnswer(pending.options) : null;
        if (answer) {
          setPendingPrompt(null);
          pending.resolve(answer);
        }
      }
      return;
    }

    // Interrupt a running turn with either Ctrl+C or Esc. Esc is what most
    // people reach for; Ctrl+C is the fallback. When idle, Ctrl+C asks first.
    if ((key.ctrl && _input === 'c') || key.escape) {
      if (busy && abortRef.current) {
        abortRef.current.abort();
        setHistory(h => [...h, { type: 'system', text: 'Stopped by user. You can type a new instruction now.', id: nextId() }]);
        return;
      }
      // Esc while idle with text in the box clears the draft (instead of nothing).
      if (key.escape && input) {
        setInput('');
        return;
      }
      if (key.ctrl && _input === 'c') {
        // Idle Ctrl+C: don't quit on a single (maybe accidental) press. Arm an exit
        // prompt; a second Ctrl+C within ~3s confirms. Any other key disarms (above).
        if (exitArmed) {
          if (exitTimer.current) { clearTimeout(exitTimer.current); exitTimer.current = null; }
          exit();
          return;
        }
        setExitArmed(true);
        if (exitTimer.current) clearTimeout(exitTimer.current);
        exitTimer.current = setTimeout(() => { setExitArmed(false); exitTimer.current = null; }, 3000);
        return;
      }
      // A lone Esc while idle does nothing (don't exit on a stray keypress).
    }
  });

  // Clear the exit-confirm timer if the component unmounts mid-window.
  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); }, []);

  // Surface the active session id so the launcher can print a resume hint on exit.
  useEffect(() => { props.onSessionActive?.(sessionId); }, [sessionId]);
  useEffect(() => {
    agentRef.current?.setWorkingDirectory(activeCwd);
  }, [activeCwd]);
  useEffect(() => {
    void import('../session/handoff.js').then(m => m.writeHandoff(sessionId, activeCwd));
  }, [sessionId, activeCwd]);

  useEffect(() => {
    let unsubSide = () => {};
    void import('../agent/side-runs.js').then(m => {
      unsubSide = m.onSideRunChange(run => {
        lanesRef.current = applyRunToLanes(lanesRef.current, run);
        setLanes(lanesRef.current);
        if (run.status === 'running') return;
        const preview = (run.result || run.error || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const icon = run.status === 'done' ? '✓' : run.status === 'cancelled' ? '■' : '✗';
        setHistory(h => [...h, {
          type: 'system',
          text: `${icon} Side run ${run.id} ${run.status}${preview ? ` — ${preview}` : ''}`,
          id: nextId(),
        }]);
      });
    });
    const hub = getOperatorHub();
    const unsubHub = hub.subscribe(ev => {
      if (ev.kind === 'approval') {
        const diff = pendingDiffRef.current ?? undefined;
        pendingDiffRef.current = null;
        const tag = ev.origin && ev.origin !== 'tui' ? ev.origin : ev.source;
        const label = tag === 'main' ? ev.prompt : `[${tag}] ${ev.prompt}`;
        setPendingPrompt(p => {
          // Another lane may be inflight (bot). Don't steal the TUI's open ask.
          if (p && p.hubId && p.hubId !== ev.id) return p;
          return {
            prompt: label,
            options: ev.options,
            hubId: ev.id,
            diff,
            resolve: (a) => { hub.answer(ev.id, a); },
          };
        });
      } else if (ev.kind === 'approval-cleared') {
        setPendingPrompt(p => (p?.hubId === ev.id ? null : p));
      } else if (ev.kind === 'live') {
        if (ev.source !== 'main') {
          lanesRef.current = appendLaneLine(
            lanesRef.current,
            ev.source,
            ev.stream,
            ev.line,
            { bumpUnread: !dockOpenRef.current },
          );
          if (liveShellTimer.current === null) {
            liveShellTimer.current = setTimeout(() => {
              liveShellTimer.current = null;
              setLiveShell(liveShellRef.current);
              setLanes(lanesRef.current);
            }, 80);
          }
          return;
        }
        const mark = ev.stream === 'err' ? '!' : ev.stream === 'progress' ? '·' : ' ';
        const line = `${mark}${ev.line}`.slice(0, 200);
        liveShellRef.current = [...liveShellRef.current, line].slice(-8);
        if (liveShellTimer.current === null) {
          liveShellTimer.current = setTimeout(() => {
            liveShellTimer.current = null;
            setLiveShell(liveShellRef.current);
            setLanes(lanesRef.current);
          }, 80);
        }
      }
    });
    return () => { unsubSide(); unsubHub(); };
  }, [nextId]);

  const askUser = useCallback((prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
    return getOperatorHub().requestApproval('main', prompt, options);
  }, []);

  const submitPrompt = useCallback(async (prompt: string, opts?: { displayAs?: string; skipUserHistory?: boolean }) => {
    if (!agentRef.current) return;

    // Slash command? Only when called from user input (not from internal re-submit of rendered template)
    if (!opts?.displayAs && prompt.trim().startsWith('/')) {
      const result = await handleSlashCommand(prompt, sessionId, activeCwd, props.config);
      if (result.handled) {
        if (result.message) {
          setHistory(h => [...h, { type: 'user', text: prompt, id: nextId() }, { type: 'system', text: result.message!, id: nextId() }]);
        }
        if (result.action?.type === 'clear') {
          setMessages([]);
          setHistory([]);
        }
        if (result.action?.type === 'set_model') {
          setExplicitModel(result.action.model);
        }
        if (result.action?.type === 'set_mode') {
          setMode(result.action.mode);
        }
        if (result.action?.type === 'set_approval_mode') {
          setApprovalModeGlobal(result.action.mode);
          setApprovalMode(result.action.mode);
        }
        if (result.action?.type === 'set_max_iterations') {
          maxIterOverrideRef.current = result.action.value;
        }
        if (result.action?.type === 'set_effort') {
          effortOverrideRef.current = result.action.value === 'off' ? undefined : result.action.value;
        }
        if (result.action?.type === 'switch_session') {
          const loaded = getSessionStore().loadSession(result.action.sessionId);
          if (loaded) {
            setSessionId(result.action.sessionId);
            const nextCwd = pickWorkingCwd({ sessionCwd: loaded.meta.cwd, hostCwd: props.cwd });
            setActiveCwd(nextCwd);
            agentRef.current?.setWorkingDirectory(nextCwd);
            setMessages(loaded.messages);
            const prior = messagesToHistory(loaded.messages) as HistoryItem[];
            setHistory([
              { type: 'system', text: `Resumed ${loaded.meta.turn_count} prior turns.`, id: nextId() },
              ...prior,
            ]);
          }
        }
        if (result.action?.type === 'retry') {
          const last = getSessionStore().truncateAfterLastUser(sessionId);
          if (!last) {
            setHistory(h => [...h, { type: 'system', text: 'Nothing to retry — no previous user turn.', id: nextId() }]);
            return;
          }
          const loaded = getSessionStore().loadSession(sessionId);
          if (loaded) setMessages(loaded.messages);
          setHistory(h => {
            let lastUser = -1;
            for (let i = 0; i < h.length; i++) if (h[i]!.type === 'user') lastUser = i;
            return lastUser >= 0 ? h.slice(0, lastUser + 1) : h;
          });
          await submitPrompt(last, { displayAs: last, skipUserHistory: true });
          return;
        }
        if (result.action?.type === 'compact') {
          if (!agentRef.current) {
            setHistory(h => [...h, { type: 'system', text: 'Agent is not ready yet.', id: nextId() }]);
            return;
          }
          const compacted = await agentRef.current.compactConversation(messages);
          if (!compacted) {
            setHistory(h => [...h, { type: 'system', text: 'Nothing to compact — history is already short, or the summarizer returned nothing useful.', id: nextId() }]);
            return;
          }
          getSessionStore().replaceMessages(sessionId, compacted.messages);
          setMessages(compacted.messages);
          setHistory(h => [...h, {
            type: 'system',
            text: `Compacted ${compacted.turnsCompacted} older turn(s), saved ~${compacted.savedTokens} tokens. Recent turns kept verbatim.`,
            id: nextId(),
          }]);
          return;
        }
        if (result.action?.type === 'exit') {
          exit();
        }
        if (result.action?.type === 'submit_prompt') {
          // Custom slash command: feed the rendered template through as a normal user prompt,
          // but DISPLAY the original `/foo args` text in history (not the expanded body).
          const { prompt: rendered, rawInput, allowedTools, model, mode: cmdMode } = result.action;
          nextRunOverrideRef.current = {
            ...(allowedTools && allowedTools.length > 0 ? { allowedTools } : {}),
            ...(model ? { model } : {}),
            ...(cmdMode ? { mode: cmdMode } : {}),
          };
          await submitPrompt(rendered, { displayAs: rawInput });
          return;
        }
        return;
      }
    }

    if (!opts?.skipUserHistory) {
      setHistory(h => [...h, { type: 'user', text: opts?.displayAs ?? prompt, id: nextId() }]);
    }
    setBusy(true);
    clearStreaming();
    setThinkingChars(0);
    liveShellRef.current = [];
    setLiveShell([]);
    setActiveTools([]);

    const ac = new AbortController();
    abortRef.current = ac;

    // Consume one-shot override (from custom slash commands). Reset immediately so
    // the NEXT plain user input runs without the restriction.
    const oneShot = nextRunOverrideRef.current;
    nextRunOverrideRef.current = null;
    const effectiveMode = oneShot?.mode ?? mode;
    const effectiveModel = oneShot?.model ?? explicitModel;
    const effectiveAllowed = oneShot?.allowedTools;

    // Auto-detect image paths in user-typed input and nudge the agent toward
    // vision_analyze. Only for real user input (not internal template re-submits).
    const modelPrompt = !opts?.displayAs ? annotateImagePrompt(prompt, activeCwd) : prompt;

    // Build initial system + user message if no history yet
    let initial: Message[];
    if (messages.length === 0) {
      initial = await agentRef.current.buildInitialMessages(
        modelPrompt,
        effectiveMode,
        effectiveModel ?? props.config.defaults.model,
      );
    } else {
      initial = [...messages, { role: 'user', content: modelPrompt }];
    }

    // Persist user turn (using the rendered prompt text so resume picks up the real instructions)
    getSessionStore().recordTurn(sessionId, [{ role: 'user', content: modelPrompt }], { input: 0, output: 0, costUsd: 0 });

    let accumulated = '';
    const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const event of agentRef.current.runSandboxed(initial, sessionId, {
        mode: effectiveAllowed ? { mode: effectiveMode, allowedTools: effectiveAllowed } : { mode: effectiveMode },
        explicitModel: effectiveModel,
        signal: ac.signal,
        askUser,
        maxIterationsOverride: maxIterOverrideRef.current,
        reasoningEffort: effortOverrideRef.current,
        onToolUI: (uiEvent) => {
          if (uiEvent.type === 'diff') {
            pendingDiffRef.current = uiEvent;
          } else if (uiEvent.type === 'progress') {
            setHistory(h => [...h, { type: 'system', text: uiEvent.message, id: nextId() }]);
          } else if (uiEvent.type === 'shell-stdout') {
            getOperatorHub().emitLive('main', 'out', uiEvent.line);
          } else if (uiEvent.type === 'shell-stderr') {
            getOperatorHub().emitLive('main', 'err', uiEvent.line);
          }
        },
      })) {
        if (ac.signal.aborted) break;
        switch (event.type) {
          case 'thinking_start':
            setThinkingChars(0);
            break;
          case 'thinking_delta':
            setThinkingChars(n => n + String(event.data?.delta ?? '').length);
            break;
          case 'text_delta':
            accumulated += event.data.delta ?? '';
            // Filter what we DISPLAY to user. The agent loop will run text-tool-recovery
            // on the final text anyway, but in the stream we don't want to flash raw tool
            // calls (JSON-shaped, <function=…>, or <tool_call>) or <thinking> blocks.
            // Strip all of them from the accumulated text each frame (stateless — the UI
            // re-renders the whole string).
            pushStreaming(stripLeakedToolTags(stripThinkingForDisplay(stripLeakedToolJson(accumulated))));
            break;
          case 'thinking_done':
            setThinkingChars(0);
            // Clear the live streaming region BEFORE committing the message to the
            // <Static> history. If the committed copy is appended to <Static> while
            // streamingText still holds the full text, Ink re-paints that streamed
            // text below the just-printed Static copy; when the answer is taller
            // than the viewport, its scrolled-off top sticks in the terminal
            // scrollback as a TRUNCATED "second copy" of the answer (full copy,
            // then a cut-off restart). The message data is never duplicated — only
            // the terminal paint — which is why the text-level dedupe helpers can't
            // catch it. Emptying the live region first removes the offending frame.
            clearStreaming();
            if (accumulated.trim()) {
              // Same filter when committing to history display, then collapse any
              // self-repeat (model emitting its whole answer twice in one block).
              const cleaned = stripLeakedToolTags(stripThinkingForDisplay(stripLeakedToolJson(accumulated))).trim();
              const displayText = dedupeSelfRepeatedText(cleaned);
              if (displayText) {
                setHistory(h => {
                  // Suppress a re-emitted answer: if the model repeats (or nearly
                  // repeats) its previous assistant block this turn, don't show it
                  // twice. Find the most recent assistant entry to compare against.
                  for (let i = h.length - 1; i >= 0; i--) {
                    const item = h[i];
                    if (item.type === 'assistant') {
                      if (isRedundantAssistantText(item.text, displayText)) return h;
                      break;
                    }
                    // Stop scanning back past a user turn — only dedupe within the
                    // current assistant response sequence.
                    if (item.type === 'user') break;
                  }
                  return [...h, { type: 'assistant', text: displayText, id: nextId() }];
                });
              }
            }
            accumulated = '';
            break;
          case 'tool_call_start':
            toolBuffers.set(event.data.index, { id: event.data.id ?? '', name: event.data.name, args: '' });
            setActiveTools(prev => [...prev, { id: event.data.id ?? String(event.data.index), name: event.data.name, partialArgs: '' }]);
            break;
          case 'tool_call_args_delta': {
            const buf = toolBuffers.get(event.data.index);
            if (buf) {
              buf.args += event.data.delta;
              setActiveTools(prev => prev.map(t => (t.id === buf.id || t.id === String(event.data.index) ? { ...t, partialArgs: buf.args.slice(0, 80) } : t)));
            }
            break;
          }
          case 'tool_result':
            liveShellRef.current = [];
            setLiveShell([]);
            setActiveTools(prev => prev.filter(t => t.id !== event.data.id));
            setHistory(h => [...h, {
              type: 'tool',
              name: event.data.name,
              result: event.data.result,
              isError: event.data.isError,
              id: nextId(),
            }]);
            break;
          case 'tool_ui': {
            // If a diff event came in, store it for upcoming permission prompt
            if (event.data.type === 'diff') {
              pendingDiffRef.current = event.data;
            }
            break;
          }
          case 'budget_update':
            setBudgetStatus({
              tokens: event.data.tokens,
              costUsd: event.data.costUsd,
              contextTokens: event.data.lastInputTokens ?? 0,
              contextWindow: event.data.contextWindow ?? 0,
              providerName: event.data.providerName ?? '',
              providerIsLocal: event.data.providerIsLocal !== false,
            });
            break;
          case 'final':
            // Already added during thinking_done
            break;
          case 'notice':
            setHistory(h => [...h, { type: 'system', text: event.data.message, id: nextId() }]);
            break;
          case 'steer_injected': {
            const note = String(event.data?.note ?? '');
            const preview = note.length > 56 ? note.slice(0, 56) + '…' : note;
            setHistory(h => [...h, { type: 'system', text: `↪ Steering applied: ${preview}`, id: nextId() }]);
            break;
          }
          case 'error':
            setHistory(h => [...h, { type: 'error', text: event.data.message, id: nextId() }]);
            break;
        }
      }
    } catch (e: any) {
      setHistory(h => [...h, { type: 'error', text: e.message, id: nextId() }]);
    } finally {
      // Reload messages from store
      const loaded = getSessionStore().loadSession(sessionId);
      if (loaded) setMessages(loaded.messages);
      setBusy(false);
      clearStreaming();
      setActiveTools([]);
      abortRef.current = null;
    }
  }, [sessionId, mode, explicitModel, messages, props.cwd, activeCwd, props.config, exit, nextId, askUser, pushStreaming, clearStreaming]);

  const handleSubmit = useCallback((value: string) => {
    const v = value.trim();
    if (!v) return;
    setInput('');
    // Record for arrow-key recall (skip consecutive duplicates).
    const ph = promptHistoryRef.current;
    if (ph[ph.length - 1] !== v) ph.push(v);
    // Mid-task steering: `/btw <note>` typed WHILE a turn is in flight is injected
    // into the running task (the model weighs it on its next step) instead of being
    // queued for after. When idle, it falls through to normal handling below.
    const steer = parseSteerInput(v);
    if (steer !== null && busy && agentRef.current) {
      if (steer.length === 0) {
        setHistory(h => [...h, { type: 'system', text: 'Usage: /btw <note> — sends a guidance note to the running task without stopping it.', id: nextId() }]);
        return;
      }
      agentRef.current.pushSteer(steer);
      const preview = steer.length > 56 ? steer.slice(0, 56) + '…' : steer;
      setHistory(h => [...h, { type: 'system', text: `↪ Steering note sent to the running task: ${preview}`, id: nextId() }]);
      return;
    }
    // Hermes-style interrupt-and-redirect: a plain message mid-task is a course
    // correction, not a queued next job. Slash commands still queue (or handle).
    if (busy && agentRef.current && !v.startsWith('/')) {
      agentRef.current.pushSteer(v);
      const preview = v.length > 56 ? v.slice(0, 56) + '…' : v;
      setHistory(h => [...h, { type: 'system', text: `↪ Redirected the running task: ${preview}`, id: nextId() }]);
      return;
    }
    // If a turn is in flight (or a permission prompt is open), QUEUE it instead of
    // dropping it — the drain effect runs it the moment the agent is free.
    if (busy || pendingPrompt) {
      setQueued(q => [...q, v]);
      const preview = v.length > 56 ? v.slice(0, 56) + '…' : v;
      setHistory(h => [...h, { type: 'system', text: `Queued — runs when the current task finishes: ${preview}`, id: nextId() }]);
      return;
    }
    void submitPrompt(v);
  }, [busy, pendingPrompt, submitPrompt, nextId]);

  // Drain the type-ahead queue: when the agent is idle and no permission prompt is
  // open, submit the next queued prompt. One at a time — a real turn flips `busy`,
  // which parks this effect until it finishes; instant prompts (e.g. slash commands)
  // re-trigger via drainTick. dispatchingRef guards against double-dispatch while a
  // queued submit is still settling.
  useEffect(() => {
    if (busy || pendingPrompt || dispatchingRef.current || queued.length === 0) return;
    dispatchingRef.current = true;
    const [next, ...rest] = queued;
    setQueued(rest);
    void submitPrompt(next).finally(() => {
      dispatchingRef.current = false;
      setDrainTick(t => t + 1);
    });
  }, [busy, pendingPrompt, queued, drainTick, submitPrompt]);

  // Welcome as a Static "sentinel" item. By living INSIDE <Static>, it gets painted
  // once and never repainted on subsequent re-renders — fixing the re-flash we'd see
  // on every state change. The renderer closure has access to props directly.
  type StaticItem = { kind: 'welcome' } | { kind: 'history'; item: HistoryItem };
  const staticItems: StaticItem[] = React.useMemo(
    () => [{ kind: 'welcome' as const }, ...history.map(item => ({ kind: 'history' as const, item }))],
    [history],
  );

  // Animated launch experience. Plays once, then collapses into the Welcome header.
  if (!booted) {
    return (
      <BootSplash
        cwd={props.cwd}
        config={props.config}
        registry={props.registry}
        router={props.router}
        onDone={() => setBooted(true)}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} items={staticItems}>
        {(entry, idx) => {
          if (entry.kind === 'welcome') {
            return (
              <Welcome
                key="__welcome__"
                cwd={activeCwd}
                config={props.config}
                registry={props.registry}
                router={props.router}
                resumedSession={resumedMeta}
                activeModel={explicitModel ?? props.config.defaults.model}
              />
            );
          }
          return <HistoryItemView key={entry.item.id} item={entry.item} />;
        }}
      </Static>

      {streamingText && (
        <StreamingView text={tailForViewport(streamingText, rows, cols)} />
      )}

      {/* Tool activity hides while a permission prompt is up — the prompt IS the activity,
          and every extra dynamic line enlarges the frame Ink re-paints. */}
      {!pendingPrompt && activeTools.map(t => (
        <ToolActivityLine key={t.id} name={t.name} partialArgs={t.partialArgs} motion={motion} />
      ))}
      {!pendingPrompt && liveShell.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {liveShell.map((line, i) => (
            <Text key={i} color={line.startsWith('!') ? 'red' : undefined} dimColor={!line.startsWith('!')}>
              {line.slice(0, Math.max(20, cols - 4))}
            </Text>
          ))}
        </Box>
      )}

      <SideRunDock lanes={lanes} expanded={dockOpen} width={cols} />

      {pendingPrompt && (
        <Box flexDirection="column">
          {pendingPrompt.diff && (
            <DiffViewer
              path={pendingPrompt.diff.path}
              before={pendingPrompt.diff.before}
              after={pendingPrompt.diff.after}
            />
          )}
          <Confirmation
            prompt={pendingPrompt.prompt}
            options={pendingPrompt.options}
            onAnswer={(a) => {
              const p = pendingPrompt;
              setPendingPrompt(null);
              p.resolve(a);
            }}
          />
          <Box paddingX={1}>
            <Text dimColor>Shift+Tab cycles approval · now {APPROVAL_MODE_META[approvalMode].label}</Text>
          </Box>
        </Box>
      )}

      {!pendingPrompt && (
        <Box flexDirection="column" marginTop={1}>
          {/* Persistent shimmering wordmark — the signature gradient keeps running. */}
          <LiveHeader width={cols} mode={mode} approvalMode={approvalMode} busy={busy} thinkingChars={thinkingChars} motion={motion} />
          {/* Input lives in its own bordered box, visually detached from the transcript above. */}
          <Box
            width={cols}
            borderStyle="round"
            borderColor={mode === 'plan' ? 'yellow' : 'cyan'}
            paddingX={1}
          >
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              cwd={activeCwd}
              placeholder={busy ? 'Type to redirect the running task, or /…' : 'Type a task, or /help  (Tab completes)'}
              accentColor={mode === 'plan' ? 'yellow' : 'cyan'}
              motion={motion}
              active={!pendingPrompt}
              busy={busy}
              historyRef={promptHistoryRef}
              extraSlashNames={[...slashAliasMap().keys()]}
              prefix={busy
                ? (motion ? <Spinner type="dots" /> : <Text color="cyan">·</Text>)
                : <Text color={mode === 'plan' ? 'yellow' : 'cyan'}>{mode === 'plan' ? '📋' : '❯'}</Text>}
            />
          </Box>
          {queued.length > 0 && (
            <Box paddingX={1}>
              <Text dimColor>
                {queued.length === 1
                  ? `⏎ queued: ${queued[0].length > 60 ? queued[0].slice(0, 60) + '…' : queued[0]}`
                  : `⏎ ${queued.length} prompts queued`}
              </Text>
            </Box>
          )}
          {exitArmed && (
            <Box paddingX={1}>
              <Text color="yellow">Press Ctrl+C again to exit</Text>
              <Text dimColor>  ·  or keep typing to stay</Text>
            </Box>
          )}
          <StatusBar
            width={cols}
            model={explicitModel ?? props.config.defaults.model}
            mode={mode}
            approvalMode={approvalMode}
            tokens={budgetStatus.tokens}
            costUsd={budgetStatus.costUsd}
            contextTokens={budgetStatus.contextTokens}
            contextWindow={budgetStatus.contextWindow}
            providerName={budgetStatus.providerName}
            providerIsLocal={budgetStatus.providerIsLocal}
            elapsedMs={busy && taskStartedAt ? Math.max(0, nowTick - taskStartedAt) : lastElapsedMs}
            busy={busy}
          />
        </Box>
      )}
    </Box>
  );
}

/**
 * Live activity line shown while a tool runs. Replaces the old "spinner + raw tool name"
 * with a friendly verb, a category colour + icon, and the streamed target (path/query/
 * command) — so "⚡ Running  npm test" reads at a glance instead of "⠋ bash {"command…".
 */
function ToolActivityLine(props: { name: string; partialArgs: string; motion: boolean }): React.ReactElement {
  const a = describeToolActivity(props.name);
  const targetRaw = extractTarget(props.partialArgs);
  const target = targetRaw ? formatTarget(targetRaw) : '';
  return (
    <Box>
      {props.motion ? <Spinner type="dots" /> : <Text color={a.color}>{a.icon}</Text>}
      <Text color={a.color} bold> {a.verb}</Text>
      {target && <Text dimColor>  {target}</Text>}
    </Box>
  );
}

/**
 * Persistent gradient wordmark above the input. Unlike the one-shot boot splash, this
 * keeps shimmering for the whole session — the "ingredient" the user wanted always
 * running. While the agent is busy it shows a soft working hint next to the mark; idle,
 * it's just the shimmering brand. Animation is gated by `motion` (TTY + opt-in).
 */
function LiveHeader(props: {
  width: number;
  mode: 'normal' | 'plan';
  approvalMode: ApprovalMode;
  busy: boolean;
  thinkingChars?: number;
  motion: boolean;
}): React.ReactElement {
  const phase = useShimmer(props.motion);
  const approval = APPROVAL_MODE_META[props.approvalMode];
  const thinkTok = props.thinkingChars && props.thinkingChars > 0
    ? Math.max(1, Math.round(props.thinkingChars / 4))
    : 0;
  return (
    <Box width={props.width} paddingX={1} marginBottom={0}>
      <GradientText text="✦ QodeX" stops={AURORA} phase={phase} bold />
      {props.busy
        ? thinkTok > 0
          ? <Text color="yellow">  ·  thinking… {thinkTok} tok  ·  Esc to stop</Text>
          : <Text dimColor>  ·  crafting…  ·  Esc to stop</Text>
        : props.mode === 'plan'
          ? <Text color="yellow">  ·  plan mode</Text>
          : <Text dimColor>  ·  ready</Text>}
      {props.mode !== 'plan' && (
        <Text color={approvalColor(props.approvalMode)} dimColor={props.approvalMode === 'manual'}>
          {'  ·  '}{approval.label}
        </Text>
      )}
    </Box>
  );
}

/**
 * Footer status line under the input box: model + mode on the left, usage + credit and
 * key hints on the right. "credit" reads "local · free" for on-device models (cost $0) and
 * the running dollar amount once a paid API is in play. Updates live as budget events land.
 */
function pickAutoAnswer(options: string[]): string | null {
  const lower = options.map(o => o.toLowerCase());
  for (const want of ['accept', 'yes', 'y', 'always']) {
    const i = lower.indexOf(want);
    if (i !== -1) return options[i]!;
  }
  return null;
}

function approvalColor(mode: ApprovalMode): 'green' | 'cyan' | 'yellow' {
  if (mode === 'always') return 'yellow';
  if (mode === 'auto') return 'cyan';
  return 'green';
}

function StatusBar(props: {
  width: number;
  model: string;
  mode: 'normal' | 'plan';
  approvalMode: ApprovalMode;
  tokens: number;
  costUsd: number;
  contextTokens: number;
  contextWindow: number;
  providerName?: string;
  providerIsLocal?: boolean;
  elapsedMs: number;
  busy: boolean;
}): React.ReactElement {
  const { width, model, mode, approvalMode, tokens, costUsd, contextTokens, contextWindow, providerName, providerIsLocal, elapsedMs, busy } = props;
  const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  // WHERE the model runs, stated — not guessed from cost: 'ollama·local', 'lmstudio·local',
  // 'anthropic·api'… A billing API at $0.0000 still shows ·api so cloud is never mistaken
  // for free-local; the dollar figure appears the moment real cost accrues.
  const source = providerName ? `${providerName}·${providerIsLocal ? 'local' : 'api'}` : '';
  const credit = costUsd > 0 ? `$${costUsd.toFixed(4)}` : providerIsLocal === false ? 'api · $0.0000' : 'local · free';
  // Throughput (token-consumption rate) + elapsed time. Average over the task —
  // total tokens / elapsed — which is exactly "how fast tokens are being spent".
  const secs = elapsedMs / 1000;
  const showTiming = elapsedMs > 0;
  const rate = secs > 0.3 ? Math.round(tokens / secs) : 0;
  const rateStr = rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : String(rate);
  const elapsedStr = secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs.toFixed(1)}s`;
  const ctxMeter = formatContextMeter(contextTokens, contextWindow);
  // Colour the meter by fullness: green < 60%, yellow < 85%, red beyond (approaching
  // compaction / the window limit).
  const ctxPct = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
  const ctxColor = ctxPct >= 85 ? 'red' : ctxPct >= 60 ? 'yellow' : 'green';
  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Box>
        <Text dimColor>{model}</Text>
        {getActiveProfile() && (
          <>
            <Text dimColor>  ·  </Text>
            <Text color="magenta" dimColor={!busy}>{getActiveProfile()!.name}</Text>
          </>
        )}
        {source !== '' && (
          <>
            <Text dimColor>  ·  </Text>
            <Text color={providerIsLocal ? 'cyan' : 'magenta'} dimColor={!busy}>{source}</Text>
          </>
        )}
        <Text dimColor>  ·  </Text>
        <Text color={mode === 'plan' ? 'yellow' : 'green'}>{mode}</Text>
        <Text dimColor>  ·  </Text>
        <Text color={approvalColor(approvalMode)}>{APPROVAL_MODE_META[approvalMode].label}</Text>
        {ctxMeter !== '' && (
          <>
            <Text dimColor>  ·  </Text>
            <Text color={ctxColor} dimColor={!busy}>{ctxMeter}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text dimColor>{tok} tok</Text>
        {showTiming && (
          <Text color={busy ? 'cyan' : undefined} dimColor={!busy}>
            {'  ·  '}{rateStr} tok/s{'  ·  '}{elapsedStr}
          </Text>
        )}
        <Text dimColor>{'  ·  '}</Text>
        <Text color={costUsd > 0 ? 'magenta' : 'green'}>{credit}</Text>
        <Text dimColor>  ·  ⏎ send  ·  ⇧⇥ mode  ·  ^C exit</Text>
      </Box>
    </Box>
  );
}

function HistoryItemView({ item }: { item: HistoryItem }): React.ReactElement {
  switch (item.type) {
    case 'user':
      return (
        <Box flexDirection="column" marginY={1}>
          <Text color="cyan" bold>❯ {item.text}</Text>
        </Box>
      );
    case 'assistant':
      return <AssistantMessage text={item.text} />;
    case 'tool': {
      // Compact, Claude-Code-style display: a one-line metric + at most a short
      // preview, instead of dumping the whole file/output into the transcript.
      // The agent always receives the FULL result through the loop; this only
      // affects what the human sees scroll past.
      const { headline, lines } = summarizeToolResult(item.name, item.result, !!item.isError);
      const act = describeToolActivity(item.name);
      return (
        <Box flexDirection="column" marginLeft={2} marginY={0}>
          <Text>
            <Text color={item.isError ? 'red' : act.color} bold>
              {item.isError ? '✗' : act.icon} {act.verb}
            </Text>
            <Text dimColor>  {item.name}</Text>
            {headline ? <Text dimColor>  ·  {headline}</Text> : null}
          </Text>
          {lines.map((ln, i) => (
            <Text key={i} dimColor>  {ln}</Text>
          ))}
        </Box>
      );
    }
    case 'system':
      return <Text color="yellow" dimColor>※ {item.text}</Text>;
    case 'error':
      return <Text color="red">⚠ {item.text}</Text>;
  }
}

/**
 * Strip leaked tool-call JSON from streamed text before showing to the user.
 *
 * Some local models (notably Qwen 2.5 Coder in Ollama) emit tool calls as literal
 * JSON in their text stream. The agent loop's text-tool-recovery extracts them as
 * proper ToolCall objects — but in the meantime, the user would see the raw JSON
 * scroll past in the streaming view, which is noisy and confusing.
 *
 * This helper does a conservative pass: find every balanced top-level `{...}` block
 * whose head looks like a tool call (has "name" and one of "arguments"/"parameters"/
 * "input"), and remove it. Leaves prose entirely untouched.
 */
function stripLeakedToolJson(text: string): string {
  if (!text || !text.includes('{')) return text;
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      result += text[i];
      i++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { endIdx = j; break; }
      }
    }
    if (endIdx === -1) {
      // Unbalanced — could be mid-stream. Keep the rest as-is.
      // (When the stream finishes, the block will close and a later pass will catch it.)
      result += text.slice(i);
      break;
    }
    const block = text.slice(i, endIdx + 1);
    const head = block.slice(0, 200);
    const looksLikeToolCall =
      /"name"\s*:/.test(head) &&
      (/"arguments"\s*:/.test(head) || /"parameters"\s*:/.test(head) || /"input"\s*:/.test(head));
    if (looksLikeToolCall) {
      i = endIdx + 1;
    } else {
      result += block;
      i = endIdx + 1;
    }
  }
  return result.replace(/\n{3,}/g, '\n\n');
}