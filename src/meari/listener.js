// -----------------------------------------------------------------------------
// Account-scoped alarm listener: MQTT push + cloud event-log polling.
//
// Why both (see docs/motion-events.md of Ha-CloudPlus-Meari):
//   - MQTT is the low-latency path (sub-second), but the broker pins the
//     client id to the account user id: if the phone app is logged in with
//     the SAME account, the two sessions evict each other.
//   - Polling the per-device event log (/v3/app/event/list) every 15 s always
//     works, whoever owns the MQTT session.
// The same alarm can therefore arrive twice: dispatches of the same kind on
// the same camera are merged inside a short window.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { formatSn } from './client.js';
import { decodeEventSnapshot } from './crypto.js';
import { MqttSubscriber } from './mqtt.js';
import { eventLogId, parseAlarmEvent } from './events.js';

const logger = createLogger({ name: 'meari-events' });

export const POLL_INTERVAL_MS = 15_000;
const POLL_ERROR_INTERVAL_MS = 60_000;
// An alarm seen by MQTT shows up in the event log up to one poll later.
export const MERGE_WINDOW_MS = 45_000;
const SEEN_CAP = 4000;

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function eventTopics(client) {
  const userId = String(client.userId ?? '').trim();
  if (!userId) return [];
  const prefixes = [userId];
  const clientId = String(client.clientId ?? '').trim();
  if (clientId && clientId !== userId) prefixes.unshift(clientId);
  return [...new Set(prefixes.map((p) => `$bsssvr/iot/${p}/${userId}/event/update/accepted`))];
}

export class AlarmListener {
  /**
   * @param {object} options
   * @param {import('./client.js').MeariClient} options.client logged-in client
   * @param {(camera: object, event: object, image: Buffer|null) => Promise<void>|void} options.onAlarm
   * @param {boolean} [options.useMqtt]
   * @param {Function} [options.mqttFactory] injected in tests
   * @param {() => number} [options.now]
   */
  constructor({ client, onAlarm, useMqtt = true, mqttFactory, now = () => Date.now() }) {
    this.client = client;
    this.onAlarm = onAlarm;
    this.useMqtt = useMqtt;
    this.mqttFactory = mqttFactory ?? ((opts) => new MqttSubscriber(opts));
    this.now = now;
    this.seen = new Set();
    this.day = '';
    this.seeded = false;
    this.lastDispatch = new Map();
    this.timer = null;
    this.mqtt = null;
    this.stopped = true;
    this.mqttConnected = false;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#schedulePoll(0);
    if (this.useMqtt) this.#startMqtt();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.mqtt?.stop();
    this.mqtt = null;
    this.mqttConnected = false;
  }

  /** Transport currently delivering alarms, for the status badge. */
  get mode() {
    return this.mqttConnected ? 'push' : 'poll';
  }

