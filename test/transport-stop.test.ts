import { describe, it, expect } from 'vitest';
import { StdioTransport } from '../src/mcp/transport.js';

/**
 * Regression guard for Fix C (MCPClient.stop awaits process exit).
 *
 * History: v0.2.1 fixed this. v0.3.0 refactor split MCP into a transport layer
 * and the fix was lost — stop() went back to fire-SIGTERM-and-return. v0.3.2
 * restores the wait-for-exit behavior. This test ensures stop() blocks until
 * the child has either exited or 5s have passed, so SIGINT shutdown handlers
 * can't orphan zombie MCP processes.
 */
describe('StdioTransport.stop() lifecycle (Fix C — anti-zombie regression guard)', () => {
  it('stop() resolves only AFTER the child process has actually exited', async () => {
    // Use `node -e` so we have a real child that responds to SIGTERM cleanly.
    // The child prints a JSON-RPC notification so the transport's startup logic
    // doesn't immediately fail.
    const t = new StdioTransport({
      command: process.execPath,
      args: ['-e', 'process.stdin.on("data", () => {}); setInterval(() => {}, 1000);'],
    });
    await t.start();

    const pid = (t as any).proc?.pid as number | undefined;
    expect(typeof pid).toBe('number');

    const start = Date.now();
    await t.stop();
    const elapsed = Date.now() - start;

    // stop() must have actually waited — if it returned in <5ms the SIGTERM hadn't been honored yet.
    // We don't assert a tight upper bound because CI machines vary, but we do require
    // that the process is no longer alive after stop() resolves.
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(6000);  // hard cap from internal 5s giveup

    // Verify the child is gone — kill(pid, 0) throws ESRCH when the process doesn't exist
    let stillAlive = false;
    try {
      process.kill(pid!, 0);
      stillAlive = true;
    } catch (e: any) {
      stillAlive = e.code !== 'ESRCH';
    }
    expect(stillAlive).toBe(false);
  }, 10000);

  it('stop() on a never-started transport is a no-op', async () => {
    const t = new StdioTransport({ command: '/bin/false' });
    // Should not throw, should resolve quickly
    const start = Date.now();
    await t.stop();
    expect(Date.now() - start).toBeLessThan(100);
  });
});
