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

The base is sold assembled: the firmware is installed at the workshop. The simplest way: the
site's **Workshop** page (`/atelier`, for the assembly team only), in Chrome or Edge, on a
computer. Plug the board in over USB, "Nouveau socle", pick the port: a blank or outdated board
receives the firmware of the latest release (the "Install" window). On a new board, accept the
full erase; on a base already in service, refuse it to keep the settings and the pairing code.
The workshop then sets the **bench Wi-Fi** over the cable (Improv protocol) and carries on with
the commissioning (`docs/atelier.md`).

Without Chrome: the Arduino IDE, with the board settings described in the repository's
`INSTALLATION.md` (board "ESP32 Dev Module", partition scheme "Custom", 4 MB flash).

## 4. First boot

1. Unplug USB, plug in the 12 V. The screen shows "Thermostat terrarium" then the status.
2. If Wi-Fi was not given at flashing time, the base opens a **terrarium-config-XXXXXX** network
   (the last six characters of its identifier; its password, unique to each base, shows on the screen
   alternating with "AP config"). Connect your phone to
   it: a page opens by itself (otherwise `http://192.168.4.1`) with the networks the base sees. Pick
   yours, enter its password, **Connect the base**: it tries, tells you whether the router accepted
   (or why it refuses: password, 5 GHz-only network, signal too weak), then restarts on it. The app,
   if you use it, guides you through these steps (§ 6).
3. Everything else is set in the **full interface** (link at the bottom of that page, then
   `http://terraXXXXXX.local`). On first opening, it asks you to create its password (8 characters
   at least; a base assembled at the workshop already has one, on its label). **Network** tab: an
   OTA password if you want to update without a cable, and, for remote control, the MQTT server
   (already set on a base assembled at the workshop).
4. It is then reachable at `http://terraXXXXXX.local` (its identifier, shown on the screen and
   in the app) or at its IP address. The interface asks for the username and password you chose;
   the password never leaves the browser (challenge login).

At the very first boot, the screen shows the **pairing code** for twenty seconds, as letters and
as a QR code. It can be found again in the Network tab and with the `jeton` serial command.

## 5. Linking probes to zones

Each DS18B20 probe has a unique address, and each zone follows the address of **its** probe: a
probe is never linked to two zones, and a zone without a probe stays in fault, heating off. At
the first boot, probes are linked in bus order; nothing says this order is that of the plates. To
be sure, in the local interface, **Settings → Probes**:

1. **Identify** next to a zone, then hold that zone's probe in your hand for a minute. The base
   recognises it (it is the one warming up) and links it to the zone. Heating is suspended
   meanwhile. Over serial: `identifier 1`.
2. **Heating test** (same tab, or `essai 1`): the zone heats alone for ten minutes at most and the
   base says whether it is really its own probe that rises. Do it when commissioning each mat.
3. **Calibrate** (or `calibrer`): probes laid side by side for a few minutes, the other zones are
   aligned on zone 1.

With firmware 3.5, the app does all this remotely, in the **Service** section: bus inventory,
linking to a zone, identification, heating test and calibration.

**Re-read the bus** after plugging in a probe; "to zone 1" / "to zone 2" links by hand. If only
one probe shows up, it is the wiring (see troubleshooting), not the software. While running, the
base also checks that heating a zone raises its own probe: if another zone's probe rises instead,
both zones go into the HEATING WITHOUT EFFECT fault (label `CHAUFFE SANS EFFET`).

The probe goes **at the hot spot, under the substrate, against the mat** — never in the air.
Check with an infrared thermometer before putting an animal in.

## 6. Pairing in the app

At first launch, the app welcomes you: **Sign in**, **Try the demo**, or **No internet, at home
only**, which explains the base's local page.

This manual is the technical reference (support, workshop, self-assembly); the app serves users a
shorter guide, `docs/guide.en.md`. It shows them nothing technical: base health, the power supply
block, the test alert and the **Service** tab tools only appear for a team account (support or
server administrator) or a direct broker connection.

