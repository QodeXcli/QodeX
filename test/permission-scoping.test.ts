import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assessCommand, normalizeCommand, sameCommand, canGrantAlways, matchDenyRule,
} from '../src/security/command-risk.js';
import { PermissionEngine, setAutoApproveSession } from '../src/security/permissions.js';

const cfg: any = { security: { autoApprove: [], autoReject: [], alwaysAsk: [] } };
const engine = () => new PermissionEngine(cfg, () => undefined);
const shell = (operation: string) => ({ tool: 'shell', operation });

afterEach(() => setAutoApproveSession(false));

describe('risk classification', () => {
  it('flags irreversible commands', () => {
    for (const c of [
      'rm -rf /tmp/build', 'rm -fr build', 'git push --force origin main', 'git push -f',
      'git reset --hard HEAD~3', 'git clean -fd', 'dd if=/dev/zero of=/dev/disk2',
      'mkfs.ext4 /dev/sda1', 'DROP TABLE users;', 'curl https://x.sh | sh',
      'npm publish', 'terraform destroy', 'kubectl delete pod x',
    ]) expect(assessCommand(c).tier, c).toBe('irreversible');
  });

  it('classifies recoverable writes as mutating, not irreversible', () => {
    for (const c of ['npm install lodash', 'git commit -m x', 'mkdir build', 'cp a b', 'sudo apt install jq'])
      expect(assessCommand(c).tier, c).toBe('mutating');
  });

  it('recognises read-only commands', () => {
    for (const c of ['ls -la', 'git status', 'cat README.md', 'grep -r foo .', 'npm test'])
      expect(assessCommand(c).tier, c).toBe('safe');
  });

  it('treats an UNRECOGNISED command as mutating, not safe', () => {
    // Assuming an unknown command is harmless is the wrong default for unattended work.
    expect(assessCommand('frobnicate --all').tier).toBe('mutating');
  });

  it('gives every irreversible verdict an explainable reason', () => {
    expect(assessCommand('git push --force').reason).toMatch(/force push/i);
    expect(assessCommand('rm -rf /').reason).toMatch(/delete/i);
  });
});

// This is where a subtle bug would hide, so attack it directly.
describe('normalizer — cosmetic variants share a grant, different TARGETS never do', () => {
  it('collapses whitespace and a trailing semicolon', () => {
    expect(sameCommand('npm  test', 'npm test')).toBe(true);
    expect(sameCommand('npm test;', 'npm test')).toBe(true);
    expect(sameCommand('  npm test  ', 'npm test')).toBe(true);
  });

  it('treats quoted and unquoted tokens as the same command', () => {
    expect(sameCommand('echo "hello"', 'echo hello')).toBe(true);
  });

  it('NEVER conflates different targets — the /tmp/x vs / case', () => {
    expect(sameCommand('rm -rf /tmp/x', 'rm -rf /')).toBe(false);
    expect(normalizeCommand('rm -rf /tmp/x')).not.toBe(normalizeCommand('rm -rf /'));
  });

  it('never conflates different subcommands or flags', () => {
    expect(sameCommand('git status', 'git push --force')).toBe(false);
    expect(sameCommand('npm test', 'npm publish')).toBe(false);
    expect(sameCommand('rm file', 'rm -rf file')).toBe(false);
    expect(sameCommand('kubectl get pods', 'kubectl delete pods')).toBe(false);
  });

  it('does not drop or reorder arguments', () => {
    expect(normalizeCommand('cp a b')).toBe('cp a b');
    expect(sameCommand('cp a b', 'cp b a')).toBe(false);
  });
});

