import React from 'react';
import { Box, Text } from 'ink';
import { scrollThoughts, THINK_ROWS } from '../viewport.js';

/**
 * Live reasoning pane. Height is fixed: new thoughts scroll to the bottom
 * inside the box. The CLI around it does not grow.
 */
export function ThinkingPanel(props: { text: string; width: number; rows?: number }): React.ReactElement {
  const rows = scrollThoughts(props.text, props.rows ?? THINK_ROWS, Math.max(16, props.width - 4));
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="yellow" width={props.width}>
      <Text color="yellow" dimColor italic>thinking</Text>
      {rows.map((ln, i) => (
        <Text key={i} color="yellow" dimColor>{ln.length ? ln : ' '}</Text>
      ))}
    </Box>
  );
}