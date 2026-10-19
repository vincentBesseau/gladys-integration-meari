// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+).
//
//   camera_view      the camera picture + battery, refreshed when a NEW picture
//                    exists (alert, doorbell press). A battery doorbell sleeps
//                    between events: polling it for frames would drain it, so
//                    the widget follows the events instead of a timer.
//   doorbell_history the last 5 presses (day + time), with the picture taken
//                    at the press when the cloud provided one.
//
// Images go through onWidgetGetImage by key; the core caches a key one hour,
// so a new picture always gets a new key.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { FEATURE, cameraIds, isBatteryCamera } from './camera.js';
import { isDoorbellDevice } from './meari/client.js';

export const WIDGET_KEYS = {
  CAMERA: 'camera_view',
  HISTORY: 'doorbell_history',
};

export const HISTORY_SIZE = 5;

const SOURCE_LABELS = {
  doorbell: { en: 'doorbell press', fr: 'appui sonnette' },
  motion: { en: 'motion', fr: 'mouvement' },
  history: { en: 'last alert', fr: 'dernière alerte' },
  cloud: { en: 'cloud thumbnail', fr: 'vignette du cloud' },
};

const PRESS_LABEL = { en: 'Doorbell press', fr: 'Appui sonnette' };

function timeZone() {
  return process.env.TZ || undefined;
}

/** Resolve a multi-language object to one string, English as the fallback. */
export function tr(dict, language) {
  if (!dict || typeof dict !== 'object') return dict ?? '';
  return dict[language] ?? dict.en ?? '';
}

export function formatTime(at, language) {
  return new Intl.DateTimeFormat(language || 'en', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timeZone(),
  }).format(new Date(at));
}

export function formatDay(at, language, now = Date.now()) {
  const tz = timeZone();
  const dayKey = (t) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(t));
  const fr = String(language).startsWith('fr');
  if (dayKey(at) === dayKey(now)) return fr ? 'Aujourd’hui' : 'Today';
  if (dayKey(at) === dayKey(now - 86_400_000)) return fr ? 'Hier' : 'Yesterday';
  const text = new Intl.DateTimeFormat(language || 'en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: tz,
  }).format(new Date(at));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "3 min ago" style age, multi-language. */
export function formatAge(at, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return { en: 'just now', fr: 'à l’instant' };
  if (minutes < 60) return { en: `${minutes} min ago`, fr: `il y a ${minutes} min` };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { en: `${hours} h ago`, fr: `il y a ${hours} h` };
  const days = Math.round(hours / 24);
  return { en: `${days} days ago`, fr: `il y a ${days} jours` };
}

/**
 * Pick the camera a widget instance shows: the one chosen in its settings, or
 * by default the first doorbell, or the first camera.
 */
export function pickCamera(
  runtime,
  settings,
  { preferDoorbell = false, excludeDoorbells = false } = {},
) {
  let cameras = runtime.cameras();
  // The "Meari camera" widget is for standalone cameras: a doorbell has its own
  // widget ("Doorbell presses"), so it is excluded here by its cloud category
  // (not hasDoorbell, which the force_doorbell option would make true on every
  // camera).
  if (excludeDoorbells) cameras = cameras.filter((c) => !isDoorbellDevice(c));
  if (settings?.device) {
    return cameras.find((c) => cameraIds(runtime.gladys, c).device === settings.device) ?? null;
  }
  if (preferDoorbell) {
    const doorbell = cameras.find((c) => runtime.hasDoorbell(c));
    if (doorbell) return doorbell;
  }
  return cameras[0] ?? null;
}

function emptyState(text) {
  return { ttl_seconds: 300, components: [{ type: 'text', variant: 'caption', text }] };
}

