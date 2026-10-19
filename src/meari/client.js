// -----------------------------------------------------------------------------
// HTTP client of the Meari cloud (the platform behind the ieGeek Cam app).
//
// Ported from the MIT-licensed Home Assistant integration
// https://github.com/Uxzylon/Ha-CloudPlus-Meari (api.py). The flow is:
//   redirect (find the regional API server) -> login -> platform init
//   (OpenAPI + MQTT credentials) -> device list.
// Every request is signed: query/form params with HMAC-SHA1(userToken), plus
// X-Ca-* headers.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  decryptPlatformSignature,
  desEncrypt,
  encodeUserAccount,
  hmacSha1Base64,
  md5Hex,
} from './crypto.js';

const logger = createLogger({ name: 'meari-client' });

const DEFAULT_CA_KEY = 'bc29be30292a4309877807e101afbd51';
const DEFAULT_CA_SECRET = '35a69fd1-6527-4566-b190-921f9a651488';
const REDIRECT_URL = 'https://apis.cloudedge360.com';
const PHONE_TYPE = 'a';
const TTID = 'a';
const USER_AGENT =
  'Mozilla/5.0 (Linux; U; Android 14; en-us; Pixel Build/UP1A.231105.001) ' +
  'AppleWebKit/533.1 (KHTML, like Gecko) Version/5.0 Mobile Safari/533.1';
const HTTP_TIMEOUT_MS = 30_000;

// Wire identity of each official app of the Meari family: the server requires
// the identity of the app the account was created with.
export const APP_PROFILES = {
  iegeek: { sourceApp: '81', appVer: '5.5.2', appVerCode: '552', partnerId: '81' },
  cloudedge: {
    sourceApp: '8',
    appVer: '6.1.4',
    appVerCode: '616',
    partnerId: '8',
    encryptedLogin: true,
  },
  cloudplus: { sourceApp: '77', appVer: '6.0.1', appVerCode: '1029', partnerId: '77' },
  anran: {
    sourceApp: '84',
    appVer: '6.2.0',
    appVerCode: '1069',
    partnerId: '84',
    encryptedLogin: true,
  },
  boifun: {
    sourceApp: '104',
    appVer: '6.2.0',
    appVerCode: '1039',
    partnerId: '104',
    encryptedLogin: true,
  },
  arenti: {
    sourceApp: '39',
    appVer: '5.0.3',
    appVerCode: '168',
    partnerId: '39',
    redirectUrl: 'https://apis.arenti.net',
    encryptedLogin: true,
  },
};

const PLATFORM_REGIONS = new Set(['eu', 'us', 'as', 'cn']);

const DEVICE_CATEGORIES = [
  'ipc',
  'snap',
  'doorbell',
  'voiceBell',
  'fourthGeneration',
  'cellular',
  'light',
  'pictureDoorBell',
  'nvr',
  'nvr-neutral',
  'base',
  'chime',
];
const CAMERA_CATEGORIES = new Set([
  'ipc',
  'snap',
  'doorbell',
  'voicebell',
  'fourthgeneration',
  'cellular',
  'light',
  'picturedoorbell',
]);
export const DOORBELL_CATEGORIES = new Set(['doorbell', 'voicebell', 'picturedoorbell']);

// IoT codes (see the official app's command table).
export const IOT = {
  LED_ENABLE: 103,
  MOTION_DET_ENABLE: 106,
  HUMAN_DET_ENABLE: 108,
  PIR_DET_ENABLE: 150,
  SPEAK_VOLUME: 152,
  POWER_TYPE: 153,
  BATTERY_PERCENT: 154,
  BATTERY_REMAINING: 155,
  CHARGE_STATUS: 156,
  WIFI_SIGNAL: 1007,
};
const BATTERY_CODES = '153,154,155,156,1007';

/** snNum -> IoT device uuid. */
export function formatSn(sn) {
  if (!sn) {
    return '';
  }
  return sn.length === 9 ? `0000000${sn}` : sn.slice(4);
}