  #startMqtt() {
    const topics = eventTopics(this.client);
    if (!this.client.mqttHost || !this.client.mqttSignature || topics.length === 0) {
      logger.info('MQTT credentials unavailable, alarms rely on cloud polling only');
      return;
    }
    const mqtt = this.mqttFactory({
      host: this.client.mqttHost,
      port: this.client.mqttPort,
      clientId: String(this.client.userId),
      username: this.client.accessId,
      password: this.client.mqttSignature,
      topics,
      keepalive: 300,
      // The Meari broker certificate does not validate against public CAs
      // (the official apps and Ha-CloudPlus-Meari skip verification too).
      rejectUnauthorized: false,
    });
    let warned = false;
    mqtt.on('connect', () => {
      warned = false;
      this.mqttConnected = true;
      logger.info('MQTT push connected');
    });
    mqtt.on('close', (wasConnected) => {
      this.mqttConnected = false;
      if (wasConnected) {
        logger.info('MQTT push disconnected (another login on the same account?), polling continues');
      }
    });
    mqtt.on('connack-refused', (reason) => {
      if (!warned) {
        warned = true;
        logger.warn(`MQTT push refused (${reason}), polling continues`);
      }
    });
    mqtt.on('error', (err) => logger.debug(`MQTT error: ${err.message}`));
    mqtt.on('message', (_topic, payload) => {
      this.handlePayload(payload, 'push').catch((err) =>
        logger.error('MQTT alarm handling failed', err),
      );
    });
    mqtt.start();
    this.mqtt = mqtt;
  }

  /** Refresh the MQTT credentials after a re-login. */
  refreshCredentials() {
    this.mqtt?.setCredentials(this.client.accessId, this.client.mqttSignature);
  }

  #schedulePoll(delayMs) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      let next = POLL_INTERVAL_MS;
      try {
        await this.pollOnce();
      } catch (err) {
        logger.warn(`Alarm poll failed: ${err.message}`);
        next = (await this.#relogin()) ? POLL_INTERVAL_MS : POLL_ERROR_INTERVAL_MS;
      }
      this.#schedulePoll(next);
    }, delayMs);
    this.timer.unref?.();
  }

  async #relogin() {
    try {
      await this.client.login();
      this.refreshCredentials();
      logger.info('Cloud session re-authenticated');
      return true;
    } catch (err) {
      logger.warn(`Re-authentication failed: ${err.message}`);
      return false;
    }
  }

  /**
   * One pass over every camera's event log. The very first pass only records
   * the existing events (no replay of today's history at startup).
   */
  async pollOnce() {
    const day = localDay(new Date(this.now()));
    if (day !== this.day) {
      this.day = day;
      this.seen.clear();
    }
    const cameras = this.client.cameras();
    let anyOk = cameras.length === 0;
    let lastError = null;
    for (const camera of cameras) {
      let entries;
      try {
        entries = await this.client.getDeviceEvents(camera.deviceID, day);
      } catch (err) {
        lastError = err;
        continue;
      }
      anyOk = true;
      // Oldest first, so several new alarms dispatch in chronological order.
      for (const entry of [...entries].reverse()) {
        if (!entry || typeof entry !== 'object') continue;
        const id = eventLogId(entry);
        if (!id) continue;
        const key = `${camera.deviceID}:${id}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (this.seeded) {
          await this.handlePayload({ deviceID: camera.deviceID, ...entry }, 'poll');
        }
      }
    }
    if (this.seen.size > SEEN_CAP) {
      this.seen = new Set([...this.seen].slice(-SEEN_CAP));
    }
    if (!anyOk) {
      throw lastError ?? new Error('event log unavailable');
    }
    this.seeded = true;
  }

  #findCamera(event) {
    const cameras = this.client.cameras();
    if (event.deviceId) {
      const byId = cameras.find((c) => String(c.deviceID) === event.deviceId);
      if (byId) return byId;
    }
    if (event.licenseId) {
      // The serial comes either as the app's snNum or as the IoT uuid.
      return (
        cameras.find((c) => c.snNum === event.licenseId || formatSn(c.snNum) === event.licenseId) ??
        null
      );
    }
    return null;
  }

  /** Parse, route and dispatch one alarm payload. Returns true when dispatched. */
  async handlePayload(payload, source) {
    const event = parseAlarmEvent(payload);
    if (!event) return false;
    const camera = this.#findCamera(event);
    if (!camera) return false;

    if (event.kind === 'other') {
      // Logged (without ids) so unknown doorbell/alarm codes can be mapped.
      logger.info(`Ignored alarm "${event.alarmName}" (type ${event.alarmType}) via ${source}`);
      return false;
    }

    // Same kind on the same camera within the window: the second copy of one
    // alarm (push then poll), or a burst. A doorbell press is dropped; a
    // motion is still forwarded flagged `repeat`, so it extends the motion
    // state without firing a new scene event.
    const mergeKey = `${camera.deviceID}:${event.kind}`;
    const last = this.lastDispatch.get(mergeKey);
    const now = this.now();
    const repeat = last !== undefined && now - last < MERGE_WINDOW_MS;
    if (repeat && event.kind === 'doorbell') {
      logger.debug(`Duplicate doorbell press merged (${source})`);
      return false;
    }
    if (!repeat) this.lastDispatch.set(mergeKey, now);

    let image = null;
    if (event.imageUrl) {
      const data = await this.client.downloadSnapshot(event.imageUrl);
      image = data ? decodeEventSnapshot(data, camera.snNum) : null;
    }
    logger.info(
      `${event.kind} alarm "${event.alarmName}" via ${source}${repeat ? ' (repeat)' : ''}` +
        `${image ? ' with snapshot' : ''}`,
    );
    await this.onAlarm(camera, { ...event, source, repeat }, image);
    return true;
  }
}
