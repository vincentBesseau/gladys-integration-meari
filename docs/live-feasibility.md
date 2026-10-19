# Live view / on-demand snapshot — feasibility spike

Status: **research only, nothing implemented.** This note records what the Meari
cloud exposes for getting a _fresh_ image (or a live stream) from a battery
camera, so we can decide what — if anything — to build. It follows the project
rule: **never wake a battery camera** unless the user explicitly asks.

## The question

Today the camera widget shows the **last alert snapshot** (motion / doorbell
press). The picture only changes when the camera itself pushes one on an event;
the integration never wakes the camera. The idea: show **live**, or at least a
**fresh picture on demand**, with an explicit on/off (live drains the battery).

## What the cloud exposes (code + reference project)

Sources: this integration's own `src/meari/client.js`, and the reference port
[Uxzylon/Ha-CloudPlus-Meari](https://github.com/Uxzylon/Ha-CloudPlus-Meari)
(`docs/streaming.md`, `docs/architecture.md`), which this integration's protocol
is ported from.

1. **An awaken endpoint already anticipated in our code.** `openapiGet()` special-
   cases `/openapi/device/awaken` and injects the per-device auth
   (`token = deviceSignature`, `clientid`, optional `t`) — see
   `src/meari/client.js`. No method calls it yet, but the plumbing is there. In
   the reference project this is the HTTP `wake_device` call.

2. **Waking a battery camera is a real, documented flow** — but a heavy one. Per
   `docs/streaming.md` of the reference project, waking + starting media means:
   - a **MsgSvr signaling** connection watching `status=dormancy` / `status=online`
     pushes;
   - requesting **coturn/TURN** credentials and allocating a relay;
   - an **SDP offer/answer** negotiation with **trickle ICE** candidates;
   - the HTTP **wake** call + `send_wake_connect` signaling, retried within a
     **~75 s wake budget** (`DORMANCY_WAKE_TIMEOUT_S`);
   - a **KCP** (reliable-UDP) transport carrying an IVA handshake (`0x7012`);
   - the **VVP** control protocol: `START_LIVE` (`0x11FF`), heartbeats (`0x888E`),
     `STOP_LIVE`; a legacy **PPCS** transport variant also exists;
   - an **ffmpeg** child muxing **MPEG-TS** over a local TCP socket, audio
     transcoded G.711 µ-law → AAC.

3. **There is no lightweight single-frame path.** The reference `docs/streaming.md`
   is explicit: no cloud "capture" command, no IoT code that triggers a snapshot
   upload, no thumbnail URL. **Getting even one fresh frame requires the full
   wake + P2P session + wait-for-keyframe sequence above.** The only cheap frames
   that exist are the alert snapshots the camera already pushes — which is exactly
   what the widget shows today.

   > To re-confirm on the actual hardware, run the probe (below) and inspect the
   > full IoT model and capability fields for any `snap` / `capture` / `preview`
   > trigger. If one turns up, option A changes. Nothing found so far suggests it
   > will.

## Two hard constraints

- **Battery.** Any fresh frame or stream wakes the camera (a ~75 s wake, then an
  active P2P session). This is the opposite of the integration's default
  ("never wake"). So the wake must be **explicit and time-boxed** — never
  automatic, never on a timer.

- **Gladys can't show live video in a dashboard widget.** The integration-SDK
  widget components are `text`, `image`, `value`, `status`, `button`,
  `card-list` (see `gladys-assistant-integration.json` and `src/widgets.js`).
  There is **no video / stream component**. The best a widget can do is show a
  **still image** that it refreshes. "Live" in a widget would therefore be a
  periodically re-fetched JPEG — i.e. repeated on-demand wakes — which is the
  worst case for the battery. True live video would need Gladys core camera
  support, not an SDK widget, and a stream Gladys can read (RTSP/MJPEG) — which
  these cameras do not natively expose.

## Options, ranked by feasibility

| #   | Option                                                                                                         | What it takes                                                                                                                    | Battery                     | Fits Gladys widget?         | Verdict                                    |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------- | ------------------------------------------ |
| A   | **Keep alert snapshots** (today)                                                                               | nothing                                                                                                                          | none                        | yes (image)                 | baseline                                   |
| B   | **On-demand fresh frame** — button wakes the camera, grabs one keyframe, shows it in the existing image widget | the **full P2P stack** (KCP + VVP + TURN + SDP + ffmpeg), stopped after one keyframe                                             | one ~75 s wake per press    | yes (image)                 | **the realistic target, but a large port** |
| C   | **Full live video**                                                                                            | option B's stack **plus** continuous MPEG-TS serving, **plus** Gladys core camera/stream support it doesn't offer to SDK widgets | continuous drain while open | **no** (no video component) | not worth it on this platform              |

The important finding: **B and C share ~95% of the work** (the binary P2P/KCP/VVP/
TURN streaming stack). B is not a cheap shortcut to C — it is almost the whole
job, with a payoff that actually fits Gladys (a JPEG). C adds a lot of effort for
something a Gladys widget can't even display.

## Recommendation

1. **Short term — do nothing to the transport; improve the wording/UX only.**
   The current "Check for a new picture" button only looks for a newer _alert_
   snapshot in the cloud (it does not wake the camera). That is honest and cheap;
   keep it. Optionally rename it so users don't expect a live wake.

2. **If on-demand fresh frame (option B) is wanted**, treat it as its **own
   project**, not a quick add. Port the reference `p2p_streamer` (KCP, VVP, TURN,
   SDP, ffmpeg) to Node, expose it behind:
   - a **config switch** `enable_wake` (default **off**), so the capability is
     opt-in per installation;
   - a **widget button** "Wake & capture" that wakes the camera, grabs **one
     keyframe**, feeds it through the existing `src/image.js` 150 KB pipeline into
     the normal snapshot/image widget, then **immediately tears the session down**;
   - a hard **wake timeout** and a **cooldown** between wakes, surfaced to the user,
     so the battery cost is bounded and visible.
   - `ffmpeg` must be added to the Docker image.

   Explicitly **out of scope**: automatic/periodic wakes, "live" that refreshes
   on a timer, and continuous video — all three punish the battery and (for video)
   can't be shown in a widget anyway.

3. **Full live video (option C): not recommended** on Gladys with the SDK widget
   model. Revisit only if Gladys core gains an external-camera stream path.

## How to confirm on the hardware (read-only, no wake)

```bash
MEARI_EMAIL=you@example.com MEARI_PASSWORD='…' node scripts/probe.js
```

The probe now also prints, per camera: the **full IoT model**, a **capability
field scan** (any field hinting at stream / snapshot / P2P / wake), and the
**wake prerequisites** (`deviceSignature` present, OpenAPI server set). It only
reads the cloud record and the server-cached IoT model — it never wakes the
camera, never sends a command, never prints serials, tokens or signatures.

What to look for in the output:

- a `full IoT model` code that looks like a **capture / snapshot / preview
  trigger** → would unlock a cheap option A+ (no full P2P). None expected.
- `deviceSignature=present` and `openapi=set` → the **wake path is reachable**, so
  option B is technically possible (still a large port).

---

## Résumé (FR)

Le widget montre aujourd'hui le **dernier snapshot d'alerte** (la caméra pousse
l'image lors d'un mouvement/appui ; l'intégration ne réveille jamais la caméra).

Ce qu'on a trouvé :

- Le code prévoit déjà l'endpoint **`/openapi/device/awaken`** (réveil), avec
  l'auth par `deviceSignature`. Mais **obtenir ne serait-ce qu'une seule image
  fraîche exige toute la pile P2P** : signaling MsgSvr, credentials TURN,
  négociation SDP+ICE, appel HTTP de réveil (budget ~75 s), transport **KCP**,
  protocole **VVP** (`START_LIVE`, heartbeats), mux **MPEG-TS via ffmpeg**. **Aucune
  commande cloud légère de capture, aucun code IoT snapshot, aucune URL de
  vignette** (confirmé par la doc du projet de référence).

- Deux contraintes dures : (1) tout réveil **consomme la batterie** (réveil ~75 s
  - session active) → le réveil doit rester **explicite et borné** ; (2) **Gladys
    ne peut pas afficher de vidéo live dans un widget** (composants : texte, image,
    valeur, statut, bouton, liste — pas de composant vidéo). Au mieux une image fixe
    rafraîchie, donc un « live » = réveils répétés = pire cas batterie.

Reco :

1. **Court terme** : ne rien changer au transport. Le bouton actuel « Chercher une
   image » cherche seulement un snapshot d'alerte plus récent (ne réveille pas) —
   c'est honnête et peu coûteux ; éventuellement le renommer pour éviter la
   confusion.
2. **Si on veut l'image fraîche à la demande (option B)** : c'est un **projet à
   part entière** (porter la pile P2P/KCP/VVP/TURN + ffmpeg en Node), derrière un
   **interrupteur `enable_wake` (désactivé par défaut)**, un bouton **« Réveiller
   & capturer »** qui réveille, prend **une keyframe**, la passe dans le pipeline
   image existant, puis **coupe aussitôt**, avec **timeout de réveil + temps de
   repos** visibles. Hors périmètre : réveils auto/périodiques, « live » sur
   minuterie, vidéo continue.
3. **Live vidéo complet (option C)** : **non recommandé** sur Gladys (pas de
   composant vidéo côté widget). À réétudier seulement si le cœur de Gladys
   ouvre un chemin de flux pour caméra externe.

Pour confirmer sur le matériel, lancer le probe ci-dessus (lecture seule, sans
réveil) et regarder le modèle IoT complet et les `capability fields`.