function hostOf(url) {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function regionCode(...hints) {
  for (const hint of hints) {
    if (!hint) continue;
    const host = hostOf(hint).replaceAll('-', '.');
    for (const part of host.split('.')) {
      if (PLATFORM_REGIONS.has(part)) return part;
      if (part.length >= 4 && PLATFORM_REGIONS.has(part.slice(0, 2)) && part.slice(2) === 'ce') {
        return part.slice(0, 2);
      }
    }
  }
  return '';
}

/** Some accounts store a typographic apostrophe the user types as ASCII (or the reverse). */
export function passwordVariants(password) {
  const variants = [password];
  if (password.includes("'")) variants.push(password.replaceAll("'", '’'));
  if (password.includes('’')) variants.push(password.replaceAll('’', "'"));
  if (password.includes('‘')) variants.push(password.replaceAll('‘', "'"));
  return [...new Set(variants)];
}

/** `2026-10-18T01:30:00.123GMT+02:00`, the local timestamp format of the apps. */
export function meariTimestamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const hours = Math.trunc(Math.abs(offsetMin) / 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}GMT${sign}${pad(hours)}:00`
  );
}

/** Collect devices from the (deeply nested, category-keyed) device-list payloads. */
export function collectDevices(payload, target = new Map(), homeId = null) {
  const categoryByKey = new Map(DEVICE_CATEGORIES.map((c) => [c.toLowerCase(), c]));

  const inferCategory = (dev, current) => {
    if (current) return current;
    return Number(dev.devTypeID) === 5 ? 'snap' : 'ipc';
  };

  const addDevice = (dev, category) => {
    if (!dev || typeof dev !== 'object' || Array.isArray(dev)) return;
    if (dev.deviceID === undefined || dev.deviceID === null || !dev.snNum) return;
    const normalized = { ...dev, _category: inferCategory(dev, category) };
    if (homeId) normalized._homeId = homeId;
    target.set(String(dev.deviceID), normalized);
  };

  const walk = (node, category = null) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        addDevice(item, category);
        walk(item, category);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const childCategory = categoryByKey.get(String(key).toLowerCase()) ?? null;
      if (childCategory && Array.isArray(value)) {
        for (const item of value) addDevice(item, childCategory);
        continue;
      }
      if (key === 'deviceList' && Array.isArray(value)) {
        for (const item of value) addDevice(item, category);
        continue;
      }
      walk(value, childCategory ?? category);
    }
  };

  walk(payload);
  return target;
}

export function isCameraDevice(dev) {
  return CAMERA_CATEGORIES.has(String(dev._category ?? '').toLowerCase());
}

export function isDoorbellDevice(dev) {
  return DOORBELL_CATEGORIES.has(String(dev._category ?? '').toLowerCase());
}

export class MeariAuthError extends Error {}

export class MeariClient {
  /**
   * @param {object} options
   * @param {string} options.email
   * @param {string} options.password
   * @param {string} [options.countryCode]
   * @param {string} [options.phoneCode]
   * @param {string} [options.appProfile]
   * @param {typeof fetch} [options.fetch] injected in tests
   */
  constructor({
    email,
    password,
    countryCode = 'FR',
    phoneCode = '33',
    appProfile = 'iegeek',
    fetch: fetchImpl,
  } = {}) {
    this.email = email;
    this.password = password;
    this.countryCode = String(countryCode || 'FR').toUpperCase();
    this.phoneCode = String(phoneCode || '33').replace(/^\+/, '');
    this.appProfile = String(appProfile || 'iegeek').toLowerCase();
    const profile = APP_PROFILES[this.appProfile];
    if (!profile) {
      throw new Error(`Unknown app profile: ${appProfile}`);
    }
    this.profile = { redirectUrl: REDIRECT_URL, encryptedLogin: false, ...profile };
    this.fetch = fetchImpl ?? globalThis.fetch;

    this.apiServer = '';
    this.userId = null;
    this.clientId = '';
    this.userToken = null;
    this.openapiServer = '';
    this.platformDomain = '';
    this.accessId = '';
    this.accessKey = '';
    this.mqttHost = '';
    this.mqttPort = 1883;
    this.mqttSignature = '';
    /** @type {Map<string, object>} deviceID -> raw device */
    this.devices = new Map();
    this.loggedIn = false;
  }

  // --- low level -------------------------------------------------------------

  async #http(url, { method = 'GET', params, headers = {} } = {}) {
    const init = {
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    };
    let target = url;
    if (params) {
      const body = new URLSearchParams(params);
      if (method === 'GET') {
        target = `${url}?${body}`;
      } else {
        init.body = body;
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    const res = await this.fetch(target, init);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} on ${new URL(url).pathname}`);
    }
    return res;
  }

  async #json(url, options) {
    const res = await this.#http(url, options);
    return res.json();
  }

  caHeaders(apiPath) {
    const ts = String(Date.now());
    const nonce = String(crypto.randomInt(100000, 1000000));
    const caKey = this.userToken ?? DEFAULT_CA_KEY;
    const signKey = this.userToken ?? DEFAULT_CA_SECRET;
    const msg = `api=/ppstrongs/${apiPath}|X-Ca-Key=${caKey}|X-Ca-Timestamp=${ts}|X-Ca-Nonce=${nonce}`;
    return {
      'X-Ca-Timestamp': ts,
      'X-Ca-Key': caKey,
      'X-Ca-Nonce': nonce,
      'X-Ca-Sign': hmacSha1Base64(msg, signKey),
    };
  }

  signParams(params) {
    if (!this.userToken) {
      // A clean, catchable error instead of a raw crypto "key ... Received null".
      throw new MeariAuthError('Not authenticated: no user token');
    }
    const content = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return { ...params, signature: hmacSha1Base64(content, this.userToken) };
  }

  baseParams() {
    const now = new Date();
    const ts = String(now.getTime());
    const params = {
      phoneType: PHONE_TYPE,
      sourceApp: this.profile.sourceApp,
      appVer: this.profile.appVer,
      appVerCode: this.profile.appVerCode,
      lngType: 'en',
      t: ts,
      countryCode: this.countryCode,
      phoneCode: this.phoneCode,
      signatureMethod: 'HMAC-SHA1',
      signatureVersion: '1.0',
      signatureNonce: ts,
      timestamp: meariTimestamp(now),
    };
    if (this.userId) {
      params.userID = String(this.userId);
    }
    return params;
  }

  async get(path, extra = {}) {
    const params = this.signParams({ ...this.baseParams(), ...extra });
    return this.#json(this.apiServer + path, { params, headers: this.caHeaders(path) });
  }

  async post(path, extra = {}) {
    const params = this.signParams({ ...this.baseParams(), ...extra });
    return this.#json(this.apiServer + path, {
      method: 'POST',
      params,
      headers: this.caHeaders(path),
    });
  }

  applyPlatformDefaults() {
    const code = regionCode(this.apiServer, this.openapiServer, this.platformDomain);
    if (!code) return;
    const suffix = `${code}ce`;
    this.openapiServer ||= `https://openapi-${suffix}.mearicloud.com`;
    this.platformDomain ||= `${suffix}.mearicloud.com`;
    this.mqttHost ||= `events-${suffix}.mearicloud.com`;
  }

  openapiSignature(path, action) {
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const msg = `GET\n\n\n${expires}\n${path}\n${action}`;
    return { signature: hmacSha1Base64(msg, this.accessKey), expires };
  }

  /** Per-device auth the OpenAPI device endpoints require (token = deviceSignature). */
  deviceConfigAuth(deviceUuid) {
    for (const dev of this.devices.values()) {
      if (formatSn(dev.snNum) !== deviceUuid) continue;
      if (!dev.deviceSignature) return {};
      const out = { token: dev.deviceSignature, clientid: String(this.userId ?? '') };
      if (dev.t !== undefined && dev.t !== null && dev.t !== '') out.t = String(dev.t);
      return out;
    }
    return {};
  }

  async openapiGet(path, params) {
    this.applyPlatformDefaults();
    if (!this.openapiServer || !this.accessId || !this.accessKey) {
      throw new Error('OpenAPI credentials unavailable');
    }
    const query = { ...params };
    if (
      (path === '/openapi/device/config' || path === '/openapi/device/awaken') &&
      !('token' in query)
    ) {
      Object.assign(query, this.deviceConfigAuth(query.deviceid ?? ''));
    }
    const { signature, expires } = this.openapiSignature(path, query.action ?? 'get');
    query.accessid = this.accessId;
    query.expires = expires;
    query.signature = signature;
    return this.#json(this.openapiServer + path, { params: query });
  }

  // --- login flow ------------------------------------------------------------

  async login() {
    // The login request itself must be signed with the app key, not a stale
    // user token, so the token is cleared for the handshake. But a re-login that
    // then fails (network blip, one-session-per-account contention) must not
    // leave the client token-less: the next signed poll/refresh would crash with
    // `hmac key ... Received null`. Keep the previous session and restore it on
    // failure, so the old token keeps working until it genuinely expires.
    const prevToken = this.userToken;
    const prevUserId = this.userId;
    this.userToken = null;
    this.userId = null;
    this.loggedIn = false;
    try {
      await this.#redirect();
      await this.#doLogin();
      await this.#platformInit();
      await this.refreshDevices();
      this.loggedIn = true;
    } catch (err) {
      // #doLogin sets a fresh token on success, so a non-null token here means a
      // later step failed: keep the new token. Only restore when we never got
      // one (redirect/doLogin failed).
      if (this.userToken === null && prevToken) {
        this.userToken = prevToken;
        this.userId = prevUserId;
        this.loggedIn = true;
      }
      throw err;
    }
  }

  async #redirect() {
    const path = '/ppstrongs/redirect';
    const ts = Date.now();
    const nonce = Array.from({ length: 8 }, () => crypto.randomInt(0, 10)).join('');
    const params = {
      t: String(ts),
      localTime: String(ts),
      nonce,
      sign: md5Hex(`GET|${path}|${ts}|apis.meari.com.cn`),
      partnerId: this.profile.partnerId,
      phoneType: PHONE_TYPE,
      sourceApp: this.profile.sourceApp,
      appVer: this.profile.appVer,
      appVerCode: this.profile.appVerCode,
      countryCode: this.countryCode,
      phoneCode: this.phoneCode,
      lngType: 'en',
      userAccount: encodeUserAccount(this.email, path, ts, this.profile.partnerId, TTID),
    };
    const data = await this.#json(this.profile.redirectUrl + path, {
      params,
      headers: this.caHeaders(path),
    });
    if (String(data.resultCode) !== '1001') {
      throw new Error(`Redirect failed (resultCode ${data.resultCode})`);
    }
    this.apiServer = data.result.apiServer;
    this.countryCode = data.result.countryCode ?? this.countryCode;
    this.applyPlatformDefaults();
  }

  async #doLogin() {
    const path = '/meari/app/login';
    let lastCode = '';
    let lastMsg = '';
    for (const candidate of passwordVariants(this.password)) {
      const ts = Date.now();
      const params = {
        phoneType: PHONE_TYPE,
        sourceApp: this.profile.sourceApp,
        appVer: this.profile.appVer,
        appVerCode: this.profile.appVerCode,
        countryCode: this.countryCode,
        phoneCode: this.phoneCode,
        lngType: 'en',
        t: String(ts),
        userAccount: encodeUserAccount(this.email, path, ts, this.profile.partnerId, TTID),
        localTime: String(ts),
        password: desEncrypt(candidate),
        iotType: '4',
        equipmentNo: ' ',
      };
      if (this.profile.encryptedLogin) {
        params.encryStatus = '1';
      }
      const data = await this.#json(this.apiServer + path, {
        method: 'POST',
        params,
        headers: this.caHeaders(path),
      });
      if (String(data.resultCode) === '1001') {
        const result = data.result;
        this.userId = result.userID;
        this.clientId = String(result.clientId ?? '').trim();
        this.userToken = result.userToken;
        this.#applyLoginIotConfig(result);
        return;
      }
      lastCode = String(data.resultCode ?? '');
      lastMsg = String(data.resultMsg ?? '');
    }
    throw new MeariAuthError(`Login failed: ${lastCode}${lastMsg ? ` (${lastMsg})` : ''}`);
  }

  #applyLoginIotConfig(result) {
    const iot = result.iot;
    if (iot && typeof iot === 'object') {
      const pf = iot.pfKey;
      if (pf && typeof pf === 'object') {
        this.accessId = pf.accessid || this.accessId;
        this.accessKey = pf.accesskey || this.accessKey;
        this.openapiServer = pf.openapiDomain || this.openapiServer;
        this.platformDomain = pf.platformDomain || this.platformDomain;
      }
      const mqtt = iot.mqtt;
      if (mqtt && typeof mqtt === 'object') {
        this.mqttHost = mqtt.host || this.mqttHost;
        this.mqttPort = Number(mqtt.port) || this.mqttPort;
      }
    }
    this.applyPlatformDefaults();
  }

  async #platformInit() {
    const data = await this.get('/v2/app/config/pf/init', { iotType: '4' });
    const code = String(data.resultCode ?? '');
    if (code !== '1001') {
      // Some accounts intermittently answer 1023 with a valid session.
      if (code === '1023') {
        logger.info('Platform init returned 1023, keeping the default endpoints');
        this.applyPlatformDefaults();
        return;
      }
      throw new Error(`Platform init failed (resultCode ${code})`);
    }
    const pf = data.result?.pfApi ?? {};
    if (pf.openapi?.domain) this.openapiServer = pf.openapi.domain;
    this.mqttHost = pf.mqtt?.host || this.mqttHost;
    this.mqttPort = Number(pf.mqtt?.port) || this.mqttPort;
    this.mqttSignature = pf.mqttSignature ?? '';
    const platform = pf.platform ?? {};
    if (platform.domain) this.platformDomain = platform.domain;
    if (platform.signature && platform.expireTime) {
      const info = decryptPlatformSignature(platform.signature, {
        userId: this.userId,
        partnerId: this.profile.partnerId,
        ttid: TTID,
        expireTime: String(platform.expireTime),
      });
      this.accessId = info.accessid;
      this.accessKey = info.accesskey;
    }
    this.applyPlatformDefaults();
  }

  async refreshDevices() {
    const devices = new Map();
    try {
      const payload = await this.post('/v1/app/device/info/get', { funSwitch: '1' });
      if (String(payload.resultCode) === '1001') {
        collectDevices(payload, devices);
      }
    } catch (err) {
      logger.debug(`Default device list failed: ${err.message}`);
    }
    // Shared / family homes: an account the camera was shared with only sees it here.
    try {
      const homes = await this.get('/v1/app/home/list');
      for (const home of homes?.result?.homes ?? []) {
        if (!home.homeID) continue;
        try {
          const data = await this.get('/v1/app/home/join/device/list', {
            homeID: String(home.homeID),
            funSwitch: '1',
          });
          if (['1001', '1107'].includes(String(data.resultCode))) {
            collectDevices(data, devices, String(home.homeID));
          }
        } catch (err) {
          logger.debug(`Home device list failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.debug(`Home list failed: ${err.message}`);
    }
    // A background re-login (listener) refreshes devices on every retry. When
    // both list calls come back empty on a transient failure (fetch failed, a
    // non-1001 code mid-session), overwriting would drop every known camera and
    // the dashboard widgets fall back to "no camera". Keep the previous list
    // instead: a real device removal shows up as a non-empty list that replaces
    // it, and the first login simply has nothing to preserve.
    if (devices.size === 0 && this.devices.size > 0) {
      logger.warn(`Device refresh returned nothing; keeping ${this.devices.size} known device(s).`);
      return [...this.devices.values()];
    }
    this.devices = devices;
    return [...devices.values()];
  }

  cameras() {
    return [...this.devices.values()].filter(isCameraDevice);
  }

  // --- device queries --------------------------------------------------------

  /** Battery / power / Wi-Fi codes from the cloud cache: does not wake the camera. */
  async getBatteryInfo(snNum) {
    const data = await this.get('/v2/app/iot/model/get/batch', {
      snIdentifier: JSON.stringify({ [snNum]: BATTERY_CODES }),
    });
    if (String(data.resultCode) !== '1001') {
      throw new Error(`Battery info failed (resultCode ${data.resultCode})`);
    }
    return normalizeIotValues(data.result?.[snNum]);
  }

  async getIotConfig(snNum) {
    const params = Buffer.from(
      JSON.stringify({ code: 100001, action: 'get', name: 'iot' }),
      'utf8',
    ).toString('base64');
    const resp = await this.openapiGet('/openapi/device/config', {
      action: 'get',
      params,
      deviceid: formatSn(snNum),
      target: 'server',
    });
    if ('errid' in resp) {
      throw new Error(`Device IoT config failed (errid ${resp.errid})`);
    }
    return normalizeIotValues(resp.iot);
  }

  async setIotValue(snNum, code, value) {
    const params = Buffer.from(
      JSON.stringify({ code: 100001, action: 'set', name: 'iot', iot: { [String(code)]: value } }),
      'utf8',
    ).toString('base64');
    const resp = await this.openapiGet('/openapi/device/config', {
      action: 'set',
      params,
      deviceid: formatSn(snNum),
      target: 'server',
    });
    if (resp.action !== 'set') {
      throw new Error(`Device IoT set failed${resp.errid ? ` (errid ${resp.errid})` : ''}`);
    }
  }

  /** Per-device alarm log of one day (YYYYMMDD), newest first. */
  async getDeviceEvents(deviceId, day) {
    const data = await this.get('/v3/app/event/list', {
      deviceID: String(deviceId),
      day: String(day),
      direction: '1',
      index: '0',
    });
    if (String(data.resultCode) !== '1001') {
      throw new Error(`Event list failed (resultCode ${data.resultCode})`);
    }
    return Array.isArray(data.alertMsg) ? data.alertMsg : [];
  }

  /** Download an event snapshot (bounded size). */
  async downloadSnapshot(url) {
    if (!/^https?:\/\//.test(url ?? '')) return null;
    try {
      const res = await this.fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 100 && buf.length < 5 * 1024 * 1024 ? buf : null;
    } catch {
      return null;
    }
  }
}

/** IoT code keys -> numbers, `{ value }` wrappers unwrapped. */
export function normalizeIotValues(info) {
  const out = {};
  if (!info || typeof info !== 'object') return out;
  for (const [key, raw] of Object.entries(info)) {
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    out[String(key)] = value;
  }
  return out;
}
