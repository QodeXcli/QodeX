import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { QodexConfig } from '../../config/defaults.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ModelRouter } from '../../llm/router.js';
import { GradientText, AURORA } from './gradient.js';

export interface WelcomeProps {
  cwd: string;
  config: QodexConfig;
  registry: ToolRegistry;
  router: ModelRouter;
  resumedSession?: { id: string; turnCount: number };
  /** The model actually in effect (e.g. from --model), shown in the header instead
   *  of config.defaults.model when set. */
  activeModel?: string;
}

/**
 * Settled workspace header — what the animated boot splash collapses into. Rendered
 * inside <Static> so it paints once at the top and never repaints. A compact gradient
 * wordmark, a capability strip, and the run's vitals (model / tools / dir).
 */
export function Welcome(props: WelcomeProps): React.ReactElement {
  const { cwd, config, registry, router, resumedSession } = props;
  const model = props.activeModel ?? config.defaults.model;
  const toolCount = registry.list().length;
  const homeShort = cwd.replace(process.env.HOME ?? '', '~');

  // Make the header responsive: read the terminal width and clamp the box to it so a
  // narrow terminal doesn't shatter the border. A program can't resize the user's
  // terminal (only the terminal app can), but it CAN lay itself out to fit.
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  // Leave a little breathing room; cap so it doesn't sprawl on ultra-wide terminals.
  const boxWidth = Math.max(34, Math.min(termWidth - 2, 100));
  const narrow = termWidth < 60;

  let modelCount = 0;
  try { modelCount = router.listAvailableModels().length; } catch { /* ignore */ }

  // Capability badges reflect the perf subsystems actually wired in. On a narrow
  // terminal we drop to a shorter set so the strip doesn't wrap mid-border.
  const autoRetrieve = (config as any).context?.autoRetrieve !== false;
  const badges = narrow
    ? ['constrained', 'retrieval', 'vision', 'browser']
    : [
        'constrained decoding',
        autoRetrieve ? 'auto-retrieval' : 'retrieval',
        'diagnostics',
        'vision',
        'browser',
      ];

  const tagline = narrow ? 'local-first coding agent' : 'Specialized UI/UX-grade coding agent · local-first';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="#6366f1"
        paddingX={2}
        paddingY={1}
        width={boxWidth}
      >
        <Box flexWrap="wrap">
          <GradientText text="✦ QodeX" stops={AURORA} bold />
          <Text dimColor>   {tagline}</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text dimColor>model  </Text>
            <Text color="#34d399">{model}</Text>
            {modelCount > 0 && <Text dimColor>   ({modelCount} ready)</Text>}
          </Text>
          <Text>
            <Text dimColor>tools  </Text>
            <Text>{toolCount} built-in</Text>
          </Text>
          <Text>
            <Text dimColor>dir    </Text>
            <Text>{homeShort}</Text>
          </Text>
          {resumedSession && (
            <Text>
              <Text dimColor>resume </Text>
              <Text color="yellow">{resumedSession.turnCount} prior turns</Text>
            </Text>
          )}
        </Box>

        <Box marginTop={1} flexWrap="wrap">
          <Text dimColor>┄ </Text>
          {badges.map((b, i) => (
            <Text key={b}>
              {i > 0 && <Text dimColor> · </Text>}
              <Text color="#22d3ee">{b}</Text>
            </Text>
          ))}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Type a task, or </Text>
        <Text color="#a855f7">/help</Text>
        <Text dimColor> for commands.</Text>
      </Box>
    </Box>
  );
}
