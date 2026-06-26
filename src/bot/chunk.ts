/**
 * Code-fence-aware streaming splitter (PURE).
 *
 * Chat platforms cap message length (Telegram 4096, Discord 2000). Splitting an agent's
 * answer naively shears code blocks in half — the first message has an unclosed ``` and the
 * second starts mid-code with no fence, so both render as garbage. This splits a growing tail
 * of text into platform-sized `display` pieces that ALWAYS have balanced fences: an open fence
 * is closed at a cut and re-opened (with the same language) at the start of the next piece.
 *
 * Each piece reports `consumed` = how many ORIGINAL characters it represents (the synthetic
 * re-open prefix and closing fence don't count), so a streaming caller can advance a stable
 * offset and never re-send finalized text. Σ consumed === text.length, exactly once each.
 */
export interface Piece { display: string; consumed: number }

const FENCE = /^\s*```/;
const CLOSE = '\n```';

export function splitForStream(text: string, maxLen: number): Piece[] {
  if (text.length === 0) return [{ display: '', consumed: 0 }];

  // Tokenize into lines, keeping each trailing "\n" attached so offsets stay exact.
  const lines: string[] = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { lines.push(text.slice(s, i + 1)); s = i + 1; }
  }
  if (s < text.length) lines.push(text.slice(s));

  const pieces: Piece[] = [];
  let disp = '';
  let consumed = 0;
  let fenceOpen = false;
  let fenceInfo = '';

  const reopenPrefix = () => '```' + fenceInfo + '\n';
  const isFresh = () => disp.length === (fenceOpen ? reopenPrefix().length : 0);
  const cut = () => {
    pieces.push({ display: fenceOpen ? disp + CLOSE : disp, consumed });
    disp = fenceOpen ? reopenPrefix() : '';
    consumed = 0;
  };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]!;
    const isFenceLine = FENCE.test(line);
    const willBeOpen = isFenceLine ? !fenceOpen : fenceOpen;
    const room = () => maxLen - (willBeOpen ? CLOSE.length : 0) - disp.length;

    while (line.length > room()) {
      if (!isFresh()) { cut(); continue; }            // flush current piece, retry on a clean one
      const take = Math.max(1, room());               // line alone too big → hard char-split
      disp += line.slice(0, take); consumed += take;
      cut();
      line = line.slice(take);
    }

    disp += line; consumed += line.length;
    if (isFenceLine) {
      if (!fenceOpen) { fenceOpen = true; fenceInfo = line.trim().slice(3).trim(); }
      else { fenceOpen = false; fenceInfo = ''; }
    }
  }

  pieces.push({ display: disp, consumed });
  return pieces;
}
