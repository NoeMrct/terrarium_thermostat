# Heating base manual

This manual covers the whole journey: unboxing, flashing, wiring, settings, monitoring,
troubleshooting. It is written for someone who has never opened an IDE. Technical terms are
explained as they come; the "going further" sections of the repository README remain the
complete reference. The French version (`docs/manuel.md`) is the reference text.

## 1. What the base does

The base regulates the temperature of **two zones** of a terrarium, each with its own probe and
its own 12 V heat mat. It **never heats two mats at the same time** on a small power supply: that
is structural, not a setting. It cuts the heating by itself and says so loudly when something is
wrong: probe missing or frozen, temperature above the maximum cut-off, sudden drop, heating
without effect.

It works on its own, without any network. The network adds: the local web interface, the remote
app, alerts on your phone, home automation.

## 2. What you need

- The base assembled according to the repository schematic (ESP32, two MOSFETs, two bimetal
  thermostats, 5 V converter).
- A **12 V, 3 A** power supply for the mats. Declaring more amps than it really has is the only
  way to overload it: the device trusts that figure.
- A USB **data** cable (not every charging cable is one) for the first flashing.
- A phone or a computer for the configuration.
- For remote control: an MQTT broker over secure WebSocket (HiveMQ Cloud has a free tier that is
  enough).

> Workshop golden rule: **USB and 12 V are never plugged in at the same time.** The 12 V feeds
> the board through the 5 V converter; so does USB. Both together fight over the board.

## 3. Installing the firmware

The simplest way: the **Flash a base** page of the site, in Chrome or Edge, on a computer. Plug
the board in over USB, click, pick the port. On a new board, accept the full erase; on a base
already in service, refuse it to keep the settings and the pairing code. Right after flashing,
the same page offers to **configure Wi-Fi** over the cable (Improv protocol): pick your network in
the list, type the password, done.

Without Chrome: the Arduino IDE, with the board settings described in the repository's
`INSTALLATION.md` (board "ESP32 Dev Module", partition scheme "Custom", 4 MB flash).

## 4. First boot

1. Unplug USB, plug in the 12 V. The screen shows "Thermostat terrarium" then the status.
2. If Wi-Fi was not given at flashing time, the base opens a **terrarium-config-XXXXXX** network
   (the last six characters of its identifier; password `terrarium1234`). Connect your phone to
   it: the configuration page opens by itself (otherwise `http://192.168.4.1`).
3. **Network** tab: your Wi-Fi, a username and a password for the interface, an OTA password if
   you want to update without a cable, and, for remote control, the MQTT server. Save: the base
   restarts on your network.
4. It is then reachable at `http://terraXXXXXX.local` (its identifier, shown on the screen and
   in the app) or at its IP address. The interface asks for the username and password you chose;
   the password never leaves the browser (challenge login).

At the very first boot, the screen shows the **pairing code** for twenty seconds, as letters and
as a QR code. It can be found again in the Network tab and with the `jeton` serial command.

## 5. Linking probes to zones

Each DS18B20 probe has a unique address. **Settings → Detected 1-Wire probes → Scan**, then
"to zone 1" / "to zone 2". If only one probe shows up, it is the wiring (see troubleshooting),
not the software.

The probe goes **at the hot spot, under the substrate, against the mat** — never in the air.
Check with an infrared thermometer before putting an animal in.

## 6. Pairing in the app

Open the app, enter the broker address (`wss://…:8884/mqtt`), the username and the password
your broker gave you. **Test the connection** tells you right away whether it works. Then
**Add a base**: scan the QR (base screen or label), or type the identifier (`terraXXXXXX`) and
the pairing code. The base appears with its two zones.

The app can be installed like a real application ("Install the app" button, or Share → Add to
Home Screen on iPhone). It then works offline for its interface part, and updates itself by
offering "Reload".

**Lock code** (bottom of the base list): with a code, the broker password and the pairing codes
are encrypted on the phone, and the app locks itself after the chosen delay. Whoever takes the
phone can no longer heat an animal. The code cannot be recovered: if forgotten, "Erase
everything" and pair again (the codes are on the bases).

**With the Terrariums server** (`serveur/` in the repository, self-hosted) instead of a bare
broker, each base is attached to your account by proving its pairing code, history is kept even
with the app closed, and the phone is warned by push notification. The app detects it by itself
when connecting.

## 7. Settings

In a base's view, **Status** tab: the day and night setpoints, directly. **Settings** tab:
everything else.

| Setting | What it is | Starting value |
|---|---|---|
| Day / night setpoint | Target temperature, at the hot spot | depends on the species |
| Day / night start | Switch-over times | 08:00 / 20:00 |
| Ramp | Gradual transition from one setpoint to the other, in minutes | 45 |
| Band | Width of the modulation zone around the setpoint | 2 °C |
| Max cut-off | Above it, the zone locks into a fault. Absolute safety. | 40 °C |
| Calibration | Offset added to the reading, if the probe reads wrong | 0 |

