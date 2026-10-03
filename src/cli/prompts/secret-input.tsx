/**
 * The terminal's secure login prompt (vault_request_login → SecretRequestBroker).
 *
 * <SecretPromptHost> registers the TUI as the 'terminal' secret surface while it is
 * mounted and shows the oldest pending request as a masked form: username (plain,
 * pre-filled with the agent's hint), password + repeat (masked), and the 2FA setup
 * key (masked, optional). Enter moves on; Esc (or Ctrl+C) cancels THIS REQUEST —
 * the running task continues and the tool reports the decline.
 *
 * What it never does: echo a value (the password fields render as dots), put a
 * keystroke into the chat input or its history (the host tells ui.tsx it owns the
 * keyboard, and ui.tsx then hides the chat input and ignores its own shortcuts), or
 * route anything through the approval broker / operator hub. The typed values go
 * to broker.answer(), which writes them into the vault and returns a summary.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  getSecretRequestBroker,
  type PendingSecretRequest,
  type SecretAnswer,
  type SecretAnswerOutcome,
  type SecretRequestBroker,
} from '../../vault/requests.js';

type Step = 'username' | 'password' | 'repeat' | 'totp';

const LABELS: Record<Step, string> = {
  username: 'Username',
  password: 'Password',
  repeat: 'Repeat password',
  totp: '2FA setup key (optional — Enter to skip)',
};

/** Field order for a request. PURE. */
export function secretSteps(req: Pick<PendingSecretRequest, 'fields'>): Step[] {
  const s: Step[] = ['username', 'password', 'repeat'];
  if (req.fields.includes('totp')) s.push('totp');
  return s;
}

export interface SecretInputFormProps {
  request: PendingSecretRequest;
  onSubmit: (values: SecretAnswer) => Promise<SecretAnswerOutcome>;
  onCancel: () => void;
  /** Take keystrokes (false until the chat input has been hidden). Default true. */
  focus?: boolean;
}

