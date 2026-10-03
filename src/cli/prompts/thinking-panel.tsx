import React from 'react';
import { Box, Text } from 'ink';

const MAX_LINES = 12;

/** Live reasoning pane — dim, not committed to history. */
export function ThinkingPanel(props: { text: string; width: number }): React.ReactElement | null {
  const raw = props.text.replace(/\s+$/, '');
  if (!raw.trim()) return null;
  const lines = raw.split('\n');
  const shown = lines.slice(-MAX_LINES);
  const col = Math.max(24, props.width - 4);
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="yellow" width={props.width}>
      <Text color="yellow" dimColor italic>
        thinking{lines.length > MAX_LINES ? `  ·  last ${MAX_LINES} lines` : ''}
      </Text>
      {shown.map((ln, i) => (
        <Text key={i} color="yellow" dimColor>{ln.slice(0, col)}</Text>
      ))}
    </Box>
  );
}
