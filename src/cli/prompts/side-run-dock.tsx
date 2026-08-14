/**
 * Side-run dock — a collapsible strip above the input.
 *
 * Background live lines stay out of the main transcript. Collapsed: one row
 * per run. Ctrl+B expands the last N hub lines for each lane.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Lane } from '../../operator/live-lanes.js';
import { lastLine, visibleLanes } from '../../operator/live-lanes.js';

const STATUS_GLYPH: Record<Lane['status'], string> = {
  running: '…',
  done: '✓',
  failed: '✗',
  cancelled: '■',
};

const STATUS_COLOR: Record<Lane['status'], string> = {
  running: 'cyan',
  done: 'green',
  failed: 'red',
  cancelled: 'gray',
};

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function lineColor(stream: Lane['lines'][number]['stream']): string | undefined {
  if (stream === 'err') return 'red';
  return undefined;
}

export function SideRunDock(props: {
  lanes: Lane[];
  expanded: boolean;
  width: number;
}): React.ReactElement | null {
  const shown = visibleLanes(props.lanes);
  if (shown.length === 0) return null;

  const inner = Math.max(24, props.width - 4);
  const unread = shown.reduce((n, l) => n + l.unread, 0);
  const hint = props.expanded ? 'Ctrl+B collapse' : `Ctrl+B expand${unread ? ` · ${unread} new` : ''}`;

  return (
    <Box
      flexDirection="column"
      width={props.width}
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginTop={1}
    >
      <Text dimColor>{`bg · ${hint}`}</Text>
      {shown.map(lane => {
        const glyph = STATUS_GLYPH[lane.status];
        const color = STATUS_COLOR[lane.status];
        const prompt = clip(lane.prompt, Math.max(12, inner - 18));
        const tail = lastLine(lane);
        if (!props.expanded) {
          const preview = tail ? clip(tail.text, Math.max(10, inner - prompt.length - 16)) : '';
          return (
            <Text key={lane.id}>
              <Text color={color}>{glyph}</Text>
              <Text color="magenta"> {lane.id}</Text>
              <Text>  {prompt}</Text>
              {preview ? <Text dimColor={tail?.stream !== 'err'} color={lineColor(tail!.stream)}>  · {preview}</Text> : null}
              {lane.unread > 0 ? <Text color="yellow">  ·{lane.unread}</Text> : null}
            </Text>
          );
        }
        return (
          <Box key={lane.id} flexDirection="column">
            <Text>
              <Text color={color}>{glyph}</Text>
              <Text color="magenta"> {lane.id}</Text>
              <Text>  {prompt}</Text>
            </Text>
            {lane.lines.length === 0
              ? <Text dimColor>    (no output yet)</Text>
              : lane.lines.map((ln, i) => (
                  <Text
                    key={`${lane.id}-${i}`}
                    color={lineColor(ln.stream)}
                    dimColor={ln.stream !== 'err'}
                  >
                    {`    ${ln.stream === 'err' ? '!' : ln.stream === 'progress' ? '·' : ' '} ${clip(ln.text, inner - 6)}`}
                  </Text>
                ))}
          </Box>
        );
      })}
    </Box>
  );
}