**Autotune** sets the band and the gain by itself: run it once the terrarium is in place and
stable, it makes the zone oscillate for about an hour, then saves what it learned.

**Device** tab: the power supply (available amps, power of one mat), seasonal cycling,
statistics, the base's health, settings backups.

## 8. Reading the status

- **online**: the base is publishing. **silent**: it is announced online but has published
  nothing for more than two minutes — check its Wi-Fi. **offline**: the broker no longer sees
  it. In every case, the base keeps regulating on its own.
- **heating**: this zone's mat is powered right now. **demand**: what the regulation is asking
  for, from 0 to 100 %.
- **drift**: the temperature has been moving away from the setpoint for a while without a fault
  being declared. Often: lid open, cold room, ageing mat.
- **FAULT**: the zone's heating is cut and locked. The label says why (PROBE, OVERHEAT,
  FROZEN…). Once the cause is fixed, **Clear faults**.

## 9. Charts and statistics

The 6 h and 24 h charts come from the base, accurate to the minute. Over 7 and 30 days, the app
adds the points it noted in passing: opening the app from time to time is enough to fill these
charts. Wheel or pinch to zoom, drag to move, double-click to come back. **Export as CSV** gives
the file for a spreadsheet.

The 24 h statistics (min, max, average, share of time out of range, heating hours, kWh) tell
whether a terrarium **holds** its values, not only whether it reaches them.

## 10. Being warned

- **Browser notifications**: a fault or a drift shows a notification as long as the app is open
  (even in the background). Device tab → Notifications.
- **On the phone, app closed**: the base itself calls a web address at every alert. With
  [ntfy](https://ntfy.sh), it is free and needs no account: create a topic, put its address in
  "Alert URL" in the Network tab, choose the "text" format, install ntfy on the phone. Details
  in `docs/alertes-telephone.md`. With the Terrariums server: "Enable server notifications" in
  the Device tab, and the server pushes the alerts.
- **Knowing it is alive**: the heartbeat URL called every five minutes; with
  [healthchecks.io](https://healthchecks.io), you are warned when the base goes quiet.
- **Home automation**: Home Assistant discovery can be enabled in the Network tab; `/metrics`
  exposes the readings for Prometheus.

## 11. Maintenance

- **Maintenance** (Status tab → Actions): cuts the heating while you clean, then resumes by
  itself at the given time.
- **Settings backup** (Device tab): a JSON file with setpoints, schedules and device settings,
  to import again on a spare base.
- **Export configuration** (bottom of the list): the whole app — broker and bases — to change
  phones. The file contains the pairing codes: keep it to yourself.
- **Restart**, **Erase history**: Device tab. The app's local history is erased at the same time.

## 12. Updating

- **The app** updates itself: a "New version available — Reload" message appears. Nothing is
  forced in the middle of a setting.
- **The firmware**: in the app, Device tab, the **Firmware update** card says whether a newer
  version is published and a button makes the base **download and install it by itself**
  (signature checked if the base requires it). Otherwise: the Flash a base page (USB), the
  Network tab of the local interface (upload of the `.bin` file, or "Update from GitHub"), or
  OTA from the IDE if an OTA password is set. While writing, the heating is cut; at restart, the
  new version must declare itself healthy within a minute and a half, otherwise the base goes
  back to the previous version by itself — and the app shows "rolled back".

## 13. Safety

- A 70 °C bimetal thermostat on each plate, in series with the mat, and a fuse on the 12 V:
  these are the protections that do not depend on the software. The README ("What protects the
  hardware" section) details the rest.
- Do not leave an animal on a base whose probes have not been checked with an independent
  thermometer.
- A maximum cut-off set too high is not a safety. Keep it a few degrees above the day setpoint,
  never more.
- The base refuses out-of-range settings; if it shows a fault, it has good reasons. Only "clear"
  a fault after understanding its cause.

## 14. Troubleshooting

The full decision tree is in `docs/depannage.md`. The three most frequent cases:

- **No probe detected**: 4.7 kΩ resistor between data and 3.3 V, common ground, terminal block
  checked with an ohmmeter, probe on GPIO4.
- **offline in the app**: the base has no Wi-Fi or no broker. Its screen shows "AP" if it could
  not connect: it has reopened the configuration network. On site, the serial command
  `wifi <ssid> <password>` tries the network right away and says whether it answers.
- **USB port "access denied"** on Windows: CP210x driver missing.

## 15. Diagnostics and help

The **Diagnostics** button (at the bottom of the base list) assembles a report: app version,
browser, broker state, and for each base its version, its Wi-Fi signal, its memory, its last
restart, and the recent errors. It contains no password and no pairing code. **Copy the report**
and attach it to a support request saves a round trip; with the Terrariums server, **Send to
the server** files it directly.

On the base, the serial command `test usine` checks the screen, the probes, the memory, the
partitions and Wi-Fi in one go (`test usine oui` also drives each MOSFET for a fraction of a
second: never with an animal on it).
