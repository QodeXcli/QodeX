import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface ConfirmationProps {
  prompt: string;
  options: string[];
  onAnswer: (answer: string) => void;
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
      const lower = input.toLowerCase();
      // Shortcuts: y/n/a (first letter)
      const idx = options.findIndex(o => o.toLowerCase().startsWith(lower));
      if (idx !== -1) {
        setDone(true);
        onAnswer(options[idx]!);
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
      <Text dimColor>← → to choose, Enter to confirm, or type {options.map(o => o[0]).join('/')}</Text>
    </Box>
  );
}