export function SecretInputForm({ request, onSubmit, onCancel, focus = true }: SecretInputFormProps): React.ReactElement {
  const steps = useMemo(() => secretSteps(request), [request.id]);
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState(request.usernameHint ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // The current field and its text are mirrored in refs, and every key goes through them:
  // Ink attaches key handlers in a deferred effect, so a key typed right after Enter can
  // reach the handler of the previous render — it must still land in the CURRENT field
  // (with a per-field input component it landed in the previous one: a fast "pw⏎pw⏎"
  // became a false "passwords do not match").
  const idxRef = useRef(0);
  const textRef = useRef(request.usernameHint ?? '');
  const savingRef = useRef(false);
  // Entered values live in a ref (not rendered) and are dropped right after submit.
  const values = useRef<Partial<Record<Step, string>>>({});
  const step = steps[idx]!;

  const setField = (i: number, t: string): void => { idxRef.current = i; textRef.current = t; setIdx(i); setText(t); };
  const setValue = (t: string): void => { textRef.current = t; setText(t); };
  const setBusy = (b: boolean): void => { savingRef.current = b; setSaving(b); };

  const submitField = (raw: string): void => {
    const at = idxRef.current;
    const cur = steps[at]!;
    const v = cur === 'username' || cur === 'totp' ? raw.trim() : raw;
    if (cur === 'password' && !v) { setError('The password is empty.'); return; }
    if (cur === 'repeat' && v !== values.current.password) {
      values.current.password = '';
      setError('The two passwords do not match — type it again.');
      setField(steps.indexOf('password'), '');
      return;
    }
    values.current[cur] = v;
    setError('');
    if (at < steps.length - 1) { setField(at + 1, ''); return; }
    setBusy(true);
    setValue('');
    const answer: SecretAnswer = {
      username: values.current.username || undefined,
      password: values.current.password,
      totp: values.current.totp || undefined,
    };
    void onSubmit(answer).then(out => {
      if (out.ok) { values.current = {}; return; }
      setBusy(false);
      setError(out.error);
      if (/TOTP/.test(out.error) && steps.includes('totp')) { values.current.totp = ''; setField(steps.indexOf('totp'), ''); }
    }, () => { setBusy(false); setError('Could not save — try again or press Esc.'); });
  };

  useInput((input, key) => {
    if (savingRef.current) return;
    if (key.escape || (key.ctrl && input === 'c')) {
      values.current = {};
      onCancel();
      return;
    }
    if (key.return) { submitField(textRef.current); return; }
    if (key.backspace || key.delete) { setValue(textRef.current.slice(0, -1)); return; }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown) return;
    if (!input) return;
    // A pasted value may end in (or contain) Enter: type each line, Enter between them.
    const lines = input.split(/\r\n|\r|\n/);
    lines.forEach((line, i) => {
      if (savingRef.current) return;
      if (i > 0) submitField(textRef.current);
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/[\u0000-\u001f\u007f]/g, '');
      if (clean && !savingRef.current) setValue(textRef.current + clean);
    });
  }, { isActive: focus });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginY={1}>
      <Text color="magenta" bold>🔐 Login for {request.displayHost}</Text>
      <Text>QodeX asks you to type it here — it goes straight into the encrypted vault; the agent never sees it.</Text>
      {request.reason ? <Text dimColor>Why: {request.reason}</Text> : null}
      {request.warning ? <Text color="yellow">⚠ {request.warning}</Text> : null}
      <Text dimColor>Vault entry: {request.entryName}{request.existing ? ' (updates the saved password; other fields are kept)' : ' (new)'}</Text>
      {steps.slice(0, idx).map(s => (
        <Text key={s} dimColor>
          {LABELS[s]}: {s === 'username' ? (values.current.username || '(none)') : s === 'totp' ? (values.current.totp ? '✓ entered' : '(skipped)') : '✓ entered'}
        </Text>
      ))}
      {saving
        ? <Text color="cyan">Saving to the vault…</Text>
        : (
          <Box>
            <Text color="cyan">{LABELS[step]}: </Text>
            <Text>{step === 'username' ? text : '•'.repeat(text.length)}</Text>
            {focus ? <Text inverse> </Text> : null}
          </Box>
        )}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter next · Esc cancels this request (the task keeps running)</Text>
    </Box>
  );
}

export interface SecretPromptHostProps {
  /** Another prompt (a confirmation) owns the keyboard: show a one-line notice only. */
  blocked?: boolean;
  /** Told whenever the masked prompt starts / stops owning the keyboard. */
  onActiveChange?: (active: boolean) => void;
  /** Injectable for tests. */
  broker?: SecretRequestBroker;
}

/** Mount once in the TUI: makes the terminal a secret surface and shows pending requests. */
export function SecretPromptHost({ blocked = false, onActiveChange, broker: injected }: SecretPromptHostProps): React.ReactElement | null {
  const broker = injected ?? getSecretRequestBroker();
  const [pending, setPending] = useState<PendingSecretRequest[]>(() => broker.pending());
  useEffect(() => {
    const detach = broker.attachSurface('terminal');
    const off = broker.onChange(list => setPending(list));
    setPending(broker.pending());
    return () => { off(); detach(); };
  }, [broker]);
  const req = pending[0] ?? null;
  const active = !!req && !blocked;
  // Keystrokes are taken one commit AFTER the owner was told (same batch as the chat
  // input disappearing), so no key can land in both inputs.
  const [ready, setReady] = useState(false);
  useEffect(() => { onActiveChange?.(active); setReady(active); }, [active]);
  useEffect(() => () => { onActiveChange?.(false); }, []);
  if (!req) return null;
  if (blocked) {
    return <Text color="magenta">🔐 A login request for {req.displayHost} is waiting — answer the prompt above first.</Text>;
  }
  return (
    <SecretInputForm
      key={req.id}
      request={req}
      focus={ready}
      onSubmit={values => broker.answer(req.id, values, 'terminal')}
      onCancel={() => { broker.cancel(req.id, 'terminal'); }}
    />
  );
}
