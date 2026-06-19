import React from 'react';
import { Box, Text } from 'ink';
import { parseDiffForDisplay, generateUnifiedDiff } from '../../utils/diff.js';

interface DiffViewerProps {
  path: string;
  before: string | null;
  after: string;
  maxLines?: number;
}

export function DiffViewer({ path, before, after, maxLines = 30 }: DiffViewerProps): React.ReactElement {
  const diff = generateUnifiedDiff(before ?? '', after, path);
  const lines = parseDiffForDisplay(diff);
  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : lines;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">📝 {path}</Text>
      {shown.map((l, i) => {
        if (l.type === 'add') return <Text key={i} color="green">{l.text}</Text>;
        if (l.type === 'del') return <Text key={i} color="red">{l.text}</Text>;
        if (l.type === 'hunk') return <Text key={i} color="cyan" dimColor>{l.text}</Text>;
        return <Text key={i} dimColor>{l.text}</Text>;
      })}
      {truncated && <Text dimColor>... ({lines.length - maxLines} more lines)</Text>}
    </Box>
  );
}
