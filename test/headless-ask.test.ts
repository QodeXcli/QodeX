import { describe, it, expect } from 'vitest';
import { headlessAskChoice } from '../src/cli/modes/headless-ask.js';

const EDIT_OPTS = ['accept', 'always yes', 'edit', 'continue', 'reject'];
const YES_NO = ['yes', 'no'];

describe('headlessAskChoice — fail-safe', () => {
  it('--yes on edit options returns accept, not the first look-alike', () => {
    expect(headlessAskChoice(EDIT_OPTS, true)).toEqual({ choice: 'accept', denied: false });
  });

  it('--yes matches the always yes label', () => {
    expect(headlessAskChoice(['always yes', 'reject'], true)).toEqual({ choice: 'always yes', denied: false });
  });

  it('--yes on yes/no returns yes', () => {
    expect(headlessAskChoice(YES_NO, true)).toEqual({ choice: 'yes', denied: false });
  });

  it('without --yes, edit options deny as reject — never fall through to accept', () => {
    const r = headlessAskChoice(EDIT_OPTS, false);
    expect(r).toEqual({ choice: 'reject', denied: true });
    expect(r.choice).not.toBe('accept');
  });

  it('without --yes, yes/no denies as no', () => {
    expect(headlessAskChoice(YES_NO, false)).toEqual({ choice: 'no', denied: true });
  });

  it('--yes with no affirmative option still denies', () => {
    expect(headlessAskChoice(['edit', 'continue'], true)).toEqual({
      choice: 'reject',
      denied: true,
    });
  });

  it('bot /auto on edit options must pick accept, not always yes', () => {
    // Same helper the bot runner uses — matching `always` as a prefix used to
    // yolo the whole process on the first write_file prompt.
    expect(headlessAskChoice(EDIT_OPTS, true).choice).toBe('accept');
    expect(headlessAskChoice(EDIT_OPTS, true).choice).not.toBe('always yes');
  });
});
