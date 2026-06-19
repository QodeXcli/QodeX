/**
 * Tests for explainStreamError — clear user-facing provider error messages.
 * Run: node --experimental-strip-types test/explain-stream-error.test.ts
 */
import { explainStreamError } from '../src/agent/recovery.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— 429 rate limit —');
{
  const out = explainStreamError('429 Provider returned error');
  check('identifies rate limiting', /rate limited/i.test(out));
  check('says it is the provider, not QodeX', /not a QodeX error/i.test(out));
  check('mentions free/shared pools', /free|shared|contended/i.test(out));
  check('suggests switching model', /--model/.test(out));
  check('keeps the raw text', out.includes('429 Provider returned error'));
}
{
  check('matches "Too Many Requests"', /rate limited/i.test(explainStreamError('HTTP 429: Too Many Requests')));
  check('matches "rate limit" wording', /rate limited/i.test(explainStreamError('You hit the rate limit')));
}

console.log('— 401 auth —');
{
  const out = explainStreamError('401 Unauthorized: invalid api key');
  check('identifies auth failure', /authentication failed/i.test(out));
  check('mentions env var', /env var/i.test(out));
}

console.log('— 402 quota —');
{
  const out = explainStreamError('402 insufficient credit');
  check('identifies payment/quota', /payment\/quota/i.test(out));
}

console.log('— 5xx —');
{
  const out = explainStreamError('500 Internal Server Error');
  check('identifies server error', /provider server error/i.test(out));
}

console.log('— passthrough —');
{
  const out = explainStreamError('something weird happened');
  check('unknown errors pass through unchanged', out === 'something weird happened');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