To connect, two cases:

- **A Terrariums server**: when the app knows its server (`terrarium-serveur` tag in
  `index.html`, or the server serving it), "Sign in" goes straight to the account; otherwise, its
  `https://…` address is enough. Enter your e-mail address, type the
  six-digit code you receive (valid ten minutes): the account opens, with no password. The app then
  offers a **passkey**: next time, one gesture is enough (fingerprint, face or phone PIN), no e-mail.
  **Your account** (at the top of the **App settings**) lists the passkeys, exports the account data and deletes
  the account.
- **An MQTT broker** (support, development): at the app's `#/technique` address, its
  `wss://…:8884/mqtt` address, the username and password it gave you; **Test the connection**
  tells you right away whether it works.

The **+** button starts **installing a base**, in three steps:

1. **The label**: scan the QR (under the base, on the box, or on its screen), or copy the reference
   (`terraXXXXXX`) and the pairing code. A recent label carries a link: the phone's camera opens it
   directly, and the app starts with everything filled in.
2. **The Wi-Fi**: the app names the base's network (`terrarium-config-…`); join it, pick your Wi-Fi
   on the page that opens, then come back. The app ticks what it sees: Wi-Fi joined (with the signal
   strength), server reached, clock set, code verified (or "base linked to your account" with the
   Terrariums server). A wrong code brings you back to the label; a base that has not arrived after
   four minutes gets the usual causes. **Finish later** keeps the base in the list.
3. **Starting settings**: the terrarium's name, each zone's day and night setpoints (and their
   names), fixed times or following the sun. The safety cut-off is recalled.

**All set** shows the first minutes of heating and offers to enable alerts.

The app can be installed like a real application ("Install the app" button, or Share → Add to
Home Screen on iPhone). It then works offline for its interface part, and updates itself by
offering "Reload".

Below the base list, **App settings** gathers the account, the language, the theme (light, dark,
or the phone's), the lock code and help. **Organise my bases**
tidies the list: order (arrows), names, **groups** ("Home", "Breeding"…; a base moved down past the
end of a group joins the next one), **compact view** (one line per base with its two temperatures,
for those who have many) and **group actions**: 30-minute maintenance or clearing faults on every
ticked base, with the count of those that confirmed.

**Lock code** (App settings): with a code, the broker password and the pairing codes
are encrypted on the phone, and the app locks itself after the chosen delay. Whoever takes the
phone can no longer heat an animal. The code cannot be recovered: if forgotten, "Erase
everything" and pair again (the codes are on the bases).

**With the Terrariums server** (`serveur/` in the repository, self-hosted) instead of a bare
broker, each base is attached to your account by proving its pairing code, history is kept even
with the app closed, and the phone is warned by push notification. The app detects it by itself
when connecting.

**Share a base** (App settings, with the Terrariums server): for a pet-sitter or a relative. Choose
"Read-only" (sees the temperatures and curves, gets the alerts, changes nothing) or "Can adjust"
(setpoints and times, but can neither share nor remove the base), and until when (one week, two,
or no end); "Create an invitation link" gives a single-use link, valid 48 hours, to copy or send.
The person opens it, signs in or creates their account by e-mail, and the base appears on their
side. The "Can adjust" link contains the base's code (in the part of the address that never leaves
the phone): only send it to them. The same page shows who has access and pending invitations, and
removes an access in one tap; on the chosen date, it stops by itself. For your own second phone,
nothing to share: sign in with your account.

## 7. Settings

A base's home shows its two zones in large type, four round buttons (Maintenance, Clear faults,
Alerts, Updates) and its sections. Tapping a zone opens its screen: the target in large type, set
with the ‹ › chevrons in 0.5 °C steps, for day or night; it is sent to the base one second after
the last tap. The **Temperatures**, **Schedule** and **Safety** sections hold everything else.

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

**Safety** section: each zone's max cut-off, and the power supply as the workshop set it (the
block, and whether two mats can heat together or take turns); it only changes in **Service**, when
the block or the mats change, after a confirmation. **Device** section: seasonal cycling, statistics, the base's health, settings backups.

