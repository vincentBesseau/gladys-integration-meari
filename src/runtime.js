// -----------------------------------------------------------------------------
// Runtime of the integration: one Meari cloud session (the configured
// account), its alarm listener, and the per-camera live state (motion and
// doorbell timers, last image). index.js only wires the SDK to this class.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasCredentials, normalizeConfig, sessionKey } from './config.js';
import {
  FEATURE,
  SCENE_TRIGGERS,
  batteryStates,
  buildCameraDevice,
  cameraIds,
  hasDoorbell,
  switchForFeature,
  switchStates,
  IOT_SWITCHES,
} from './camera.js';
import { fitJpeg } from './image.js';
import { MeariAuthError, MeariClient } from './meari/client.js';
import { AlarmListener } from './meari/listener.js';

const logger = createLogger({ name: 'runtime' });

// How long the doorbell "ring" state stays at 1 after a press.
export const DOORBELL_RESET_MS = 5_000;
// The SDK admits 12 images/minute per camera: keep one every 5 s at most.
const IMAGE_MIN_INTERVAL_MS = 5_000;
// Gladys polls each device every minute; tolerate the tick drift.
const POLL_TOLERANCE_MS = 30_000;

const NOT_CONFIGURED = {
  en: 'Enter the e-mail and password of your ieGeek Cam account.',
  fr: 'Renseignez l’e-mail et le mot de passe de votre compte ieGeek Cam.',
};
const AUTH_FAILED = {
  en: 'Login refused: check the e-mail, the password and the app (profile).',
  fr: 'Connexion refusée : vérifiez l’e-mail, le mot de passe et l’application (profil).',
};
const CLOUD_UNREACHABLE = {
  en: 'The ieGeek cloud could not be reached, retrying in one minute.',
  fr: 'Le cloud ieGeek est injoignable, nouvelle tentative dans une minute.',
};

export class Runtime {
  /**
   * @param {object} gladys SDK instance
   * @param {object} [deps] injected in tests
   * @param {(config: object) => MeariClient} [deps.createClient]
   * @param {(options: object) => AlarmListener} [deps.createListener]
   */
  constructor(gladys, deps = {}) {
    this.gladys = gladys;
    this.createClient =
      deps.createClient ??
      ((config) =>
        new MeariClient({
          email: config.email,
          password: config.password,
          countryCode: config.country_code,
          phoneCode: config.phone_code,
          appProfile: config.app_profile,
        }));
    this.createListener = deps.createListener ?? ((options) => new AlarmListener(options));
    this.config = normalizeConfig();
    this.session = '';
    this.client = null;
    this.listener = null;
    this.retryTimer = null;
    this.motionTimers = new Map();
    this.doorbellTimers = new Map();
    this.motionActive = new Set();
    this.images = new Map();
    this.lastImagePublish = new Map();
    this.lastPolls = new Map();
    this.iotByCamera = new Map();
  }

  // --- lifecycle -------------------------------------------------------------

  /** Apply a (new) configuration: (re)open the cloud session when needed. */
  async applyConfig(rawConfig) {
    const config = normalizeConfig(rawConfig);
    const changed = sessionKey(config) !== this.session;
    this.config = config;
    if (!changed && this.client?.loggedIn) {
      // Only presentation settings changed (doorbell feature, timers).
      await this.publishDevices();
      return;
    }
    await this.start();
  }

  async start() {
    this.stop();
    const config = this.config;
    this.session = sessionKey(config);
    if (!hasCredentials(config)) {
      await this.#status(false, NOT_CONFIGURED);
      return;
    }
    const client = this.createClient(config);
    try {
      await client.login();
    } catch (err) {
      if (err instanceof MeariAuthError) {
        logger.warn(err.message);
        await this.#status(false, AUTH_FAILED);
        return;
      }
      logger.warn(`Cloud login failed: ${err.message}`);
      await this.#status(false, CLOUD_UNREACHABLE);
      this.retryTimer = setTimeout(() => this.start().catch(() => {}), 60_000);
      this.retryTimer.unref?.();
      return;
    }
    this.client = client;
    const cameras = client.cameras();
    logger.info(
      `Logged in, ${cameras.length} camera(s): ` +
        cameras.map((c) => `${c._category}${c.deviceModel ? `/${c.deviceModel}` : ''}`).join(', '),
    );
    await this.publishDevices();
    this.listener = this.createListener({
      client,
      useMqtt: config.use_push,
      onAlarm: (camera, event, image) => this.handleAlarm(camera, event, image),
    });
    this.listener.start();
    await this.#status(true);
  }

  stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.listener?.stop();
    this.listener = null;
    for (const t of [...this.motionTimers.values(), ...this.doorbellTimers.values()]) {
      clearTimeout(t);
    }
    this.motionTimers.clear();
    this.doorbellTimers.clear();
    this.motionActive.clear();
    this.client = null;
  }

  async #status(connected, message) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      logger.debug(`setConnectionStatus failed: ${err.message}`);
    }
  }

  // --- discovery -------------------------------------------------------------

  cameras() {
    return this.client?.cameras() ?? [];
  }

  findCamera(externalId) {
    return this.cameras().find((c) => cameraIds(this.gladys, c).device === externalId) ?? null;
  }

  async buildDevices() {
    const devices = [];
    for (const camera of this.cameras()) {
      let iot = this.iotByCamera.get(String(camera.deviceID));
      if (!iot) {
        try {
          iot = await this.client.getIotConfig(camera.snNum);
          this.iotByCamera.set(String(camera.deviceID), iot);
        } catch (err) {
          // The device still works (motion, doorbell, image): only the
          // settings switches are left out until the next discovery.
          logger.info(`IoT settings unavailable for a camera: ${err.message}`);
          iot = {};
        }
      }
      devices.push(buildCameraDevice(this.gladys, camera, this.config, iot));
    }
    return devices;
  }

  async publishDevices() {
    if (!this.client) return;
    await this.gladys.publishDiscoveredDevices(await this.buildDevices());
  }

  /** Scan button: refresh the camera list from the cloud, then publish. */
  async scan() {
    if (!this.client) {
      await this.start();
      return;
    }
    await this.client.refreshDevices();
    this.iotByCamera.clear();
    await this.publishDevices();
  }

  // --- alarms ----------------------------------------------------------------

  async handleAlarm(camera, event, image) {
    const ids = cameraIds(this.gladys, camera);
    if (image) {
      await this.#storeImage(camera, image);
    }
    if (event.kind === 'doorbell') {
      await this.#ring(camera, ids);
    } else if (event.kind === 'motion') {
      await this.#motion(camera, ids, event);
    }
  }

  async #ring(camera, ids) {
    const key = String(camera.deviceID);
    if (hasDoorbell(camera, this.config)) {
      await this.#publishState(ids.feature(FEATURE.DOORBELL), 1);
      clearTimeout(this.doorbellTimers.get(key));
      const t = setTimeout(() => {
        this.doorbellTimers.delete(key);
        this.#publishState(ids.feature(FEATURE.DOORBELL), 0).catch(() => {});
      }, DOORBELL_RESET_MS);
      t.unref?.();
      this.doorbellTimers.set(key, t);
    }
    // The scene trigger fires for every camera: a firmware may report a press
    // on a device the cloud does not classify as a doorbell.
    await this.#sceneEvent(SCENE_TRIGGERS.DOORBELL, { device: ids.device });
  }

  async #motion(camera, ids, event) {
    const key = String(camera.deviceID);
    const isNew = !this.motionActive.has(key);
    this.motionActive.add(key);
    if (isNew) {
      await this.#publishState(ids.feature(FEATURE.MOTION), 1);
      await this.#sceneEvent(SCENE_TRIGGERS.MOTION, {
        device: ids.device,
        target: event.person ? 'person' : 'motion',
      });
    }
    // Every alarm (new or repeat) extends the detection.
    clearTimeout(this.motionTimers.get(key));
    const t = setTimeout(() => {
      this.motionTimers.delete(key);
      this.motionActive.delete(key);
      this.#publishState(ids.feature(FEATURE.MOTION), 0).catch(() => {});
    }, this.config.motion_timeout * 1000);
    t.unref?.();
    this.motionTimers.set(key, t);
  }

  async #publishState(featureExternalId, value) {
    try {
      await this.gladys.publishState(featureExternalId, value);
    } catch (err) {
      // 404 when the user did not create the device in Gladys: not an error.
      logger.debug(`publishState failed: ${err.message}`);
    }
  }

  async #sceneEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.debug(`publishSceneEvent ${key} failed: ${err.message}`);
    }
  }

  async #storeImage(camera, jpegBuffer) {
    const image = fitJpeg(jpegBuffer);
    if (!image) {
      logger.info('Event snapshot could not be reduced under 150 KB, skipped');
      return;
    }
    const key = String(camera.deviceID);
    this.images.set(key, image);
    const now = Date.now();
    if (now - (this.lastImagePublish.get(key) ?? 0) < IMAGE_MIN_INTERVAL_MS) return;
    this.lastImagePublish.set(key, now);
    try {
      await this.gladys.publishCameraImage(cameraIds(this.gladys, camera).device, image);
    } catch (err) {
      logger.debug(`publishCameraImage failed: ${err.message}`);
    }
  }

  /** onGetImage: the last event snapshot (live capture is not supported yet). */
  getImage(device) {
    const camera = this.findCamera(device.external_id);
    if (!camera) {
      throw new Error('Unknown camera');
    }
    const image = this.images.get(String(camera.deviceID));
    if (!image) {
      throw new Error('No snapshot yet: one is taken at the next motion or doorbell press');
    }
    return image;
  }

  // --- polling and commands --------------------------------------------------

  /** onPoll: battery and settings from the cloud cache, at the user's pace. */
  async poll(device) {
    const camera = this.findCamera(device.external_id);
    if (!camera || !this.client) return false;
    const key = String(camera.deviceID);
    const now = Date.now();
    const last = this.lastPolls.get(key);
    if (last !== undefined && now - last < this.config.poll_frequency * 1000 - POLL_TOLERANCE_MS) {
      return false;
    }
    this.lastPolls.set(key, now);

    const states = [];
    try {
      states.push(...batteryStates(this.gladys, camera, await this.client.getBatteryInfo(camera.snNum)));
    } catch (err) {
      logger.debug(`Battery read failed: ${err.message}`);
    }
    const knownIot = this.iotByCamera.get(key) ?? {};
    if (IOT_SWITCHES.some((sw) => knownIot[String(sw.code)] !== undefined)) {
      try {
        const iot = await this.client.getIotConfig(camera.snNum);
        this.iotByCamera.set(key, iot);
        states.push(...switchStates(this.gladys, camera, iot));
      } catch (err) {
        logger.debug(`Settings read failed: ${err.message}`);
      }
    }
    if (states.length > 0) {
      await this.gladys.publishChangedStates(states);
    }
    return true;
  }

  /** onSetValue: write a camera setting (switch). */
  async setValue(device, feature, value) {
    const camera = this.findCamera(device.external_id);
    if (!camera || !this.client) {
      throw new Error('Camera unavailable');
    }
    const sw = switchForFeature(this.gladys, camera, feature.external_id);
    if (!sw) {
      throw new Error(`Feature ${feature.external_id} is read-only`);
    }
    const target = Number(value) > 0 ? 1 : 0;
    await this.client.setIotValue(camera.snNum, sw.code, target);
    const iot = this.iotByCamera.get(String(camera.deviceID));
    if (iot) iot[String(sw.code)] = target;
    await this.gladys.publishState(feature.external_id, target);
  }

  // --- manifest action -------------------------------------------------------

  async testConnection() {
    const config = this.config;
    if (!hasCredentials(config)) {
      return NOT_CONFIGURED;
    }
    const client = this.createClient(config);
    try {
      await client.login();
    } catch (err) {
      return err instanceof MeariAuthError
        ? AUTH_FAILED
        : { en: `Cloud unreachable: ${err.message}`, fr: `Cloud injoignable : ${err.message}` };
    }
    const cameras = client.cameras();
    const names = cameras.map((c) => c.deviceName || c.snNum).join(', ');
    return {
      en: `Connected: ${cameras.length} camera(s) found${names ? ` (${names})` : ''}.`,
      fr: `Connecté : ${cameras.length} caméra(s) trouvée(s)${names ? ` (${names})` : ''}.`,
    };
  }
}
