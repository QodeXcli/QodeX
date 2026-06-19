/**
 * Basic smoke tests. Run with: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { TransactionJournal } from '../src/filesystem/transaction.js';

describe('TransactionJournal', () => {
  it('writes a file and records the transaction', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-test-'));
    const dbPath = path.join(tmpDir, 'txn.db');
    const blobsDir = path.join(tmpDir, 'blobs');
    const journal = new TransactionJournal(dbPath, blobsDir);

    const txn = await journal.begin('session-1');
    const filePath = path.join(tmpDir, 'hello.txt');
    await txn.write(filePath, 'hello world\n');
    await txn.commit('test write');

    const onDisk = await fs.readFile(filePath, 'utf-8');
    expect(onDisk).toBe('hello world\n');

    const recent = journal.listRecentTransactions('session-1');
    expect(recent.length).toBe(1);
    expect(recent[0].fileCount).toBe(1);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rolls back a session', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-test-'));
    const dbPath = path.join(tmpDir, 'txn.db');
    const blobsDir = path.join(tmpDir, 'blobs');
    const journal = new TransactionJournal(dbPath, blobsDir);

    const filePath = path.join(tmpDir, 'data.txt');
    await fs.writeFile(filePath, 'original\n');

    const txn = await journal.begin('session-rollback');
    await txn.write(filePath, 'modified\n');
    await txn.commit('first edit');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('modified\n');

    const result = await journal.rollbackSession('session-rollback');
    expect(result.txnsRolled).toBe(1);
    expect(result.filesRestored).toBe(1);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('original\n');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