With firmware 3.5, the app also sets what follows (the sun in Schedule, the priority zone in
Safety, the rest in Device); in the local interface, it is
**Settings → General settings**:

- **Day and night following the sun**: latitude and longitude (two decimals are enough), and an
  optional offset; sunrise and sunset then replace the fixed times, through the seasons.
- **Priority zone**: when the power supply cannot feed both mats at once, it gets the larger share
  of heating time.
- **Price per kWh**: the heating cost appears in the statistics and the report.
- **Screen at night** (dimmed, normal or off) and **board LED**.
- **Daily report**: a summary of the day, sent with the alerts at the chosen time.

### Time slots, seasons, preheating and holiday

**Schedule** opens on the current day: the period or slot now, its targets and the time of the next
change, and a 24-hour strip where a line marks the present moment. Two rows lead further.

**Time slots and seasons**:

- **Time slots**: up to four moments a day (morning, heat peak, afternoon, night…) instead of just
  day and night. Each slot has a start time, a name and one setpoint per zone; it lasts until the
  next one starts, and the coolest counts as the night (dimmed screen). Two starts are at least
  15 minutes apart. Tapping a slot opens it to edit or remove it; "Add a slot" suggests one in the
  middle of the day's longest gap. Slots are prepared while off, then turned on with a switch: while
  they are on, the zones' day and night setpoints and the sun are no longer used, and a zone's
  screen shows the setpoint of the current slot.
- **Days**: the same slots every day, or one set for weekdays and another for Saturday and Sunday
  (the weekend starts from the weekday slots).
- **Follow the seasons**: in winter (1 December to 28 February by default), setpoints drop (2 °C by
  default) and the day gets shorter (one hour by default, half in the morning, half in the
  evening), with a gradual two-week change before and after. A sentence tells what mid-winter's day
  becomes; "Set up winter" changes the dates, the drop, the shortening and the transition. This
  calendar adds to the seasonal cycling of the Device section.
- **Preheating**: the base learns how many degrees each zone gains per hour and starts early enough
  for a warmer setpoint to be reached on time (three hours ahead at most). Drops keep their ramp.

**Holiday mode**: the leaving and return dates (the return day is included), the usual setpoints or
2 °C lower, and earlier alerts (a drift reported from 2 °C off). The base switches on its own when
you leave and goes back to the usual setpoints on its own when you return; the base's home shows a
"Holiday" banner meanwhile. In **Organise**, "Holiday…" schedules the same dates for every ticked
base.

The base's log notes slot changes, edits to the slots, and the start and end of the holiday.

## 8. Reading the status

- **online**: the base is publishing. **silent**: it is announced online but has published
  nothing for more than two minutes — check its Wi-Fi. **offline**: the broker no longer sees
  it. In every case, the base keeps regulating on its own.
- When offline, the app shows the last temperatures received with their time ("Read at
  14:12") and what to check; "Retry" asks the base, "Local page" opens its page on the home
  network. Settings wait for its return; a message tells you when it is back.
- **heating**: this zone's mat is powered right now. **demand**: what the regulation is asking
  for, from 0 to 100 %.
- **drift**: the temperature has been moving away from the setpoint for a while without a fault
  being declared. Often: lid open, cold room, ageing mat.
- **too hot**: the zone has been above its setpoint for a while without heating (room too warm,
  lamp). The base can do nothing about it: cool the room or lower the lamp.
- **FAULT**: the zone's heating is cut and locked. The label says why (probe, overheat, frozen
  probe, heating without effect) and a tip is shown below it. Once the cause is fixed, **Clear
  faults**.

On the base itself, with no cable and no phone:

- **The screen** shows the IP address at the bottom, or what is wrong (WIFI --, an MQTT code, AP
  config, ENTRETIEN). A **short press on BOOT** moves to the last 6 hours' curves, then to the
  network, probes and system pages;
  **3 s** shows the pairing QR; **10 s** opens the configuration network (to change routers).
