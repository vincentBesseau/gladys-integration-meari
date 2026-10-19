# Meari

**Meari** ist die Cloud-Plattform hinter vielen Marken von WLAN-Kameras und -Türklingeln, oft batteriebetrieben. Wenn Ihre Kamera mit einer dieser Apps gesteuert wird, ist diese Integration für Sie:

| App                   | Gängige Marken              |
| --------------------- | --------------------------- |
| ieGeek Cam            | ieGeek                      |
| CloudEdge             | Kameras unter vielen Marken |
| CloudPlus / CloudHome | ebenso                      |
| ANRAN                 | ANRAN                       |
| Arenti                | Arenti                      |
| BoifunCam             | Boifun                      |

Diese Kameras bieten weder RTSP noch ONVIF: Die Integration läuft über die Meari-Cloud, wie die App.

## Was Sie erhalten

Für jede Kamera:

- **Bewegung**: nach dem letzten Alarm (Bewegung, PIR oder Person) für die gewählte Dauer aktiv.
- **Türklingel** (nur Türklingeln): wechselt bei jedem Drücken für einige Sekunden auf 1.
- **Batterie** und **Laden**, aus der Cloud gelesen, ohne die Kamera zu wecken.
- **Bild**: das Foto des letzten Alarms, im Kamera-Widget angezeigt.
- **Einstellungen**, sofern die Kamera sie bereitstellt: Bewegungserkennung, Personenerkennung, PIR-Sensor, Status-LED.

Zwei Szenen-Auslöser: **Türklingel gedrückt** und **Bewegung erkannt** (filterbar nach Person oder anderer Bewegung).

## Dashboard-Widgets

- **Meari-Kamera**: das letzte Bild, die Batterie und die Bewegung. Eine batteriebetriebene Türklingel schläft zwischen Ereignissen, daher wird das Bild bei jedem Alarm oder Drücken aktualisiert (das Widget aktualisiert sich sofort), ohne die Kamera je zu wecken. Die Schaltfläche „Nach neuem Bild suchen“ prüft in der Cloud, ob es ein neueres gibt.
- **Klingelereignisse**: die letzten 5 Ereignisse, mit Tag und Uhrzeit sowie dem beim Drücken aufgenommenen Bild, sofern die Cloud eines liefert. Der Verlauf wird von der Integration gespeichert und beim Start aus der Cloud (letzte 7 Tage) wiederhergestellt.

Wählen Sie im Widget **Meari-Kamera** eine Kamera — Türklingeln sind ausgeschlossen, sie haben ihr eigenes Widget. Wählen Sie unter **Klingelereignisse** eine Türklingel (Standard: alle); tippen Sie auf ein Ereignis, um sein Bild vergrößert zu öffnen.

## Einrichtung

1. **Erstellen Sie ein zweites Konto in Ihrer App** (ieGeek Cam, CloudEdge…) und teilen Sie Ihre Kameras damit. Die Cloud erlaubt nur eine Live-Sitzung pro Konto: Mit dem Konto des Telefons kommen die Alarme weiterhin an, aber per Abfrage (innerhalb von 15 Sekunden) statt sofort.
2. Öffnen Sie in Gladys die Integration und geben Sie E-Mail, Passwort, die verwendete App (die, mit der das Konto erstellt wurde), den Ländercode und die Telefonvorwahl ein.
3. Klicken Sie auf **Verbindung testen**: Ihre Kameras werden aufgelistet.
4. Tab **Erkennung**: fügen Sie Ihre Kameras hinzu.

## Bekannte Einschränkungen

- Kein Live-Video: Das Bild ist das des letzten Alarms.
- Die Verzögerung zwischen einem Drücken und der Szene hängt von der Cloud ab (meist ein bis einige Sekunden mit Push).
- Wird Ihre Türklingel nicht als solche erkannt, aktivieren Sie „Jeder Kamera eine Türklingel-Funktion hinzufügen“.

Inoffizielle Integration, nicht mit Meari oder den App-Anbietern verbunden.
