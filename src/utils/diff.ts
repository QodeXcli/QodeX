import { createPatch, diffLines } from 'diff';

export interface DiffStats {
  additions: number;
  deletions: number;
}

export function generateUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
  return createPatch(filePath, oldContent, newContent, '', '', { context: 3 });
}

export function computeDiffStats(oldContent: string, newContent: string): DiffStats {
  const changes = diffLines(oldContent, newContent);
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const lineCount = (change.value.match(/\n/g) ?? []).length;
    if (change.added) additions += lineCount;
    if (change.removed) deletions += lineCount;
  }
  return { additions, deletions };
}

export interface ColoredDiffLine {
  type: 'add' | 'del' | 'context' | 'hunk';
  text: string;
}

export function parseDiffForDisplay(unifiedDiff: string): ColoredDiffLine[] {
  const lines = unifiedDiff.split('\n');
  const result: ColoredDiffLine[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      result.push({ type: 'hunk', text: line });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      result.push({ type: 'add', text: line });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      result.push({ type: 'del', text: line });
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    } else {
      result.push({ type: 'context', text: line });
    }
  }
  return result;
}
