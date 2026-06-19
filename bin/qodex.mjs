#!/usr/bin/env node
import('../dist/index.js').catch((err) => {
  console.error('QodeX failed to start:', err.message);
  if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
    console.error('\nIt looks like the build is missing. Run:');
    console.error('  npm run build\n');
  }
  process.exit(1);
});