export const WIDGETS = {
  [WIDGET_KEYS.CAMERA]: {
    get(runtime, { settings }) {
      const camera = pickCamera(runtime, settings, { excludeDoorbells: true });
      if (!camera) {
        return emptyState({
          en: 'No camera available (doorbells have their own widget).',
          fr: 'Aucune caméra disponible (les sonnettes ont leur propre widget).',
        });
      }
      const ids = cameraIds(runtime.gladys, camera);
      const snapshot = runtime.snapshotInfo(camera);
      const components = [];
      if (snapshot) {
        components.push({
          type: 'image',
          key: snapshot.key,
          alt: camera.deviceName || 'Camera',
          fit: 'cover',
        });
      } else {
        components.push({
          type: 'text',
          variant: 'caption',
          text: {
            en: 'No picture yet: it comes with the next alert or doorbell press.',
            fr: 'Pas encore d’image : elle viendra avec la prochaine alerte ou le prochain appui.',
          },
        });
      }
      if (isBatteryCamera(camera)) {
        components.push({
          type: 'value',
          label: { en: 'Battery', fr: 'Batterie' },
          icon: 'battery',
          device_feature: ids.feature(FEATURE.BATTERY),
        });
      }
      components.push({
        type: 'value',
        label: { en: 'Motion', fr: 'Mouvement' },
        icon: 'activity',
        device_feature: ids.feature(FEATURE.MOTION),
      });
      if (snapshot) {
        const age = formatAge(snapshot.at);
        const source = SOURCE_LABELS[snapshot.source] ?? SOURCE_LABELS.history;
        components.push({
          type: 'status',
          items: [
            {
              label: { en: 'Picture', fr: 'Image' },
              icon: 'clock',
              value: { en: `${age.en} (${source.en})`, fr: `${age.fr} (${source.fr})` },
              color:
                Date.now() - snapshot.at < 10 * 60_000
                  ? WIDGET_COLORS.SUCCESS
                  : WIDGET_COLORS.NEUTRAL,
            },
          ],
        });
      }
      components.push({
        type: 'button',
        label: { en: 'Check for a new picture', fr: 'Chercher une image' },
        icon: 'refresh-cw',
        style: 'secondary',
        action: { key: 'refresh', params: { device: ids.device } },
      });
      // A new picture nudges the widget at once (see Runtime): the TTL only
      // keeps the "x min ago" label roughly current.
      return { ttl_seconds: 120, components };
    },

    async action(runtime, { actionKey, params }) {
      if (actionKey !== 'refresh') return undefined;
      const found = await runtime.refreshSnapshot(params.device);
      return found
        ? { en: 'New picture loaded.', fr: 'Nouvelle image chargée.' }
        : {
            en: 'No newer picture in the cloud (the camera sleeps between alerts).',
            fr: 'Pas d’image plus récente dans le cloud (la caméra dort entre deux alertes).',
          };
    },
  },

  [WIDGET_KEYS.HISTORY]: {
    get(runtime, { settings, language }) {
      const camera = settings?.device ? pickCamera(runtime, settings) : null;
      if (settings?.device && !camera) {
        return emptyState({ en: 'Camera not found.', fr: 'Caméra introuvable.' });
      }
      const presses = runtime.history.latest(HISTORY_SIZE, camera ? String(camera.deviceID) : null);
      if (presses.length === 0) {
        return emptyState({
          en: 'No doorbell press yet.',
          fr: 'Aucun appui sur la sonnette pour le moment.',
        });
      }
      const several = !camera && new Set(presses.map((p) => p.deviceId)).size > 1;
      const names = new Map(
        runtime.cameras().map((c) => [String(c.deviceID), c.deviceName || c.snNum]),
      );
      return {
        ttl_seconds: 600,
        components: [
          {
            type: 'card-list',
            display: 'list',
            items: presses.map((press) => {
              const name = names.get(press.deviceId) ?? '';
              const item = {
                title: formatTime(press.at, language),
                subtitle: several
                  ? `${formatDay(press.at, language)} · ${name}`
                  : formatDay(press.at, language),
                date: new Date(press.at).toISOString(),
              };
              // A description makes the item tappable: the core then opens its
              // detail panel, where the press picture is shown enlarged.
              item.description =
                `${tr(PRESS_LABEL, language)} — ${formatDay(press.at, language)}, ${formatTime(press.at, language)}` +
                (name ? ` · ${name}` : '');
              if (press.imageKey) item.image = press.imageKey;
              return item;
            }),
          },
        ],
      };
    },
  },
};

/** Register the widget handlers on the SDK (before connect()). */
export function registerWidgets(gladys, runtime) {
  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(key, (request) => widget.get(runtime, request));
    if (typeof widget.action === 'function') {
      gladys.onWidgetAction(key, (actionKey, params, { settings }) =>
        widget.action(runtime, { actionKey, params, settings }),
      );
    }
  }
  gladys.onWidgetGetImage(async (imageKey) => runtime.getWidgetImage(imageKey));
}