- **The blue LED**: fast blinking, a zone in fault; steady, identification or test running; slow
  blinking, configuration network open; one flash per second, no Wi-Fi; double flash, MQTT
  refused; a short flash every five seconds, all is well.

## 9. Charts and statistics

The 6 h and 24 h charts come from the base, accurate to the minute. Over 7 and 30 days, the app
adds the points it noted in passing: opening the app from time to time is enough to fill these
charts. Wheel or pinch to zoom, drag to move, double-click to come back. **Export as CSV** gives
the file for a spreadsheet.

The 24 h statistics (min, max, average, share of time out of range, heating hours, kWh) tell
whether a terrarium **holds** its values, not only whether it reaches them.

The **Energy use** section adds up what the base heated since the 1st of the month, in kWh and in
euros, with a projection for the month and the year, a bar for each day (today in grey, in
progress) and the detail per mat. The price per kWh is set at the bottom of the screen: the one on
your contract. The base itself (board, display) counts as a fixed estimate of half a watt.

The **Log** section tells what happened, day by day: alerts and returns to normal, changed settings
(from the app or the local page), day and night changes, power cuts, support access, updates.
**Alerts**, **Settings** and **Base** filters. The base keeps its latest events; older ones are
erased on their own.

## 10. Being warned

- **Browser notifications**: a fault or a drift shows a notification as long as the app is open
  (even in the background). **Alerts** section.
- **On the phone, app closed**: the base itself calls a web address for each alert. Simplest: in
  the **Alerts** section, turn on "Alert sent by the base"; the app draws a private
  [ntfy](https://ntfy.sh) topic, gives it to the base, and shows how to subscribe your phone (free
  ntfy app, no account). The topic is only kept on this phone: whoever knows it can read the alerts.
  Another address (webhook, your own ntfy) is set in Service, or in "Alert URL" of the local page's
  Network tab; details in `docs/alertes-telephone.md`. With the Terrariums server: "Turn on server
  notifications" in the Alerts section, and the server pushes the alerts, titled with the name you
  give the base; an offline base is only announced after five minutes, and so is its return.
- **Test alert**: "Send a test alert", in the Alerts section, has the base send it through its alert
  address (and, with the server, a test notification): a way to check the whole chain before you
  need it.
- **Daily report** (local interface, General settings): at the chosen time, a summary of the day
  — temperatures, heating hours, kWh, cost, faults — sent to the alert URL (low priority on ntfy)
  and on the `rapport` MQTT topic.
