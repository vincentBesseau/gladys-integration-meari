# Meari

**Meari** is the cloud platform behind many brands of Wi-Fi cameras and doorbells, often battery powered. If your camera is controlled with one of these apps, this integration is for you:

| App | Common brands |
|---|---|
| ieGeek Cam | ieGeek |
| CloudEdge | cameras sold under many brands |
| CloudPlus / CloudHome | same |
| ANRAN | ANRAN |
| Arenti | Arenti |
| BoifunCam | Boifun |

These cameras expose neither RTSP nor ONVIF: the integration goes through the Meari cloud, like the app does.

## What you get

For each camera:

- **Motion**: on for the chosen duration after the last alert (motion, PIR or person).
- **Doorbell** (doorbells only): goes to 1 for a few seconds on every press.
- **Battery** and **charging**, read from the cloud without waking the camera up.
- **Image**: the picture of the last alert, shown in the camera widget.
- **Settings** when the camera exposes them: motion detection, person detection, PIR sensor, status LED.

Two scene triggers: **Doorbell pressed** and **Motion detected** (filterable by person or other motion).

## Dashboard widgets

- **Meari camera**: the last picture, the battery and the motion. A battery doorbell sleeps between events, so the picture is updated at every alert or press (the widget refreshes at once), without ever waking the camera. The "Check for a new picture" button looks in the cloud for a newer one.
- **Doorbell presses**: the last 5 presses, with the day and time, and the picture taken at the press when the cloud provides one. The history is kept by the integration and rebuilt from the cloud (last 7 days) at startup.

In each widget's settings, pick the camera (default: the doorbell, or every doorbell for the history).

## Setup

1. **Create a second account in your app** (ieGeek Cam, CloudEdge…) and share your cameras with it. The cloud allows a single live session per account: with the phone's account, alerts still arrive, but by polling (within 15 seconds) instead of instantly.
2. In Gladys, open the integration and fill in the e-mail, the password, the app used (the one the account was created with), the country code and the dial code.
3. Click **Test the connection**: your cameras are listed.
4. **Discovery** tab: add your cameras.

## Known limits

- No live video: the image is the one of the last alert.
- The delay between a press and the scene depends on the cloud (usually one to a few seconds with push).
- If your doorbell is not recognized as one, enable "Add a doorbell feature to every camera".

Unofficial integration, not affiliated with Meari or the app vendors.
