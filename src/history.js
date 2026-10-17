// -----------------------------------------------------------------------------
// Doorbell press history, persisted in /data (the only writable volume).
//
// Each press keeps its time and, when the cloud provided one, the event
// snapshot (already fitted for Gladys). Entries come from two sources that can
// describe the same press: the live alarms, and the cloud event log read at
// startup (so the history survives a reinstall). `id` de-duplicates them.
// -----------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'history' });

// Per camera. The widget shows 5, a few more cover a merged multi-camera view.
export const MAX_PER_CAMERA = 10;
// Same press seen live and in the cloud log: their times differ by a few seconds.
const SAME_PRESS_MS = 60_000;

export class DoorbellHistory {
  /** @param {string|null} dir storage directory, null = memory only (tests) */
  constructor(dir) {
    this.dir = dir;
    /** @type {{ id: string, deviceId: string, at: number, imageKey: string|null }[]} */
    this.entries = [];
    this.images = new Map();
    if (dir) this.#load();
  }

  #load() {
    try {
      mkdirSync(join(this.dir, 'images'), { recursive: true });
      const raw = JSON.parse(readFileSync(join(this.dir, 'doorbell-history.json'), 'utf8'));
      this.entries = Array.isArray(raw.entries) ? raw.entries : [];
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn(`History not readable, starting empty: ${err.message}`);
    }
  }

  #save() {
    if (!this.dir) return;
    try {
      const file = join(this.dir, 'doorbell-history.json');
      writeFileSync(`${file}.tmp`, JSON.stringify({ entries: this.entries }));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      logger.warn(`History not saved: ${err.message}`);
    }
  }

  #imagePath(key) {
    return join(this.dir, 'images', `${key}.b64`);
  }

  #storeImage(key, base64) {
    this.images.set(key, base64);
    if (!this.dir) return;
    try {
      writeFileSync(this.#imagePath(key), base64);
    } catch (err) {
      logger.warn(`History image not saved: ${err.message}`);
    }
  }

  /** Raw base64 of a history image, or null. */
  image(key) {
    if (this.images.has(key)) return this.images.get(key);
    if (!this.dir || !/^ring-[a-z0-9-]+$/.test(key)) return null;
    try {
      const data = readFileSync(this.#imagePath(key), 'utf8');
      this.images.set(key, data);
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Record a press (or complete a known one with its image).
   * @param {{ id?: string, deviceId: string, at: number, image?: string|null }} press
   *   `image` is the raw base64 of a JPEG that fits the widget budget.
   * @returns {boolean} true when the history changed
   */
  add({ id, deviceId, at, image = null }) {
    const existing = this.entries.find(
      (e) =>
        e.deviceId === deviceId &&
        ((id && e.id === id) || Math.abs(e.at - at) < SAME_PRESS_MS),
    );
    if (existing) {
      if (image && !existing.imageKey) {
        existing.imageKey = this.#keyFor(existing);
        this.#storeImage(existing.imageKey, image);
        this.#save();
        return true;
      }
      return false;
    }
    const entry = { id: id || `${deviceId}-${at}`, deviceId, at, imageKey: null };
    if (image) {
      entry.imageKey = this.#keyFor(entry);
      this.#storeImage(entry.imageKey, image);
    }
    this.entries.push(entry);
    this.entries.sort((a, b) => b.at - a.at);
    this.#prune(deviceId);
    this.#save();
    return true;
  }

  /** Attach an image to the most recent press of a camera that has none. */
  attachToLatest(deviceId, image, withinMs = 2 * SAME_PRESS_MS, now = Date.now()) {
    const latest = this.entries.find((e) => e.deviceId === deviceId);
    if (!latest || latest.imageKey || now - latest.at > withinMs) return false;
    return this.add({ id: latest.id, deviceId, at: latest.at, image });
  }

  #keyFor(entry) {
    return `ring-${entry.deviceId}-${entry.at}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
  }

  #prune(deviceId) {
    const mine = this.entries.filter((e) => e.deviceId === deviceId);
    for (const old of mine.slice(MAX_PER_CAMERA)) {
      this.entries.splice(this.entries.indexOf(old), 1);
      if (old.imageKey) {
        this.images.delete(old.imageKey);
        if (this.dir) rmSync(this.#imagePath(old.imageKey), { force: true });
      }
    }
    // Orphan files (a crash between the two writes): cheap to sweep here.
    if (this.dir) {
      const keep = new Set(this.entries.map((e) => `${e.imageKey}.b64`));
      try {
        for (const file of readdirSync(join(this.dir, 'images'))) {
          if (file.startsWith(`ring-${deviceId}-`) && !keep.has(file)) {
            rmSync(join(this.dir, 'images', file), { force: true });
          }
        }
      } catch {
        // directory missing: nothing to sweep
      }
    }
  }

  /** Most recent presses, newest first, optionally for one camera. */
  latest(limit = 5, deviceId = null) {
    return this.entries.filter((e) => !deviceId || e.deviceId === deviceId).slice(0, limit);
  }
}

/**
 * Parse the time of a cloud event-log entry. Formats seen across Meari
 * firmwares: epoch seconds or milliseconds, `YYYYMMDDhhmmss`, or
 * `YYYY-MM-DD hh:mm:ss` (camera local time). Returns epoch ms or null.
 */
export function parseEventTime(entry) {
  const raw = entry?.eventTime ?? entry?.devLocalTime ?? entry?.alarmTime ?? entry?.createTime;
  if (raw === undefined || raw === null || raw === '') return null;
  const str = String(raw).trim();
  if (/^\d{13}$/.test(str)) return Number(str);
  if (/^\d{10}$/.test(str)) return Number(str) * 1000;
  let m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m.map(Number);
    // Local wall-clock time of the camera, interpreted in the container TZ
    // (Gladys injects the house time zone).
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  return null;
}