- **Knowing it is alive**: the heartbeat URL called every five minutes; with
  [healthchecks.io](https://healthchecks.io), you are warned when the base goes quiet.
- **Home automation**: Home Assistant discovery can be enabled in the Network tab; `/metrics`
  exposes the readings for Prometheus.

## 11. Maintenance

- **Maintenance** (round button on the base's home): cuts the heating while you clean, then resumes by
  itself at the given time.
- **Settings backup** (Device section): a JSON file with setpoints, schedules and device settings,
  to import again on a spare base.
- **Base configuration backup** (local interface, Device tab): zones, settings, linked probes and
  alerts in one file, to restore on a replacement board. Wi-Fi and passwords are not in it; the
  alert URL is.
- **Daily summaries** (local interface, Device tab, or `jours`): a year of days — temperatures,
  heating hours, kWh and cost. The app's **Service** section shows the last month, the base's log and
  the daily report.
- **Remote base backup** (Service section): the same backup, downloaded or restored from the app, but
  without the alert and heartbeat addresses, which never leave the base over the Internet
  (restored, it keeps the base's own).
- **Alerts and monitoring** (Service section): the alert and heartbeat addresses can be replaced from
  the app; only their server shows afterwards (`ntfy.sh`), never the whole address. Wi-Fi is set
  on the local interface only.
- **Exports** (App settings, or a base's Curves): the **monthly logbook** as a PDF — the current
  month or the previous one: summary per zone, day-by-day curves, consumption, log alerts and a
  table — to share or keep; and **all readings** as CSV for a spreadsheet: 30 days, one line every
  5 minutes; one year, every 5 minutes with the Terrariums server, otherwise one line per day (the
  base keeps 14 days of fine readings and a year of summaries). With a Terrariums server that sends
  email, **Logbook by email** delivers a summary of the past month on the 1st of each month
  (temperatures of each zone, time close to the target, alerts seen by the server) for every base
  of the account; when turned on, last month's one is sent right away.
- **Copy settings** (App settings, or the Backup card of the Device section): from one base to
  another, or from a file, by family — targets (and cut-off), schedule and ramp, alerts and report.
  The preview shows the before and after of what changes; a faulty zone on the target is left
  untouched; "Cancel" puts everything back. **Export** writes a base's settings to a file encrypted
  with a password (lost if forgotten); **Import** reads that file, an older export, or the backup of
  the base's local page.
- **Restart**, **Erase history**: Device section. The app's local history is erased at the same time.

## 12. Updating

- **The app** updates itself: a "New version available — Reload" message appears. Nothing is
  forced in the middle of a setting.
- **The firmware**: in the app, **Updates** section, the **Firmware update** card says whether a newer
  version is published and a button makes the base **download and install it by itself**
  (signature checked if the base requires it). Otherwise: the workshop (USB), the
  Network tab of the local interface (upload of the `.bin` file, or "Update from GitHub"), or
  OTA from the IDE if an OTA password is set. The heating keeps running during the download or
  upload: it only stops for a few seconds, to connect, check the image and restart (before
  firmware 3.5.0 it was off for the whole write). At restart, the new version must declare itself
  healthy within a minute and a half, otherwise the base goes back to the previous version by
  itself — and the app shows "rolled back".
- **Automatic updates** (on out of the box): every day the base checks whether a version has been
  published. It lets you know (alert, server notification), then installs it **by itself at
  night**, between 03:00 and 05:00 by default, never during a fault, an autotune, a test,
  maintenance or support access, and only one attempt per night. New versions arrive in waves over
  a few days: yours may come after a neighbour's. In the **Updates** section, **Automatic updates**
  card: turn them off, change the window, **postpone 7 days** or **check now** (also in the Network
  tab of the local interface, or `maj auto non`, `maj plage 01:00 02:00`, `maj reporter 7` on the
  console). Nothing installs by itself on a base that does not require signed images: the card
  says so, and you then start the update by hand.
- **Never backwards remotely**: a version older than the running one is refused, even if signed.
  To roll back anyway, in the Network tab of the local interface, choose "allowed this time" under
  "Older or unknown version" before uploading the file.

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

**Help** (App settings) searches the user guide, even offline: type a word ("probe", "holiday"…),
each section that mentions it opens in one tap. The same page leads to the most frequent questions
and, with the Terrariums server, to asking for help.

On the support side, what the app diagnostics used to show (version, signal, memory, last restart
of each base) is in the base's sheet in the console and in its report (Service tab, team account).

On the base, the serial command `test usine` checks the screen, the probes, the memory, the
partitions and Wi-Fi in one go (`test usine oui` also drives each MOSFET for a fraction of a
second: never with an animal on it).

### Remote support (with the Terrariums server)

In a base's **Service** tab, the **Support** card lets you write to support and read their
answers (a notification tells you when they reply). If support needs to look at the base, they
ask you: the app shows it, and you choose **Allow support (24 h)** or **Decline**.

- Access lasts 24 hours; support may extend it for a deeper investigation (you are notified),
  never beyond 7 days. You close it at any time: **Close access** in the app, or on the base's
  local page.
- While access is open, the base's screen shows **Support connecté**; every action by support is
  written in the base's log (Service tab, or local page).
- Your pairing code never leaves your phone: the app draws a key valid for the duration of the
  access, which the base accepts and then refuses on its own. The 40 °C safety cut-off stays
  active whatever happens.
