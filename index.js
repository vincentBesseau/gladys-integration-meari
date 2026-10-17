// -----------------------------------------------------------------------------
// Entry point of the ieGeek Cam external integration for Gladys Assistant.
//
// SDK wiring only: every handler is registered BEFORE connect(), the work is
// done by src/runtime.js (cloud session, alarms, cameras).
// Environment (injected by the Gladys supervisor): GLADYS_HOST_API_URL,
// GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { Runtime } from './src/runtime.js';
import { registerWidgets } from './src/widgets.js';

const gladys = new GladysIntegration();
const runtime = new Runtime(gladys);

gladys.onScanRequest(async () => {
  logger.info('Scan requested');
  await runtime.scan();
});

gladys.onSetValue((device, feature, value) => runtime.setValue(device, feature, value));

// Awaited up to 15 s by Gladys: we answer from the snapshot cache.
gladys.onGetImage(async (device) => runtime.getImage(device));

gladys.onPoll(async (device) => {
  await runtime.poll(device);
});

gladys.onAction('test_connection', () => runtime.testConnection());

// Dashboard widgets: content, button actions, images by key.
registerWidgets(gladys, runtime);

gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration updated');
  await runtime.applyConfig(config);
});

gladys.on('connected', async () => {
  try {
    // A reconnection of the Gladys socket does not need a new cloud session.
    await runtime.applyConfig(await gladys.getConfig());
  } catch (err) {
    logger.error('Initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal}, stopping`);
  runtime.stop();
});

logger.info('Starting the ieGeek Cam integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
