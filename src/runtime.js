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
import { DoorbellHistory, parseEventTime } from './history.js';
import { fitJpeg } from './image.js';
import { MeariAuthError, MeariClient } from './meari/client.js';
import { decodeEventSnapshot } from './meari/crypto.js';
import { classifyAlarm, eventLogId, findImageUrl } from './meari/events.js';
import { AlarmListener } from './meari/listener.js';
import { HISTORY_SIZE, WIDGET_KEYS } from './widgets.js';

const logger = createLogger({ name: 'runtime' });

// How long the doorbell "ring" state stays at 1 after a press.
export const DOORBELL_RESET_MS = 5_000;
// The SDK admits 12 images/minute per camera: keep one every 5 s at most.
const IMAGE_MIN_INTERVAL_MS = 5_000;
// Gladys polls each device every minute; tolerate the tick drift.
const POLL_TOLERANCE_MS = 30_000;
// How far back the cloud event log is read to rebuild the doorbell history.
const HISTORY_SEED_DAYS = 7;
// An event time read from the cloud further than this from "now" is a clock
// mismatch, not the time of a live alarm.
const LIVE_EVENT_SKEW_MS = 10 * 60_000;

function dayString(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

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
   * @param {string|null} [deps.dataDir] persistence directory, null = memory
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
    // deviceID -> { dataUri, base64, key, at, source }
    this.snapshots = new Map();
    this.snapshotGeneration = 0;
    this.lastImagePublish = new Map();
    const dataDir = deps.dataDir !== undefined ? deps.dataDir : (process.env.DATA_DIR ?? '/data');
    this.history = new DoorbellHistory(dataDir);
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
    // In the background: a slow cloud must not delay the integration start.
    this.seedFromCloud().catch((err) => logger.warn(`History seeding failed: ${err.message}`));
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

  hasDoorbell(camera) {
    return hasDoorbell(camera, this.config);
  }

  /** Time of a live alarm: the cloud's when it is plausible, else now. */
  #alarmTime(event) {
    const now = Date.now();
    const parsed = parseEventTime(event.raw);
    return parsed !== null && Math.abs(now - parsed) < LIVE_EVENT_SKEW_MS ? parsed : now;
  }

  async handleAlarm(camera, event, image) {
    const ids = cameraIds(this.gladys, camera);
    const fitted = image ? this.#fit(image) : null;
    if (fitted) {
      await this.#setSnapshot(camera, fitted, event.kind === 'doorbell' ? 'doorbell' : 'motion', Date.now());
    }
    if (event.kind === 'doorbell') {
      const changed = this.history.add({
        id: event.eventId || undefined,
        deviceId: String(camera.deviceID),
        at: this.#alarmTime(event),
        image: fitted?.base64 ?? null,
      });
      // The second copy of a press (event log, with the picture) is not a new ring.
      if (!event.repeat) await this.#ring(camera, ids);
      if (changed) this.#refreshWidget(WIDGET_KEYS.HISTORY);
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

  #refreshWidget(key) {
    try {
      this.gladys.requestWidgetRefresh(key);
    } catch (err) {
      logger.debug(`requestWidgetRefresh ${key} failed: ${err.message}`);
    }
  }

  /** JPEG -> { dataUri, base64 } under the camera image budget, or null. */
  #fit(jpegBuffer) {
    const dataUri = fitJpeg(jpegBuffer);
    if (!dataUri) {
      logger.info('Snapshot could not be reduced under 150 KB, skipped');
      return null;
    }
    return { dataUri, base64: dataUri.slice(dataUri.indexOf(',') + 1) };
  }

  /** Install a new camera picture: camera feature + widget. */
  async #setSnapshot(camera, fitted, source, at) {
    const key = String(camera.deviceID);
    const current = this.snapshots.get(key);
    if (current && current.at > at) return false;
    this.snapshotGeneration += 1;
    this.snapshots.set(key, {
      ...fitted,
      at,
      source,
      key: `cam-${key}-${Date.now().toString(36)}-${this.snapshotGeneration}`.toLowerCase().slice(0, 64),
    });
    this.#refreshWidget(WIDGET_KEYS.CAMERA);
    const now = Date.now();
    if (now - (this.lastImagePublish.get(key) ?? 0) >= IMAGE_MIN_INTERVAL_MS) {
      this.lastImagePublish.set(key, now);
      try {
        await this.gladys.publishCameraImage(cameraIds(this.gladys, camera).device, fitted.dataUri);
      } catch (err) {
        logger.debug(`publishCameraImage failed: ${err.message}`);
      }
    }
    return true;
  }

  /** { key, at, source } of the current picture of a camera, or null. */
  snapshotInfo(camera) {
    const snap = this.snapshots.get(String(camera.deviceID));
    return snap ? { key: snap.key, at: snap.at, source: snap.source } : null;
  }

  /** onGetImage: the last picture (live capture is not supported yet). */
  getImage(device) {
    const camera = this.findCamera(device.external_id);
    if (!camera) {
      throw new Error('Unknown camera');
    }
    const snap = this.snapshots.get(String(camera.deviceID));
    if (!snap) {
      throw new Error('No snapshot yet: one is taken at the next motion or doorbell press');
    }
    return snap.dataUri;
  }

  /** onWidgetGetImage: raw base64 of a camera picture or a history picture. */
  getWidgetImage(key) {
    if (key.startsWith('cam-')) {
      for (const snap of this.snapshots.values()) {
        if (snap.key === key) return snap.base64;
      }
    } else if (key.startsWith('ring-')) {
      const image = this.history.image(key);
      if (image) return image;
    }
    throw new Error('Image no longer available');
  }

  // --- cloud event log (history, pictures) -------------------------------------

  async #downloadEventImage(camera, entry) {
    const url = findImageUrl(entry);
    if (!url) return null;
    const data = await this.client.downloadSnapshot(url);
    const jpeg = data ? decodeEventSnapshot(data, camera.snNum) : null;
    return jpeg ? this.#fit(jpeg) : null;
  }

  /**
   * Rebuild the doorbell history and the last picture of each camera from the
   * cloud event log, so both are filled right after a (re)start. Read-only on
   * the cloud: it never wakes a camera up.
   */
  async seedFromCloud() {
    const client = this.client;
    if (!client) return;
    let historyChanged = false;
    for (const camera of this.cameras()) {
      let presses = 0;
      let pictureDone = this.snapshots.has(String(camera.deviceID));
      for (let back = 0; back < HISTORY_SEED_DAYS; back += 1) {
        if (presses >= HISTORY_SIZE && pictureDone) break;
        let entries;
        try {
          entries = await client.getDeviceEvents(camera.deviceID, dayString(Date.now() - back * 86_400_000));
        } catch (err) {
          logger.debug(`Event log read failed: ${err.message}`);
          break;
        }
        if (this.client !== client) return; // session replaced meanwhile
        for (const entry of entries) {
          const at = parseEventTime(entry);
          if (!pictureDone && at !== null && findImageUrl(entry)) {
            const fitted = await this.#downloadEventImage(camera, entry);
            if (fitted) {
              await this.#setSnapshot(camera, fitted, 'history', at);
              pictureDone = true;
            }
          }
          if (presses < HISTORY_SIZE && at !== null && classifyAlarm(Number(entry.eventType)) === 'doorbell') {
            presses += 1;
            const fitted = await this.#downloadEventImage(camera, entry);
            historyChanged =
              this.history.add({
                id: eventLogId(entry) || undefined,
                deviceId: String(camera.deviceID),
                at,
                image: fitted?.base64 ?? null,
              }) || historyChanged;
          }
        }
      }
    }
    if (historyChanged) this.#refreshWidget(WIDGET_KEYS.HISTORY);
  }

  /** Widget button: look for a picture newer than the current one. */
  async refreshSnapshot(deviceExternalId) {
    const camera = this.findCamera(deviceExternalId);
    if (!camera || !this.client) return false;
    const current = this.snapshots.get(String(camera.deviceID));
    const entries = await this.client.getDeviceEvents(camera.deviceID, dayString(Date.now()));
    for (const entry of entries) {
      const at = parseEventTime(entry);
      if (at === null || (current && at <= current.at)) continue;
      const fitted = await this.#downloadEventImage(camera, entry);
      if (fitted) {
        const kind = classifyAlarm(Number(entry.eventType));
        return this.#setSnapshot(camera, fitted, kind === 'doorbell' ? 'doorbell' : 'motion', at);
      }
    }
    return false;
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
