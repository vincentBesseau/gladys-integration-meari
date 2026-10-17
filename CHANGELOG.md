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
