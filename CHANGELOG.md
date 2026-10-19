# Changelog

## [Unreleased]

### Added

- Login with an account of any Meari app (ieGeek Cam, CloudEdge, CloudPlus, ANRAN, Arenti, BoifunCam), camera discovery.
- Motion sensor and `motion_detected` scene trigger (person / other motion).
- Doorbell ring feature and `doorbell_pressed` scene trigger.
- Battery level and charging state, read from the cloud cache.
- Camera image from the last alert snapshot.
- Motion detection, person detection, PIR and status LED switches.
- "Meari camera" dashboard widget: last picture, battery, motion, refreshed on every alert.
- "Doorbell presses" dashboard widget: the last 5 presses with day, time and picture, persisted in /data and rebuilt from the cloud log.
- Alarms through the cloud MQTT push, with a 15 s event-log polling fallback.

### Fixed

- The camera image feature now declares min/max: Gladys refused the device (HTTP 422) without them.
- A background re-login no longer drops the known cameras when the cloud briefly fails to list devices: the dashboard widgets kept showing "no camera available" / "camera not found" until the next full discovery.
- The image now makes its files readable by the unprivileged `node` user: a restrictive host umask (0600 source files) made the container crash with `EACCES: permission denied, open '/app/index.js'`.
- A failed re-login (network blip, one-session-per-account contention) no longer leaves the client without a user token: it kept the previous session so the next signed request crashed with `The "key" argument ... Received null`, which broke the widget "refresh picture" button and dropped alarms until a full re-login succeeded. Signing without a token now raises a clean auth error instead of a crypto crash.
- Real-time push is far more stable: a transient event-log poll failure no longer triggers a full re-login, which used to open a new cloud session that evicted the integration's own MQTT push (the broker pins the client id to the account) and forced a fallback to 15 s polling. The listener now re-authenticates only when the push is also down and polls keep failing.