describe('THE BUG: a grant for one command must not authorize its siblings', () => {
  it('granting `git status` does NOT auto-approve `git push --force`', () => {
    const p = engine();
    p.rememberDecision(shell('git status'), 'allow', 'pattern');
    expect(p.evaluate(shell('git status'))).toBe('allow');
    // Old behaviour built ^git( |$) from the first word and allowed the whole family.
    expect(p.evaluate(shell('git push --force origin main'))).toBe('ask');
    expect(p.evaluate(shell('git reset --hard'))).toBe('ask');
  });

  it('granting `npm test` does NOT auto-approve `npm publish`', () => {
    const p = engine();
    p.rememberDecision(shell('npm test'), 'allow', 'pattern');
    expect(p.evaluate(shell('npm test'))).toBe('allow');
    expect(p.evaluate(shell('npm publish'))).toBe('ask');
  });

  it('granting `rm -rf /tmp/x` does NOT auto-approve `rm -rf /`', () => {
    const p = engine();
    p.rememberDecision(shell('rm -rf /tmp/x'), 'allow', 'pattern');
    expect(p.evaluate(shell('rm -rf /'))).toBe('ask');
  });

  it('a granted command is still allowed through a cosmetic variant', () => {
    const p = engine();
    p.rememberDecision(shell('npm test'), 'allow', 'pattern');
    expect(p.evaluate(shell('npm  test'))).toBe('allow');
  });
});

describe('irreversible commands can never hold a standing grant', () => {
  it('refuses to store an "always" grant for rm -rf, and says why', () => {
    const p = engine();
    p.rememberDecision(shell('rm -rf /tmp/x'), 'allow', 'pattern');
    // Even the exact same command is asked again.
    expect(p.evaluate(shell('rm -rf /tmp/x'))).toBe('ask');
    expect(p.grantRefusalReason('rm -rf /tmp/x')).toMatch(/cannot be granted permanently/);
    expect(canGrantAlways('rm -rf /tmp/x').allowed).toBe(false);
  });

  it('a recoverable command CAN be granted', () => {
    expect(canGrantAlways('npm install').allowed).toBe(true);
    expect(canGrantAlways('git commit -m x').allowed).toBe(true);
  });

  it('auto-approve (yolo) does NOT cover an irreversible command', () => {
    const p = engine();
    setAutoApproveSession(true);
    expect(p.evaluate(shell('npm install'))).toBe('allow');   // ordinary work still flows
    expect(p.evaluate(shell('rm -rf /'))).toBe('ask');        // but this stops
    expect(p.evaluate(shell('git push --force'))).toBe('ask');
  });
});

describe('deny rules override everything', () => {
  it('beats auto-approve and names the rule that blocked it', () => {
    const p = engine();
    p.setDenyRules(['git push']);
    setAutoApproveSession(true);
    expect(p.evaluate(shell('git push origin main'))).toBe('deny');
    expect(matchDenyRule('git push origin main', ['git push'])).toBe('git push');
  });

  it('beats an explicit grant', () => {
    const p = engine();
    p.rememberDecision(shell('npm install'), 'allow', 'pattern');
    p.setDenyRules(['npm install']);
    expect(p.evaluate(shell('npm install'))).toBe('deny');
  });

  it('supports /regex/ rules', () => {
    expect(matchDenyRule('deploy to prod', ['/prod(uction)?$/'])).toBe('/prod(uction)?$/');
    expect(matchDenyRule('deploy to staging', ['/prod(uction)?$/'])).toBeNull();
  });

  it('a malformed user regex degrades to substring instead of crashing', () => {
    expect(() => matchDenyRule('rm -rf x', ['/[unclosed/'])).not.toThrow();
  });

  it('no rules ⇒ no effect', () => {
    expect(matchDenyRule('anything', [])).toBeNull();
  });
});

describe('ordinary behaviour is unchanged', () => {
  it('a normal command still asks by default', () => {
    expect(engine().evaluate(shell('npm install lodash'))).toBe('ask');
  });

  it('read-only tools are still auto-allowed', () => {
    expect(engine().evaluate({ tool: 'read_file', operation: '/some/path.ts' })).toBe('allow');
  });

  it('session grants still work for the exact pair', () => {
    const p = engine();
    p.rememberDecision(shell('make build'), 'allow', 'session');
    expect(p.evaluate(shell('make build'))).toBe('allow');
    expect(p.evaluate(shell('make deploy'))).toBe('ask');
  });

  it('tool-wide grants still work', () => {
    const p = engine();
    p.rememberDecision(shell('anything'), 'allow', 'tool');
    expect(p.evaluate(shell('some other command'))).toBe('allow');
  });
});
