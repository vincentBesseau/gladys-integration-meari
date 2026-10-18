// -----------------------------------------------------------------------------
// Gladys device model of a Meari camera or doorbell.
//
// External ids are built from the cloud deviceID (stable for the life of the
// pairing) and feature keys: both are forever, never rename them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNITS,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { IOT, isDoorbellDevice } from './meari/client.js';

export const DEVICE_TYPE = 'camera';

export const FEATURE = {
  IMAGE: 'image',
  MOTION: 'motion',
  DOORBELL: 'doorbell',
  BATTERY: 'battery',
  CHARGING: 'charging',
  SWITCH_MOTION_DETECTION: 'motion-detection',
  SWITCH_PERSON_DETECTION: 'person-detection',
  SWITCH_PIR: 'pir',
  SWITCH_LED: 'status-led',
};

// Camera settings exposed as switches, when the camera reports the IoT code.
export const IOT_SWITCHES = [
  { key: FEATURE.SWITCH_MOTION_DETECTION, code: IOT.MOTION_DET_ENABLE, name: 'Motion detection' },
  { key: FEATURE.SWITCH_PERSON_DETECTION, code: IOT.HUMAN_DET_ENABLE, name: 'Person detection' },
  { key: FEATURE.SWITCH_PIR, code: IOT.PIR_DET_ENABLE, name: 'PIR sensor' },
  { key: FEATURE.SWITCH_LED, code: IOT.LED_ENABLE, name: 'Status LED' },
];

export const SCENE_TRIGGERS = {
  MOTION: 'motion_detected',
  DOORBELL: 'doorbell_pressed',
};

export function cameraIds(gladys, camera) {
  return gladys.externalIds(DEVICE_TYPE, String(camera.deviceID));
}

export function isBatteryCamera(camera) {
  const category = String(camera._category ?? '').toLowerCase();
  return category === 'snap' || isDoorbellDevice(camera) || Number(camera.devTypeID) === 5;
}

export function hasDoorbell(camera, config) {
  return config.force_doorbell || isDoorbellDevice(camera);
}

/**
 * Build the discovery payload of one camera.
 * @param {object} gladys SDK instance (for external ids)
 * @param {object} camera raw Meari device
 * @param {object} config normalized config
 * @param {Record<string, unknown>} [iot] IoT values read at discovery (optional)
 */
export function buildCameraDevice(gladys, camera, config, iot = {}) {
  const ids = cameraIds(gladys, camera);
  const name = String(camera.deviceName ?? '').trim() || `Camera ${camera.snNum}`;
  const features = [
    {
      name: 'Image',
      external_id: ids.feature(FEATURE.IMAGE),
      category: CAT.CAMERA,
      type: TYPE.CAMERA.IMAGE,
      // Not a numeric value, but Gladys stores min/max on every feature and
      // refuses a device whose feature leaves them null (HTTP 422).
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      name: 'Motion',
      external_id: ids.feature(FEATURE.MOTION),
      category: CAT.MOTION_SENSOR,
      type: TYPE.SENSOR.BINARY,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];

  if (hasDoorbell(camera, config)) {
    features.push({
      name: 'Doorbell',
      external_id: ids.feature(FEATURE.DOORBELL),
      category: CAT.DOORBELL,
      type: TYPE.DOORBELL.RING,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  if (isBatteryCamera(camera) || IOT.BATTERY_PERCENT in iot || String(IOT.BATTERY_PERCENT) in iot) {
    features.push(
      {
        name: 'Battery',
        external_id: ids.feature(FEATURE.BATTERY),
        category: CAT.BATTERY,
        type: TYPE.BATTERY.INTEGER,
        unit: UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Charging',
        external_id: ids.feature(FEATURE.CHARGING),
        category: CAT.BATTERY,
        type: TYPE.BATTERY.CHARGING,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    );
  }

  for (const sw of IOT_SWITCHES) {
    if (iot[String(sw.code)] === undefined) continue;
    features.push({
      name: sw.name,
      external_id: ids.feature(sw.key),
      category: CAT.SWITCH,
      type: TYPE.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: false,
    });
  }

  return {
    name,
    external_id: ids.device,
    // Battery and settings come from the cloud cache: once a minute at most,
    // the user's poll_frequency is applied by skipping polls.
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
    params: [
      { name: 'MEARI_CATEGORY', value: String(camera._category ?? '') },
      { name: 'MEARI_MODEL', value: String(camera.deviceModel ?? camera.tp ?? '') },
    ],
    features,
  };
}

/** Battery codes -> Gladys states. */
export function batteryStates(gladys, camera, values) {
  const ids = cameraIds(gladys, camera);
  const states = [];
  const percent = Number(values[String(IOT.BATTERY_PERCENT)]);
  if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
    states.push({ device_feature_external_id: ids.feature(FEATURE.BATTERY), state: percent });
  }
  const charge = values[String(IOT.CHARGE_STATUS)];
  if (charge !== undefined && charge !== null && charge !== '') {
    // 0: not charging, 1: charging, 2: full (still plugged).
    states.push({
      device_feature_external_id: ids.feature(FEATURE.CHARGING),
      state: Number(charge) === 1 ? 1 : 0,
    });
  }
  return states;
}

/** IoT switch codes -> Gladys states. */
export function switchStates(gladys, camera, values) {
  const ids = cameraIds(gladys, camera);
  const states = [];
  for (const sw of IOT_SWITCHES) {
    const value = values[String(sw.code)];
    if (value === undefined || value === null || value === '') continue;
    states.push({
      device_feature_external_id: ids.feature(sw.key),
      state: Number(value) > 0 ? 1 : 0,
    });
  }
  return states;
}

export function switchForFeature(gladys, camera, featureExternalId) {
  const ids = cameraIds(gladys, camera);
  return IOT_SWITCHES.find((sw) => ids.feature(sw.key) === featureExternalId) ?? null;
}
