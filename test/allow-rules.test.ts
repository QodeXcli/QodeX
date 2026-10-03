import { describe, it, expect, afterEach } from 'vitest';
import { compileAllowRule, compileAllowRules, matchAllowRule } from '../src/security/allow-rules.js';
import { PermissionEngine, setApprovalMode } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

afterEach(() => setApprovalMode('manual'));

describe('compileAllowRule', () => {
  it('matches a literal prefix, not a sibling command', () => {
    const gitStatus = compileAllowRule('git status');
    expect(gitStatus('git status')).toBe(true);
    expect(gitStatus('git  status --short')).toBe(true);
    expect(gitStatus('git stash')).toBe(false);
    expect(gitStatus('git status-extra')).toBe(false);
    expect(gitStatus('git push --force')).toBe(false);
  });

  it('matches ls and npm test the way a user would write them', () => {
    const rules = compileAllowRules(['ls', 'npm test', 'npm run test']);
    expect(matchAllowRule('ls -la', rules)).toBe(true);
    expect(matchAllowRule('lsof', rules)).toBe(false);
    expect(matchAllowRule('npm test', rules)).toBe(true);
    expect(matchAllowRule('npm test -- --watch', rules)).toBe(true);
    expect(matchAllowRule('npm install', rules)).toBe(false);
  });

  it('accepts /regex/ and ^pattern forms', () => {
    expect(compileAllowRule('/^echo /')('echo hi')).toBe(true);
    expect(compileAllowRule('^pwd$')('pwd')).toBe(true);
    expect(compileAllowRule('^pwd$')('pwd -P')).toBe(false);
  });

  it('does not throw on a broken regex', () => {
    expect(() => compileAllowRule('/(unterminated')).not.toThrow();
    expect(compileAllowRule('/(unterminated')('anything')).toBe(false);
  });
});

describe('execution.allow in PermissionEngine', () => {
  function cfg(allow: string[]) {
    return {
      ...DEFAULT_CONFIG,
      security: { ...DEFAULT_CONFIG.security, autoApprove: [] },
      execution: { allow },
    };
  }

  it('lets a listed command skip the hub', () => {
    const engine = new PermissionEngine(cfg(['git status', 'npm test']));
    expect(engine.evaluateDetailed({ tool: 'bash', operation: 'git status' }))
      .toEqual({ decision: 'allow', via: 'allow-rule' });
    expect(engine.evaluate({ tool: 'bash', operation: 'npm test --silent' })).toBe('allow');
    expect(engine.evaluate({ tool: 'bash', operation: 'git push' })).toBe('ask');
  });

  it('does not outrank deny or irreversible', () => {
    const engine = new PermissionEngine(cfg(['rm -rf /', 'git push --force']));
    expect(engine.evaluate({ tool: 'bash', operation: 'rm -rf /' })).toBe('deny');
    expect(engine.evaluateDetailed({ tool: 'bash', operation: 'git push --force' }).via)
      .toBe('irreversible');
  });

  it('does not outrank always-ask', () => {
    const engine = new PermissionEngine(cfg(['sudo ls']));
    expect(engine.evaluateDetailed({ tool: 'bash', operation: 'sudo ls' }).via)
      .toBe('always-ask');
  });
});
