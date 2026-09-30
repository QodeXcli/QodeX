#!/usr/bin/env node
import { loadDotEnv, readConfig } from './config.js';
import { createApp } from './app.js';

loadDotEnv();
const config = readConfig();
const { app } = await createApp(config);

app.listen(config.port, config.host, () => {
  console.log(`[qodex-pcb] ${config.siteName} listening on ${config.baseUrl}  (payments: ${config.payment.providers.join(', ')}, currency: ${config.currency})`);
  if (config.payment.providers.includes('mock')) {
    console.log('[qodex-pcb] The mock test checkout is enabled — no real money is charged. Disable it in production.');
  }
});
