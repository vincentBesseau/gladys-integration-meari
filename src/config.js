// -----------------------------------------------------------------------------
// Integration configuration: defaults (mirroring the manifest config_schema)
// and normalization of what the Gladys form sends.
// -----------------------------------------------------------------------------

import { APP_PROFILES } from './meari/client.js';

export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  app_profile: 'iegeek',
  country_code: 'FR',
  phone_code: '33',
  use_push: true,
  motion_timeout: 60,
  poll_frequency: 300,
  force_doorbell: false,
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizeConfig(raw = {}) {
  const profile = String(raw.app_profile ?? DEFAULT_CONFIG.app_profile).toLowerCase();
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    email: String(raw.email ?? '').trim(),
    password: String(raw.password ?? ''),
    app_profile: profile in APP_PROFILES ? profile : DEFAULT_CONFIG.app_profile,
    country_code: String(raw.country_code || DEFAULT_CONFIG.country_code)
      .trim()
      .toUpperCase(),
    phone_code: String(raw.phone_code || DEFAULT_CONFIG.phone_code)
      .trim()
      .replace(/^\+/, ''),
    use_push: raw.use_push !== false,
    motion_timeout: clamp(raw.motion_timeout, 10, 3600, DEFAULT_CONFIG.motion_timeout),
    poll_frequency: clamp(raw.poll_frequency, 60, 3600, DEFAULT_CONFIG.poll_frequency),
    force_doorbell: raw.force_doorbell === true,
  };
}

export function hasCredentials(config) {
  return Boolean(config.email && config.password);
}

/** The settings that require a new cloud session when they change. */
export function sessionKey(config) {
  return JSON.stringify([
    config.email,
    config.password,
    config.app_profile,
    config.country_code,
    config.phone_code,
    config.use_push,
  ]);
}
