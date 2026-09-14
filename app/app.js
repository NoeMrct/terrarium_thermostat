/* =============================================================================
   Application de pilotage des socles chauffants.
   -----------------------------------------------------------------------------
   Elle parle directement au broker MQTT en WebSocket : pas de serveur
   intermédiaire, donc rien à héberger ni à payer au démarrage.

   Deux principes structurent tout le fichier :

   1. Le socle est la source de vérité. L'application n'affiche que ce qu'il
      publie, et ne suppose jamais qu'une commande a abouti tant que la réponse
      n'est pas arrivée.
   2. Un socle hors ligne doit être visible comme tel, immédiatement. Le sujet
      « statut » est persistant et pourvu d'un testament : le broker publie
      lui-même « hors ligne » si le socle disparaît, sans que personne ait à
      l'interroger.
   ============================================================================= */

const App = (() => {

  const CLE_CONFIG = 'terrarium.config.v1';
  const DELAI_COMMANDE = 8000;      // au-delà, on considère le socle injoignable

  let config = { broker: null, socles: [] };
  let client = null;
  let vueCourante = 'broker';
  let socleOuvert = null;
  let panneau = 'etat';             // etat | reglages | courbes | general
  const etats = {};                 // id -> { enLigne, zones, uptime, entretienS }
  const attentes = {};              // req -> { resoudre, rejeter, minuteur }
  const courbes = {};               // id -> { heures, points, chargement, erreur }
  const stats = {};                 // id -> reponse de l'action « stats »
  const generaux = {};              // id -> reponse de l'action « globaux »
  // Dernier etat de defaut connu par zone, pour ne notifier qu'au changement.
  const alertesVues = {};           // id -> [libelle|null, …]

  // ---------------------------------------------------------------- stockage
  // Le code d'appairage est un secret : il vit dans le stockage local du
  // navigateur, jamais sur un serveur. Contrepartie assumée, expliquée à
  // l'utilisateur : quelqu'un ayant accès au téléphone déverrouillé y accède.
  function charger() {
    try {
      const brut = localStorage.getItem(CLE_CONFIG);
      if (brut) config = JSON.parse(brut);
    } catch (e) {
      console.warn('Configuration illisible, on repart de zéro', e);
    }
    if (!Array.isArray(config.socles)) config.socles = [];
  }

  function sauver() {
    localStorage.setItem(CLE_CONFIG, JSON.stringify(config));
  }

  // ------------------------------------------------------------------- MQTT
  function base(id) { return `${config.broker.prefixe}/${id}`; }

  function connecter() {
    if (!config.broker || !config.broker.url) { montrer('broker'); return; }

    lien('connexion…', 'attente');
    client = mqtt.connect(config.broker.url, {
      username: config.broker.user,
      password: config.broker.pass,
      clean: true,
      reconnectPeriod: 4000,
      connectTimeout: 8000,
      // Identifiant unique : deux onglets ouverts ne doivent pas se déconnecter
      // mutuellement, ce que fait un broker quand deux clients partagent un id.
      clientId: 'app-' + Math.random().toString(16).slice(2, 10)
    });

    client.on('connect', () => {
      lien('connecté', 'ok');
      config.socles.forEach(abonner);
      // Un socle déjà en ligne ne republiera son état que dans vingt secondes :
      // on le demande tout de suite pour ne pas afficher une page vide.
      config.socles.forEach(s => commander(s.id, 'etat').catch(() => {}));
    });

    client.on('reconnect', () => lien('reconnexion…', 'attente'));
    client.on('close',     () => lien('hors ligne', 'ko'));
    client.on('error', e => { lien('erreur : ' + e.message, 'ko'); });
    client.on('message', recevoir);
  }

  function abonner(socle) {
    if (!client || !client.connected) return;
    const b = base(socle.id);
    // Le joker MQTT occupe un niveau entier : « zone+/etat » est un filtre
    // invalide que le broker rejette, et le rejet emporte tout l'abonnement.
    client.subscribe([`${b}/statut`, `${b}/+/etat`, `${b}/reponse`]);
  }

  // Le socle décrit son état sous deux formes : les sujets « /etat », taillés
  // pour Home Assistant, où « defaut » vaut la chaîne "0" ou "1" ; et la réponse
  // à la commande « etat », où il vaut null ou le libellé du défaut. Sans cette
  // normalisation, une zone parfaitement saine s'afficherait en panne, puisque
  // la chaîne "0" est vraie en JavaScript.
  function normaliser(z, precedent) {
    if (!z) return z;
    // Les deux sources ne portent pas les mêmes champs : le sujet « /etat »
    // publie jour/nuit/charge, la réponse à la commande « etat » ne les a pas.
    // Repartir du seul message courant effaçait donc des valeurs déjà connues.
    const n = { ...(precedent || {}), ...z };
    const d = z.defaut;
    const enPanne = d === true || d === 1 || d === '1' ||
                    (typeof d === 'string' && d !== '' && d !== '0' && d.toUpperCase() !== 'OK');
    if (!enPanne) n.defaut = null;
    else if (z.defaut_libelle && z.defaut_libelle !== 'OK') n.defaut = z.defaut_libelle;
    else if (typeof d === 'string' && d !== '1') n.defaut = d;
    else n.defaut = 'DÉFAUT';
    n.chauffe = z.chauffe === true || z.chauffe === 1 || z.chauffe === '1';
    n.autotune = z.autotune === true || z.autotune === 1 || z.autotune === '1';
    n.derive = z.derive === true || z.derive === 1 || z.derive === '1';
    return n;
  }

  // --------------------------------------------------------- notifications
  // Une alerte n'a d'intérêt que si elle arrive quand on ne regarde pas. Les
  // notifications du navigateur sont le seul canal disponible sans serveur :
  // pas de push (il faudrait une infrastructure), donc elles ne partent que
  // pendant que l'application est ouverte, même en arrière-plan. C'est dit à
  // l'utilisateur plutôt que promis à tort — le webhook du socle reste le
  // moyen sûr d'être prévenu appareil éteint.
  function notificationsPossibles() {
    return typeof Notification !== 'undefined' && window.isSecureContext !== false;
  }

  function etatNotifications() {
    if (!notificationsPossibles()) return 'indisponible';
    return Notification.permission;             // 'granted' | 'denied' | 'default'
  }

  function notifier(titre, corps) {
    if (etatNotifications() !== 'granted') return;
    try { new Notification(titre, { body: corps, tag: titre, icon: 'icone.svg' }); }
    catch (e) { /* certains navigateurs mobiles exigent un agent de service */ }
  }

  // Compare l'état reçu à celui d'avant et ne notifie qu'aux transitions : sans
  // cela, chaque publication du socle (toutes les 20 s) rejouerait l'alerte.
  function surveillerAlertes(id) {
    const e = etats[id];
    if (!e || !e.zones) return;
    const socle = config.socles.find(s => s.id === id);
    const nom = (socle && socle.nom) || id;
    if (!alertesVues[id]) alertesVues[id] = [];
    e.zones.forEach((z, i) => {
      if (!z) return;
      const courant = z.defaut || (z.derive ? 'derive' : null);
      const precedent = alertesVues[id][i];
      if (courant === precedent) return;
      alertesVues[id][i] = courant;
      if (precedent === undefined) return;      // premier état connu : rien à signaler
      const nomZone = z.nom || ('zone ' + (i + 1));
      if (courant === 'derive')      notifier(nom + ' — dérive', nomZone + ' s\'éloigne de sa consigne.');
      else if (courant)              notifier(nom + ' — DÉFAUT', nomZone + ' : ' + courant + '. Chauffage coupé.');
      else                           notifier(nom + ' — rétabli', nomZone + ' est revenue à la normale.');
    });
  }

  function recevoir(sujet, charge) {
    const texte = charge.toString();
    const parts = sujet.split('/');
    const id = parts[1];
    if (!etats[id]) etats[id] = { enLigne: false, zones: [] };
    const e = etats[id];

    if (sujet.endsWith('/statut')) {
      e.enLigne = (texte === 'en ligne');
    } else if (sujet.endsWith('/etat')) {
      const n = parseInt(parts[2].replace('zone', ''), 10) - 1;
      try { e.zones[n] = normaliser(JSON.parse(texte), e.zones[n]); } catch (err) { return; }
      e.enLigne = true;
      e.derniereMaj = Date.now();
    } else if (sujet.endsWith('/reponse')) {
      let r; try { r = JSON.parse(texte); } catch (err) { return; }
      const a = attentes[r.req];
      if (a) {
        clearTimeout(a.minuteur);
        delete attentes[r.req];
        r.ok ? a.resoudre(r) : a.rejeter(new Error(r.erreur || 'refusé par le socle'));
      }
      // Une réponse « etat » porte les mêmes données qu'une publication.
      if (r.ok && r.zones) {
        e.zones = r.zones.map((z, i) => normaliser(z, e.zones[i]));
        e.uptime = r.uptime; e.entretienS = r.entretienS; e.enLigne = true;
        if (r.heure !== undefined) e.heure = r.heure;
        if (r.zonesSimultanees !== undefined) e.zonesSimultanees = r.zonesSimultanees;
        if (r.saison !== undefined) e.saison = r.saison;
        if (r.alertesEnAttente !== undefined) e.alertesEnAttente = r.alertesEnAttente;
      }
    }
    surveillerAlertes(id);
    dessiner();
  }

  // Envoie une commande et attend sa réponse. Le délai n'est pas facultatif :
  // un socle hors ligne ne répond jamais, et l'interface doit le dire plutôt
  // que de rester figée sur un bouton qui tourne.
  function commander(id, action, params = {}) {
    return new Promise((resoudre, rejeter) => {
      if (!client || !client.connected) { rejeter(new Error('pas de connexion au broker')); return; }
      const socle = config.socles.find(s => s.id === id);
      if (!socle) { rejeter(new Error('socle inconnu')); return; }

      const req = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      attentes[req] = {
        resoudre, rejeter,
        minuteur: setTimeout(() => {
          delete attentes[req];
          rejeter(new Error('le socle n\'a pas répondu'));
        }, DELAI_COMMANDE)
      };
      client.publish(base(id) + '/cmd',
        JSON.stringify({ req, action, jeton: socle.jeton, ...params }));
    });
  }

  // --------------------------------------------------------------- affichage
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s)
    .replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  function lien(texte, classe) {
    const el = $('#lien');
    el.textContent = texte;
    el.className = 'etat ' + classe;
  }

  function message(texte, erreur = false) {
    const el = $('#message');
    el.textContent = texte;
    el.className = 'visible' + (erreur ? ' erreur' : '');
    clearTimeout(message.t);
    message.t = setTimeout(() => { el.className = ''; }, 4000);
  }

  function montrer(vue) {
    vueCourante = vue;
    ['broker', 'liste', 'socle'].forEach(v => {
      $('#vue-' + v).style.display = (v === vue) ? '' : 'none';
    });
    dessiner();
  }

  function pastilleZone(z, couleur) {
    if (!z) return '<div class="zone vide">en attente de données…</div>';
    const defaut = z.defaut
      ? `<div class="defaut">DÉFAUT : ${esc(z.defaut)}</div>` : '';
    return `<div class="zone">
      <div class="titre">${esc(z.nom || 'Zone')}</div>
      <div class="temp" style="color:${couleur}">${z.defaut ? '—' : z.temp.toFixed(1) + '<small> °C</small>'}</div>
      ${defaut}
      <div class="aide">cible ${z.consigne.toFixed(1)} °C · demande ${z.demande} %
        ${z.chauffe ? '· <b>chauffe</b>' : ''}</div>
    </div>`;
  }

  function dessiner() {
    if (vueCourante === 'liste') dessinerListe();
    if (vueCourante === 'socle') dessinerSocle();
  }

  function dessinerListe() {
    const c = ['#5cf', '#fa6'];
    $('#socles').innerHTML = config.socles.length === 0
      ? '<div class="carte aide">Aucun socle. Ajoute-en un ci-dessous.</div>'
      : config.socles.map(s => {
        const e = etats[s.id] || {};
        const alerte = (e.zones || []).some(z => z && z.defaut);
        return `<div class="carte socle ${alerte ? 'alerte' : ''}" onclick="App.ouvrir('${esc(s.id)}')">
          <div class="rangee entre">
            <h2>${esc(s.nom || s.id)}</h2>
            <span class="badge ${e.enLigne ? 'ok' : 'ko'}">${e.enLigne ? 'en ligne' : 'hors ligne'}</span>
          </div>
          <div class="zones">${(e.zones || [null, null]).map((z, i) => pastilleZone(z, c[i])).join('')}</div>
        </div>`;
      }).join('');
  }

  // Minutes depuis minuit <-> HH:MM. Le socle raisonne en minutes, l'utilisateur
  // en heures : la conversion vit ici, comme dans le firmware.
  const enHHMM = m => (m === undefined || m === null || m === '') ? ''
    : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  function depuisHHMM(t) {
    const m = /^\s*(\d{1,2}):(\d{1,2})\s*$/.exec(t || '');
    if (!m) return null;
    const h = +m[1], mn = +m[2];
    return (h > 23 || mn > 59) ? null : h * 60 + mn;
  }

  const ONGLETS = [['etat', 'État'], ['reglages', 'Réglages'], ['courbes', 'Courbes'], ['general', 'Appareil']];
  const COULEURS = ['#5cf', '#fa6'];

  // ------------------------------------------------------------- panneaux
  function panneauEtat(e) {
    let h = '';
    (e.zones || []).forEach((z, i) => {
      if (!z) return;
      h += `<div class="carte">
        <div class="zones">${pastilleZone(z, COULEURS[i])}</div>
        <div class="rangee">
          <div><label>Jour °C</label><input id="j${i}" value="${z.jour !== undefined ? z.jour : ''}" placeholder="inchangé"></div>
          <div><label>Nuit °C</label><input id="n${i}" value="${z.nuit !== undefined ? z.nuit : ''}" placeholder="inchangé"></div>
        </div>
        <button onclick="App.reglerZone(${i})">Enregistrer</button>
        ${z.autotune
          ? `<button class="danger" onclick="App.action('stop-autotune',{z:${i}})">Arrêter l'autotune</button>`
          : `<button class="secondaire" onclick="App.action('autotune',{z:${i}})">Autotune</button>`}
      </div>`;
    });
    h += `<div class="carte">
      <h2>Actions</h2>
      <div class="rangee">
        <button class="secondaire" onclick="App.action('entretien',{minutes:10})">Entretien 10 min</button>
        <button class="secondaire" onclick="App.action('entretien',{minutes:0})">Annuler</button>
        <button class="secondaire" onclick="App.action('reset')">Lever les défauts</button>
      </div></div>`;
    return h;
  }

  // Tous les réglages d'une zone, et pas seulement les deux consignes : sans
  // cela, changer un horaire ou un seuil de sécurité obligeait à revenir sur le
  // réseau local du terrarium.
  function panneauReglages(e) {
    let h = '';
    (e.zones || []).forEach((z, i) => {
      if (!z) return;
      const champ = (id, etiquette, valeur, aide) =>
        `<div><label>${etiquette}</label><input id="${id}${i}" value="${valeur === undefined ? '' : valeur}"
          ${aide ? `title="${aide}"` : ''} placeholder="inchangé"></div>`;
      h += `<div class="carte">
        <h2 style="color:${COULEURS[i]}">${esc(z.nom || 'Zone ' + (i + 1))}</h2>
        <label>Nom</label><input id="N${i}" value="${esc(z.nom || '')}">
        <div class="rangee">
          ${champ('j', 'Jour °C', z.jour)}
          ${champ('n', 'Nuit °C', z.nuit)}
          ${champ('H', 'Début jour', enHHMM(z.debutJour))}
          ${champ('K', 'Début nuit', enHHMM(z.debutNuit))}
          ${champ('R', 'Rampe (min)', z.rampe)}
          ${champ('b', 'Bande °C', z.bande)}
          ${champ('m', 'Coupure max °C', z.max)}
          ${champ('o', 'Calibration °C', z.offset)}
        </div>
        <p class="aide">La coupure max est une sécurité absolue : au-dessus, la zone
          se verrouille en défaut. Elle doit rester au-dessus des deux consignes.</p>
        <button onclick="App.reglerZoneComplet(${i})">Enregistrer</button>
      </div>`;
    });
    if (!h) h = '<div class="carte aide">En attente des réglages du socle…</div>';
    return h;
  }

  function panneauCourbes(id) {
    const c = courbes[id] || {};
    const durees = [6, 24, 72, 168];
    return `<div class="carte">
      <div class="rangee">${durees.map(d =>
        `<button class="${(c.heures || 24) === d ? '' : 'secondaire'}" onclick="App.courbes(${d})">${
          d < 48 ? d + ' h' : (d / 24) + ' j'}</button>`).join('')}</div>
      <canvas id="courbe" width="720" height="240"></canvas>
      <div class="aide" id="legendeCourbe">${
        c.chargement ? 'Chargement…'
        : c.erreur ? esc(c.erreur)
        : (c.points && c.points.length)
          ? `${c.points.length} point(s) · trait plein : température, pointillés : consigne`
          : 'Aucun point sur cette période.'}</div>
      <p class="aide">L'historique reste sur le socle : il n'est jamais recopié sur le
        broker. Ce que tu vois ici est ce qu'il vient d'envoyer, à la demande.</p>
    </div>`;
  }

  function panneauGeneral(s, e) {
    const g = generaux[s.id];
    const st = stats[s.id];
    let h = `<div class="carte">
      <h2>Alimentation et saison</h2>`;
    if (!g) {
      h += `<div class="aide">Chargement des réglages de l'appareil…</div>`;
    } else {
      h += `<div class="rangee">
        <div><label>Ampérage (A)</label><input id="gA" value="${g.amperes}"></div>
        <div><label>Tapis (W)</label><input id="gW" value="${g.watts}"></div>
        <div><label>Tension (V)</label><input id="gV" value="${g.volts}"></div>
      </div>
      <div class="aide">${g.zonesSimultanees} zone(s) peuvent chauffer en même temps.</div>
      <div class="rangee">
        <div><label>Cyclage saisonnier</label><select id="gSA">
          <option value="0"${g.saisonActive ? '' : ' selected'}>inactif</option>
          <option value="1"${g.saisonActive ? ' selected' : ''}>actif</option></select></div>
        <div><label>Abaissement (°C)</label><input id="gSD" value="${g.saisonDelta}"></div>
        <div><label>Descente (j)</label><input id="gS1" value="${g.saisonDescenteJ}"></div>
        <div><label>Plateau (j)</label><input id="gS2" value="${g.saisonPlateauJ}"></div>
        <div><label>Remontée (j)</label><input id="gS3" value="${g.saisonRemonteeJ}"></div>
      </div>
      <div class="aide">${g.saisonActive
        ? 'Décalage appliqué en ce moment : ' + Number(g.decalageActuel).toFixed(2) + ' °C'
        : 'Aucun décalage appliqué.'}</div>
      <button onclick="App.reglerGeneraux()">Enregistrer</button>`;
    }
    h += `</div>`;

    h += `<div class="carte"><h2>Sur 24 heures</h2>`;
    if (!st) h += `<div class="aide">Chargement des statistiques…</div>`;
    else {
      h += (st.zones || []).map((z, i) => `<div style="margin-top:9px">
        <b style="color:${COULEURS[i]}">${esc(z.nom)}</b>
        <div class="aide">${z.points
          ? `min ${z.min.toFixed(1)} °C · max ${z.max.toFixed(1)} °C · moyenne ${z.moyenne.toFixed(1)} °C
             · hors plage ${z.horsPlagePct} % du temps<br>`
          : 'Pas encore assez d\'historique.<br>'}
          Chauffe cumulée ${z.heuresChauffe.toFixed(1)} h · ${z.kWh.toFixed(2)} kWh<br>
          Défauts : sonde ${z.defauts.sonde} · surchauffe ${z.defauts.surchauffe} · sonde figée ${z.defauts.figee}
        </div></div>`).join('');
      h += `<div class="aide" style="margin-top:9px">Firmware ${esc(st.version)}</div>`;
    }
    h += `</div>`;

    const notifs = etatNotifications();
    h += `<div class="carte"><h2>Notifications</h2>
      <p class="aide">${
        notifs === 'granted'
          ? 'Activées : un défaut ou une dérive fait apparaître une notification, même onglet en arrière-plan. Elles ne partent que pendant que l\'application est ouverte — pour être prévenu appareil éteint, configure l\'URL d\'alerte du socle.'
        : notifs === 'denied'
          ? 'Refusées pour ce site. C\'est un réglage du navigateur, à rouvrir depuis lui.'
        : notifs === 'indisponible'
          ? 'Indisponibles ici : le navigateur ne les propose qu\'en HTTPS.'
          : 'Un défaut ou une dérive peut faire apparaître une notification pendant que l\'application est ouverte.'
      }</p>
      ${notifs === 'default' ? '<button class="secondaire" onclick="App.activerNotifications()">Activer les notifications</button>' : ''}
      </div>`;

    h += `<div class="carte">
      <h2>Entretien de l'appareil</h2>
      <div class="rangee">
        <button class="secondaire" onclick="App.action('redemarrer')">Redémarrer le socle</button>
        <button class="danger" onclick="App.effacerHistorique()">Effacer l'historique</button>
      </div>
      <p class="aide">Les réglages réseau, le journal et la mise à jour du firmware
        restent sur l'interface locale du socle, sur ton réseau domestique.</p>
      <button class="danger" onclick="App.retirerSocle()">Retirer ce socle de l'application</button>
    </div>`;
    return h;
  }

  // --------------------------------------------------------------- courbes
  // Les points arrivent en centièmes de degré, dans un tableau compact
  // [epoch, t1, consigne1, t2, consigne2] : une clé par valeur aurait triplé la
  // taille du message MQTT, dont le tampon n'est pas extensible.
  function tracerCourbes(id) {
    const c = courbes[id];
    const el = $('#courbe');
    if (!el || !c || !c.points || !c.points.length) return;
    const x = el.getContext('2d');
    if (!x) return;
    x.clearRect(0, 0, el.width, el.height);

    const p = c.points;
    let lo = Infinity, hi = -Infinity;
    p.forEach(q => q.slice(1).forEach(v => { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    if (!isFinite(lo) || !isFinite(hi)) return;
    lo = lo / 100 - 1; hi = hi / 100 + 1;

    const t0 = p[0][0], t1 = p[p.length - 1][0] || t0 + 1;
    const X = e => (e - t0) / Math.max(1, t1 - t0) * (el.width - 6) + 3;
    const Y = v => el.height - 16 - (v - lo) / Math.max(0.1, hi - lo) * (el.height - 28);

    x.strokeStyle = '#2c2c2c'; x.lineWidth = 1; x.beginPath();
    for (let k = 0; k <= 4; k++) { const y = Y(lo + (hi - lo) * k / 4); x.moveTo(0, y); x.lineTo(el.width, y); }
    x.stroke();
    x.fillStyle = '#777'; x.font = '11px sans-serif';
    for (let k = 0; k <= 4; k++) x.fillText((lo + (hi - lo) * k / 4).toFixed(1), 4, Y(lo + (hi - lo) * k / 4) - 3);
    for (let k = 0; k <= 4; k++) {
      const e = t0 + (t1 - t0) * k / 4, d = new Date(e * 1000);
      x.fillText(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'),
                 Math.min(el.width - 32, Math.max(0, X(e) - 16)), el.height - 3);
    }
    for (let z = 0; z < 2; z++) {
      [[1 + z * 2, false], [2 + z * 2, true]].forEach(([col, pointille]) => {
        x.strokeStyle = COULEURS[z];
        x.lineWidth = pointille ? 1 : 1.8;
        x.setLineDash(pointille ? [4, 4] : []);
        x.beginPath();
        let n = 0;
        p.forEach(q => {
          const v = q[col];
          if (v === null || v === undefined) { n = 0; return; }
          n++ ? x.lineTo(X(q[0]), Y(v / 100)) : x.moveTo(X(q[0]), Y(v / 100));
        });
        x.stroke();
      });
    }
    x.setLineDash([]);
  }

  function dessinerSocle() {
    const s = config.socles.find(x => x.id === socleOuvert);
    if (!s) { montrer('liste'); return; }
    const e = etats[s.id] || {};

    let h = `<div class="carte">
      <div class="rangee entre">
        <h2>${esc(s.nom || s.id)}</h2>
        <span class="badge ${e.enLigne ? 'ok' : 'ko'}">${e.enLigne ? 'en ligne' : 'hors ligne'}</span>
      </div>
      <div class="aide">${esc(s.id)}${e.uptime ? ' · ' + Math.floor(e.uptime / 3600) + ' h de service' : ''}
      ${e.entretienS ? ' · <b class="warn">entretien : ' + Math.ceil(e.entretienS / 60) + ' min</b>' : ''}
      ${e.alertesEnAttente ? ' · <b class="warn">' + e.alertesEnAttente + ' alerte(s) en attente</b>' : ''}</div>
    </div>`;

    if (!e.enLigne) {
      h += `<div class="carte aide">Ce socle ne répond pas. Il continue de réguler
        tout seul : seule la commande à distance est indisponible.</div>`;
    }

    h += `<div class="onglets">${ONGLETS.map(([k, t]) =>
      `<button class="${panneau === k ? '' : 'secondaire'}" onclick="App.panneau('${k}')">${t}</button>`).join('')}</div>`;

    if (panneau === 'etat')          h += panneauEtat(e);
    else if (panneau === 'reglages') h += panneauReglages(e);
    else if (panneau === 'courbes')  h += panneauCourbes(s.id);
    else                             h += panneauGeneral(s, e);

    // Le socle publie toutes les quelques secondes, ce qui reconstruit cette
    // vue : sans cette précaution, un champ en cours de saisie était effacé
    // sous les doigts de l'utilisateur.
    const actif = elementFocalise();
    const focus = actif && actif.id && actif.tagName === 'INPUT'
      ? { id: actif.id, valeur: actif.value, debut: actif.selectionStart, fin: actif.selectionEnd }
      : null;

    $('#detail').innerHTML = h;

    if (focus) {
      const el = document.getElementById(focus.id);
      if (el) {
        el.value = focus.valeur;
        el.focus();
        try { el.setSelectionRange(focus.debut, focus.fin); } catch (e) { /* type non concerné */ }
      }
    }
    // Le canevas n'existe qu'une fois le HTML posé : le tracé vient après.
    if (panneau === 'courbes') tracerCourbes(socleOuvert);
  }

  // Les navigateurs renvoient <body> quand rien n'a le focus.
  function elementFocalise() {
    const a = document.activeElement;
    return a && a !== document.body ? a : null;
  }

  // ----------------------------------------------------------------- actions
  return {
    demarrer() {
      charger();
      if (config.broker && config.broker.url) { connecter(); montrer('liste'); }
      else montrer('broker');
      if (navigator.serviceWorker) navigator.serviceWorker.register('sw.js').catch(() => {});
      if (!('BarcodeDetector' in window)) $('#btn-scan').style.display = 'none';
    },

    montrer,

    enregistrerBroker() {
      const url = $('#b-url').value.trim();
      // ws:// n'est toléré qu'en développement local : sur un vrai réseau, une
      // liaison non chiffrée exposerait les codes d'appairage en clair.
      const local = ['localhost', '127.0.0.1'].includes(location.hostname);
      if (!/^wss:\/\//.test(url) && !(local && /^ws:\/\//.test(url))) {
        message('L\'adresse doit commencer par wss:// — sans chiffrement, tes codes d\'appairage circuleraient en clair.', true);
        return;
      }
      config.broker = {
        url,
        user: $('#b-user').value.trim(),
        pass: $('#b-pass').value,
        prefixe: ($('#b-prefixe').value.trim() || 'terrarium')
      };
      sauver();
      connecter();
      montrer('liste');
    },

    oublierBroker() {
      if (!confirm('Oublier ce broker ? Les socles enregistrés seront conservés.')) return;
      config.broker = null;
      sauver();
      if (client) { client.end(true); client = null; }
      montrer('broker');
    },

    ajouterSocle() {
      const id = $('#a-id').value.trim();
      const jeton = $('#a-jeton').value.trim().replace(/[\s-]/g, '').toUpperCase();
      const nom = $('#a-nom').value.trim();
      if (!id) { message('Identifiant manquant.', true); return; }
      if (jeton.length !== 24) { message('Le code d\'appairage fait 24 caractères.', true); return; }
      if (config.socles.some(s => s.id === id)) { message('Ce socle est déjà enregistré.', true); return; }

      const socle = { id, jeton, nom: nom || id };
      config.socles.push(socle);
      sauver();
      abonner(socle);
      commander(id, 'etat').catch(() => {});
      ['#a-id', '#a-jeton', '#a-nom'].forEach(s => { $(s).value = ''; });
      message('Socle ajouté.');
      dessiner();
    },

    retirerSocle() {
      if (!confirm('Retirer ce socle de l\'application ? Cela ne change rien à son fonctionnement.')) return;
      // Se désabonner aussi : sans cela, le broker continuait d'envoyer l'état
      // d'un socle retiré, qui réapparaissait dans les notifications et
      // consommait de la bande passante pour rien.
      if (client && client.connected && config.broker) {
        const b = base(socleOuvert);
        try { client.unsubscribe([`${b}/statut`, `${b}/+/etat`, `${b}/reponse`]); } catch (e) { /* déjà parti */ }
      }
      delete etats[socleOuvert];
      delete courbes[socleOuvert];
      delete stats[socleOuvert];
      delete generaux[socleOuvert];
      delete alertesVues[socleOuvert];
      config.socles = config.socles.filter(s => s.id !== socleOuvert);
      sauver();
      montrer('liste');
    },

    ouvrir(id) {
      socleOuvert = id;
      panneau = 'etat';
      montrer('socle');
      commander(id, 'etat').catch(() => {});
    },

    // Change de panneau et charge ce qui lui manque. Rien n'est demandé au socle
    // avant d'en avoir besoin : chaque requête traverse le broker, et un socle
    // hors ligne ne répondra de toute façon pas.
    panneau(nom) {
      panneau = nom;
      dessiner();
      const id = socleOuvert;
      if (!id) return;
      if (nom === 'courbes' && !courbes[id]) this.courbes(24);
      if (nom === 'general') {
        if (!generaux[id]) commander(id, 'globaux').then(r => { generaux[id] = r; dessiner(); }).catch(() => {});
        if (!stats[id])    commander(id, 'stats').then(r => { stats[id] = r; dessiner(); }).catch(() => {});
      }
    },

    async courbes(heures) {
      const id = socleOuvert;
      if (!id) return;
      courbes[id] = { heures, chargement: true, points: (courbes[id] || {}).points };
      dessiner();
      try {
        const r = await commander(id, 'historique', { heures, max: 120 });
        courbes[id] = { heures, points: r.points || [] };
      } catch (e) {
        courbes[id] = { heures, points: [], erreur: e.message };
      }
      dessiner();
    },

    async activerNotifications() {
      if (!notificationsPossibles()) { message('Notifications indisponibles sur cette page.', true); return; }
      try {
        const r = await Notification.requestPermission();
        message(r === 'granted' ? 'Notifications activées.' : 'Notifications refusées.', r !== 'granted');
      } catch (e) { message('Notifications indisponibles : ' + e.message, true); }
      dessiner();
    },

    async effacerHistorique() {
      if (!confirm('Effacer l\'historique de ce socle ? Les courbes repartent de zéro.')) return;
      try {
        await commander(socleOuvert, 'effacer-historique');
        delete courbes[socleOuvert];
        message('Historique effacé.');
        dessiner();
      } catch (e) { message(e.message, true); }
    },

    // Enregistre TOUS les réglages d'une zone d'un coup. Les champs laissés
    // vides ne sont pas envoyés : « vide » veut dire « inchangé », jamais zéro.
    async reglerZoneComplet(i) {
      const nombre = id => {
        const el = $('#' + id + i);
        if (!el || el.value.trim() === '') return undefined;
        const v = parseFloat(el.value);
        return isNaN(v) ? undefined : v;
      };
      const params = { z: i };
      const nom = $('#N' + i);
      if (nom && nom.value.trim()) params.nom = nom.value.trim();
      const champs = { j: 'jour', n: 'nuit', R: 'rampe', b: 'bande', m: 'max', o: 'offset' };
      for (const [id, cle] of Object.entries(champs)) {
        const v = nombre(id);
        if (v !== undefined) params[cle] = cle === 'rampe' ? Math.round(v) : v;
      }
      for (const [id, cle] of [['H', 'debutJour'], ['K', 'debutNuit']]) {
        const el = $('#' + id + i);
        if (!el || el.value.trim() === '') continue;
        const m = depuisHHMM(el.value);
        if (m === null) { message('Horaire invalide : « ' + el.value +' », attendu HH:MM.', true); return; }
        params[cle] = m;
      }
      try {
        await commander(socleOuvert, 'zone', params);
        message('Réglages enregistrés.');
        commander(socleOuvert, 'etat').catch(() => {});
      } catch (e) { message(e.message, true); }
    },

    async reglerGeneraux() {
      const nombre = id => {
        const el = $('#' + id);
        if (!el || el.value.trim() === '') return undefined;
        const v = parseFloat(el.value);
        return isNaN(v) ? undefined : v;
      };
      const params = {};
      for (const [id, cle] of [['gA', 'amperes'], ['gW', 'watts'], ['gV', 'volts'],
                               ['gSD', 'saisonDelta']]) {
        const v = nombre(id);
        if (v !== undefined) params[cle] = v;
      }
      for (const [id, cle] of [['gS1', 'saisonDescenteJ'], ['gS2', 'saisonPlateauJ'], ['gS3', 'saisonRemonteeJ']]) {
        const v = nombre(id);
        if (v !== undefined) params[cle] = Math.round(v);
      }
      const sa = $('#gSA');
      if (sa) params.saisonActive = sa.value === '1';
      try {
        const r = await commander(socleOuvert, 'globaux', params);
        generaux[socleOuvert] = r;
        message(`Enregistré : ${r.zonesSimultanees} zone(s) simultanée(s).`);
        dessiner();
      } catch (e) { message(e.message, true); }
    },

    async reglerZone(i) {
      const jour = parseFloat($('#j' + i).value);
      const nuit = parseFloat($('#n' + i).value);
      const params = { z: i };
      if (!isNaN(jour)) params.jour = jour;
      if (!isNaN(nuit)) params.nuit = nuit;
      try {
        await commander(socleOuvert, 'zone', params);
        message('Réglages enregistrés.');
      } catch (e) {
        // Le message vient du socle lui-même : il connaît ses propres limites.
        message(e.message, true);
      }
    },

    async action(nom, params) {
      try {
        const r = await commander(socleOuvert, nom, params);
        message(r.zonesSimultanees
          ? `Enregistré : ${r.zonesSimultanees} zone(s) simultanée(s).`
          : 'Commande acceptée.');
        setTimeout(() => commander(socleOuvert, 'etat').catch(() => {}), 800);
      } catch (e) {
        message(e.message, true);
      }
    },

    // Lecture du QR code collé sous le socle, quand le navigateur sait le faire.
    async scanner() {
      try {
        const flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = document.createElement('video');
        video.srcObject = flux; video.setAttribute('playsinline', ''); await video.play();
        const detecteur = new BarcodeDetector({ formats: ['qr_code'] });
        const fin = Date.now() + 20000;
        const boucle = async () => {
          if (Date.now() > fin) { flux.getTracks().forEach(t => t.stop()); message('Aucun QR détecté.', true); return; }
          const codes = await detecteur.detect(video).catch(() => []);
          if (codes.length) {
            flux.getTracks().forEach(t => t.stop());
            // Format attendu : terrarium:<id>:<jeton>
            const m = /^terrarium:([^:]+):([A-Z0-9]{24})$/.exec(codes[0].rawValue || '');
            if (!m) { message('QR non reconnu.', true); return; }
            $('#a-id').value = m[1]; $('#a-jeton').value = m[2];
            message('Code lu, complète le nom puis valide.');
            return;
          }
          requestAnimationFrame(boucle);
        };
        boucle();
      } catch (e) {
        message('Caméra indisponible : ' + e.message, true);
      }
    }
  };
})();

window.addEventListener('load', () => App.demarrer());
