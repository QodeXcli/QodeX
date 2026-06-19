import { describe, it, expect } from 'vitest';
import { looksLikeBuildTask, looksLikeAdvisoryQuestion, isPlanningToolCall, PREFLIGHT_MESSAGE } from '../src/agent/preflight-gate.js';

describe('looksLikeBuildTask', () => {
  it('fires on strong build/architecture signals (EN + FA)', () => {
    expect(looksLikeBuildTask('build a heavy WordPress plugin with 200k lines')).toBe(true);
    expect(looksLikeBuildTask('set up a CI/CD pipeline for the repo')).toBe(true);
    expect(looksLikeBuildTask('refactor the auth module')).toBe(true);
    expect(looksLikeBuildTask('یه پلاگین وردپرس بساز')).toBe(true);
    expect(looksLikeBuildTask('معماری بک‌اند رو طراحی کن')).toBe(true);
  });

  it('does NOT fire on advisory / opinion questions even when they say "architecture"', () => {
    // The real case: an opinion question containing "معماری" must not be gated as a build.
    expect(looksLikeBuildTask('این سایت به چه معماری غیر از اینی که هست نیاز داره؟')).toBe(false);
    expect(looksLikeBuildTask('what architecture does this site need?')).toBe(false);
    expect(looksLikeBuildTask('what would you recommend for the backend architecture?')).toBe(false);
    expect(looksLikeBuildTask("what's wrong with this WordPress theme's architecture?")).toBe(false);
    // But a build ORDER that mentions architecture still fires.
    expect(looksLikeBuildTask('refactor the architecture into smaller modules')).toBe(true);
    expect(looksLikeBuildTask('معماری بک‌اند رو از نو طراحی کن')).toBe(true);
  });

  it('looksLikeAdvisoryQuestion: question/opinion vs build order', () => {
    expect(looksLikeAdvisoryQuestion('what do you think we should change?')).toBe(true);
    expect(looksLikeAdvisoryQuestion('به نظرت چی نیاز داره؟')).toBe(true);
    expect(looksLikeAdvisoryQuestion('build a dashboard')).toBe(false); // imperative overrides
    expect(looksLikeAdvisoryQuestion('یه پلاگین بساز')).toBe(false);
  });

  it('does NOT fire on trivial edits', () => {
    expect(looksLikeBuildTask('fix this typo')).toBe(false);
    expect(looksLikeBuildTask('rename the variable foo to bar')).toBe(false);
    expect(looksLikeBuildTask('what does this function do?')).toBe(false);
    expect(looksLikeBuildTask('')).toBe(false);
  });

  it('stays conservative on small backend prompts but fires on big ones', () => {
    // Matches the live recon: a tiny 2-endpoint API should NOT be gated.
    expect(looksLikeBuildTask('build a small REST API with two endpoints and an in-memory store')).toBe(false);
    // A substantial backend build (>120 chars, several weak signals) SHOULD be gated.
    expect(looksLikeBuildTask(
      'build a REST API with CRUD endpoints, JWT authentication, a postgres data model, and rate limiting for the orders microservice please',
    )).toBe(true);
  });

  it('needs two weak signals AND length for a weak-only prompt', () => {
    expect(looksLikeBuildTask('create x')).toBe(false); // single weak, short
    // two weak signals but short → still no
    expect(looksLikeBuildTask('build create')).toBe(false);
    // two weak signals + long enough → yes
    const long = 'please create the endpoint and implement the handler with validation and tests and wire it into the existing router carefully';
    expect(looksLikeBuildTask(long)).toBe(true);
  });
});

describe('isPlanningToolCall', () => {
  it('treats present_plan and todo_write as planning', () => {
    expect(isPlanningToolCall('present_plan', {})).toBe(true);
    expect(isPlanningToolCall('todo_write', { items: [] })).toBe(true);
  });

  it('treats writing a DESIGN/PLAN/ARCHITECTURE doc as planning', () => {
    expect(isPlanningToolCall('write_file', { path: 'DESIGN.md' })).toBe(true);
    expect(isPlanningToolCall('write_file', { path: 'docs/architecture.md' })).toBe(true);
    expect(isPlanningToolCall('create_file', { path: 'PLAN.md' })).toBe(true);
    expect(isPlanningToolCall('write_file', { file: 'rfc-001.markdown' })).toBe(true);
  });

  it('does NOT treat a normal source write as planning', () => {
    expect(isPlanningToolCall('write_file', { path: 'src/api/users.ts' })).toBe(false);
    expect(isPlanningToolCall('edit_text', { path: 'app/models.py' })).toBe(false);
    expect(isPlanningToolCall('bash', { command: 'rm x' })).toBe(false);
  });
});

describe('PREFLIGHT_MESSAGE', () => {
  it('explains the one-shot, non-blocking nature and points to orchestrate', () => {
    expect(PREFLIGHT_MESSAGE).toContain('ARCHITECTURE_GATE');
    expect(PREFLIGHT_MESSAGE).toContain('orchestrate');
    expect(PREFLIGHT_MESSAGE.toLowerCase()).toContain('once per task');
  });
});
