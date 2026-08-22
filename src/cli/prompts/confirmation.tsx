import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface ConfirmationProps {
  prompt: string;
  options: string[];
  onAnswer: (answer: string) => void;
}

function pickByShortcut(options: string[], key: string): string | null {
  if (!key) return null;
  if (key === '!' || key === 'A') {
    return options.find(o => o.toLowerCase().startsWith('always')) ?? null;
  }
  const lower = key.toLowerCase();
  if (lower === 'y') {
    return options.find(o => /^(accept|yes)$/i.test(o)) ?? null;
  }
  // Unique prefix only — so 'a' is accept, not "always yes".
  const hits = options.filter(o => {
    const oLower = o.toLowerCase();
    if (oLower.startsWith('always')) return false;
    return oLower.startsWith(lower);
  });
  return hits.length === 1 ? hits[0]! : null;
}

export function Confirmation({ prompt, options, onAnswer }: ConfirmationProps): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [done, setDone] = useState(false);

  useInput((input, key) => {
    if (done) return;
    if (key.leftArrow || key.upArrow) {
      setSelected(s => (s - 1 + options.length) % options.length);
    } else if (key.rightArrow || key.downArrow) {
      setSelected(s => (s + 1) % options.length);
    } else if (key.return) {
      setDone(true);
      onAnswer(options[selected]!);
    } else if (input) {
      const hit = pickByShortcut(options, input);
      if (hit) {
        setDone(true);
        onAnswer(hit);
      }
    }
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color="yellow">{prompt}</Text>
      <Box>
        {options.map((o, i) => (
          <Box key={o} marginRight={2}>
            <Text inverse={i === selected} color={i === selected ? 'black' : 'white'} backgroundColor={i === selected ? 'cyan' : undefined}>
              {' '}{o}{' '}
            </Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>← → · Enter  ·  y accept  ·  ! always yes  ·  e edit  ·  n reject</Text>
    </Box>
  );
}

export { pickByShortcut };
