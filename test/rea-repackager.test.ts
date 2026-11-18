import { describe, it, expect } from 'vitest';
import {
  LiefPythonBridge,
  MobileRepackager,
  requireTool,
} from '../src/rea/repackager.js';

describe('requireTool', () => {
  it('resolves for a tool that exists', async () => {
    await requireTool('node');
  });

  it('throws naming the missing tool', async () => {
    await expect(requireTool('definitely-not-a-real-tool-xyz')).rejects.toThrow(
      /Required tool not found on PATH: definitely-not-a-real-tool-xyz/,
    );
  });
});

describe('LiefPythonBridge', () => {
  it('throws when the python binary does not exist', async () => {
    const bridge = new LiefPythonBridge('/nonexistent/python3');
    await expect(bridge.injectElfNeeded('/tmp/x.so', 'libfoo.so')).rejects.toThrow();
  });
});

describe('MobileRepackager', () => {
  it('repackageApk fails fast when apktool is missing (does not touch the input)', async () => {
    const repackager = new MobileRepackager();
    await expect(
      repackager.repackageApk(
        '/nonexistent/app.apk',
        '/nonexistent/gadget.so',
        'libmain.so',
        '/nonexistent/keystore.jks',
        'secret',
      ),
    ).rejects.toThrow();
  });
});
