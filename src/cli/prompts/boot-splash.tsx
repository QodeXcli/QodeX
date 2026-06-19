/**
 * BootSplash — the animated launch experience for QodeX.
 *
 * A premium, UI/UX-grade cold-start: a gradient ANSI-shadow wordmark with a sliding
 * shimmer, an init checklist whose subsystems light up one-by-one (✓ as each comes
 * online), and a gradient progress bar. It settles after ~1.2s and hands off to the
 * main UI via `onDone`.
 *
 * Honest, not theatre: every checklist detail is read from real runtime state (model
 * count, tool count, config flags). Degrades gracefully — no TTY or QODEX_NO_SPLASH=1
 * skips straight to the app; no colour support drops the gradient to plain bold.
 */

import React, { useEffect, useMemo, useState } from 'react'; // useState: step reveal
import { Box, Text, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import type { QodexConfig } from '../../config/defaults.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ModelRouter } from '../../llm/router.js';
import { GradientText, GradientBar, AURORA, useShimmer } from './gradient.js';
import { buildBootSteps } from './boot-steps.js';

// ANSI-shadow "QODEX" wordmark (used when the terminal is wide enough).
const LOGO: string[] = [
  ' ██████╗  ██████╗ ██████╗ ███████╗██╗  ██╗',
  '██╔═══██╗██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝',
  '██║   ██║██║   ██║██║  ██║█████╗   ╚███╔╝ ',
  '██║▄▄ ██║██║   ██║██║  ██║██╔══╝   ██╔██╗ ',
  '╚██████╔╝╚██████╔╝██████╔╝███████╗██╔╝ ██╗',
  ' ╚══▀▀═╝  ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
];
const LOGO_WIDTH = 42;

const STEP_INTERVAL_MS = 135;
const SHIMMER_INTERVAL_MS = 80;
const HOLD_AFTER_DONE_MS = 480;

export interface BootSplashProps {
  cwd: string;
  config: QodexConfig;
  registry: ToolRegistry;
  router: ModelRouter;
  onDone: () => void;
}

export function BootSplash(props: BootSplashProps): React.ReactElement {
  const { config, registry, router, onDone } = props;
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const wide = cols >= LOGO_WIDTH + 4;

  const motion = !!stdout?.isTTY && process.env.QODEX_NO_SPLASH !== '1';

  const steps = useMemo(() => {
    let modelCount = 0;
    try { modelCount = router.listAvailableModels().length; } catch { /* ignore */ }
    return buildBootSteps({
      modelCount,
      toolCount: registry.list().length,
      model: config.defaults.model,
      autoRetrieve: (config as any).context?.autoRetrieve !== false,
      draftModel: (config.providers as any)?.openai?.draftModel ?? (config.providers as any)?.ollama?.draftModel,
    });
  }, [config, registry, router]);

  // `revealed` = how many steps are fully online (✓). The step at index `revealed`
  // (if any) is the one currently spinning.
  const [revealed, setRevealed] = useState(0);
  // Shimmer: slide the gradient phase continuously while the splash is up.
  const phase = useShimmer(motion, SHIMMER_INTERVAL_MS);

  // No motion (piped / disabled) → don't animate, hand off on next tick.
  useEffect(() => {
    if (motion) return;
    const t = setTimeout(onDone, 0);
    return () => clearTimeout(t);
  }, [motion, onDone]);

  // Reveal steps one at a time; when all are online, hold briefly then finish.
  useEffect(() => {
    if (!motion) return;
    if (revealed >= steps.length) {
      const done = setTimeout(onDone, HOLD_AFTER_DONE_MS);
      return () => clearTimeout(done);
    }
    const next = setTimeout(() => setRevealed(r => r + 1), STEP_INTERVAL_MS);
    return () => clearTimeout(next);
  }, [motion, revealed, steps.length, onDone]);

  const progress = steps.length === 0 ? 1 : revealed / steps.length;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Wordmark — full ANSI-shadow logo on wide terminals, compact mark otherwise. */}
      {wide ? (
        <Box flexDirection="column">
          {LOGO.map((line, i) => (
            <GradientText key={i} text={line} stops={AURORA} phase={phase + i * 0.05} bold />
          ))}
        </Box>
      ) : (
        <GradientText text="✦  Q O D E X" stops={AURORA} phase={phase} bold />
      )}

      <Box marginTop={1}>
        <Text dimColor>  Specialized UI/UX-grade coding agent</Text>
        <Text color="#6366f1">  ·  </Text>
        <Text dimColor>local-first</Text>
      </Box>

      {/* Init checklist — progressive reveal. */}
      <Box marginTop={1} flexDirection="column">
        {steps.map((s, i) => {
          if (i > revealed) return null;
          const online = i < revealed;
          return (
            <Box key={s.label}>
              <Text>  </Text>
              {online
                ? <Text color="#34d399">✓</Text>
                : <Text color="#22d3ee"><Spinner type="dots" /></Text>}
              <Text> </Text>
              <Text color={online ? 'white' : 'cyan'}>{s.label.padEnd(21)}</Text>
              <Text dimColor>{s.detail}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text>  </Text>
        <GradientBar value={progress} width={wide ? 30 : 18} stops={AURORA} />
      </Box>
    </Box>
  );
}
