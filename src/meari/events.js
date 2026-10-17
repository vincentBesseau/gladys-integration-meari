// -----------------------------------------------------------------------------
// Parsing of Meari alarm events (MQTT push and cloud event log).
//
// Payload shapes are not stable across firmwares: the alarm type and the
// device id can sit at the top level or under params/data/msg/result/items.
// Ported from motion_event.py of https://github.com/Uxzylon/Ha-CloudPlus-Meari.
// -----------------------------------------------------------------------------

export const ALARM_TYPE_NAMES = {
  1: 'PIR',
  2: 'Motion',
  3: 'Visitor',
  6: 'Noise',
  7: 'Baby cry',
  8: 'Face',
  9: 'Call',
  10: 'Tamper',
  11: 'Human body',
  12: 'Face detected',
  14: 'Dog bark',
  17: 'Cat',
  18: 'Pet',
  19: 'Package',
  20: 'Person',
  21: 'SD card removed',
  39: 'Fire',
  41: 'Cat meow',
};

// What Gladys exposes. "person" is a motion whose AI said a human was there.
export const MOTION_ALARM_TYPES = new Set([1, 2, 11, 20]);
export const PERSON_ALARM_TYPES = new Set([11, 20]);
// Doorbell button press. On Meari doorbells the press is reported as a
// "Visitor" (3) alarm, some firmwares as a "Call" (9). Not yet confirmed on the
// ieGeek B411B: unknown types are logged so the mapping can be adjusted.
export const DOORBELL_ALARM_TYPES = new Set([3, 9]);

const WRAPPER_KEYS = ['params', 'data', 'msg', 'result', 'items', 'payload'];
const EVENT_KEYS = ['eventType', 'alarmType', 'imageAlertType', 'alertType', 'evt'];
const DEVICE_KEYS = ['deviceID', 'deviceId', 'device_id', 'deviceid', 'devID', 'devId'];
const LICENSE_KEYS = [
  'licenseID',
  'licenseId',
  'snNum',
  'sn',
  'snnum',
  'deviceSN',
  'deviceSn',
  'snIdentifier',
];
const IMAGE_URL_KEYS = ['imageUrl', 'imageURL', 'picUrl', 'picURL', 'thumbUrl', 'snapshotUrl'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function unwrap(raw) {
  let data = raw;
  for (let i = 0; i < 8 && isObject(data); i += 1) {
    const next = WRAPPER_KEYS.map((k) => data[k]).find(isObject);
    if (!next) break;
    data = next;
  }
  return isObject(data) ? data : {};
}

function pickFirst(data, keys) {
  for (const key of keys) {
    if (key in data && data[key] !== null && data[key] !== '') return data[key];
  }
  return undefined;
}

/** Breadth-first list of every object nested in `data` (bounded). */
function allObjects(data, limit = 64) {
  const out = [];
  const queue = [data];
  const seen = new Set();
  while (queue.length && out.length < limit) {
    const item = queue.shift();
    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }
    if (!isObject(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    for (const value of Object.values(item)) {
      if (isObject(value) || Array.isArray(value)) queue.push(value);
    }
  }
  return out;
}

function findFirst(data, keys) {
  for (const item of allObjects(data)) {
    const value = pickFirst(item, keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function classifyAlarm(type) {
  if (DOORBELL_ALARM_TYPES.has(type)) return 'doorbell';
  if (MOTION_ALARM_TYPES.has(type)) return 'motion';
  return 'other';
}

function normalize(raw, data, evtRaw) {
  const type = Number.parseInt(evtRaw, 10);
  const alarmType = Number.isNaN(type) ? -1 : type;
  const deviceId = pickFirst(data, DEVICE_KEYS) ?? findFirst(raw, DEVICE_KEYS);
  const licenseId = pickFirst(data, LICENSE_KEYS) ?? findFirst(raw, LICENSE_KEYS);
  return {
    alarmType,
    alarmName: ALARM_TYPE_NAMES[alarmType] ?? `type=${evtRaw}`,
    kind: classifyAlarm(alarmType),
    person: PERSON_ALARM_TYPES.has(alarmType),
    deviceId: deviceId === undefined ? '' : String(deviceId).trim(),
    licenseId: licenseId === undefined ? '' : String(licenseId).trim(),
    imageUrl: findImageUrl(raw),
    raw,
  };
}

/**
 * Parse an alarm payload (Buffer, string or already-decoded object).
 * Returns the most relevant alarm (doorbell > motion > other) or null.
 */
export function parseAlarmEvent(payload) {
  let raw = payload;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObject(raw)) return null;

  const candidates = [unwrap(raw), raw, ...allObjects(raw)];
  const seen = new Set();
  let first = null;
  let motion = null;
  for (const data of candidates) {
    if (!data || seen.has(data)) continue;
    seen.add(data);
    const evtRaw = pickFirst(data, EVENT_KEYS);
    if (evtRaw === undefined) continue;
    const event = normalize(raw, data, evtRaw);
    if (event.kind === 'doorbell') return event;
    if (event.kind === 'motion' && !motion) motion = event;
    first ??= event;
  }
  return motion ?? first;
}

export function findImageUrl(raw) {
  for (const item of allObjects(raw, 256)) {
    for (const key of IMAGE_URL_KEYS) {
      const value = item[key];
      if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
    }
  }
  return '';
}

/** Stable identifier of a cloud event-log entry (for de-duplication). */
export function eventLogId(entry) {
  return String(entry.msgID ?? entry.msgId ?? entry.eventTime ?? '').trim();
}
