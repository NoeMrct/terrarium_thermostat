/* =============================================================================
   Atelier : monter des socles en série, du flashage à l'étiquette.
   -----------------------------------------------------------------------------
   Cinq étapes par socle, suivies dans un registre gardé par ce navigateur :

     1. Console (USB, 12 V débranché) : une carte vierge, ou en retard sur le
        firmware publié, le reçoit d'abord (fenêtre d'ESP Web Tools, sur le
        même port) ; puis identité et code d'appairage (« jeton »), version,
        auto-test usine, mot de passe de la page locale tiré ici et donné au
        socle, Wi-Fi du banc, liaison MQTT (compte d'appareil créé sur le
        serveur Terrariums, ou broker de l'atelier).
     2. Sondes (12 V, sur le banc, par le broker) : chaque sonde serrée dans la
        main est liée à sa zone (« identifier »).
     3. Chauffe : essai de chaque tapis, verdict du socle (« essai »).
     4. Rodage : le socle tourne seul ; l'atelier note redémarrages, défauts et
        coupures, et conclut sur sa durée de fonctionnement sans interruption.
     5. Étiquette : un socle en firmware 3.5.1 resté sur le banc s'y prépare
        par le réseau (action « expedier » : Wi-Fi du banc oublié, historique
        vidé ; il affiche « Pret a expedier » et sa référence jusqu'à son
        débranchement, l'étiquette va sur celui qui l'affiche) ; sinon par
        l'USB, qui relit l'identité. L'étiquette s'imprime ; à l'expédition,
        le code et le mot de passe sont effacés de ce navigateur — ils ne
        sont plus que sur l'étiquette.

   USB et 12 V ne sont jamais branchés ensemble : la console ne sert qu'aux
   étapes 1 et 5, le banc (MQTT) aux étapes 2 à 4 (et 5 depuis la 3.5.1). Sans liaison, les étapes 2
   à 4 se font sur la page locale du socle et l'opérateur les valide ici.

   Le serveur Terrariums est celui du déploiement (balise terrarium-serveur).
   L'atelier s'y connecte avec un compte de l'équipe — administrateur ou rôle
   « atelier » (code reçu par e-mail, session gardée dans ce navigateur) — ou,
   à défaut, le jeton d'administration. Connecté, le registre est partagé :
   tous les postes voient les mêmes socles, le Wi-Fi du banc se saisit une fois
   pour tout l'atelier, et le serveur surveille lui-même les rodages des socles
   qui lui sont reliés (page fermée ou non), puis prévient l'équipe. Le code
   d'appairage et le mot de passe de la page locale ne quittent jamais le poste
   qui a monté le socle (un autre poste les reprend par l'USB).

   Automatismes : une carte branchée lance l'étape qui l'attend (1, ou 5 pour
   un socle prêt) ; la première fois, le socle propose les réseaux Wi-Fi qu'il
   capte (Improv série) ; la zone 1 reconnue, la zone 2 s'identifie aussitôt ;
   l'étiquette s'imprime dès qu'elle est prête.

   Le DOM est écrit élément par élément (pas d'innerHTML) : la politique de
   sécurité du site exige les Trusted Types, et rien de ce qui vient de la
   console ou du broker n'est interprété comme du HTML.
   ============================================================================= */
(function () {
  'use strict';

  const CLE = 'terrarium.atelier.v1';
  const CLE_SECRETS = 'terrarium.atelier.secrets';     // sessionStorage : jusqu'à la fermeture de l'onglet
  const CLE_SESSION = 'terrarium.atelier.session';     // localStorage : compte administrateur connecté (session de 30 jours glissants)
  const CLE_MEMO = 'terrarium.atelier.memo';           // localStorage : ce que l'opérateur fait retenir (mot de passe du Wi-Fi du banc)
  // Fenêtre d'installation d'ESP Web Tools, copie servie par le site
  // (app/installateur/) : outils/verifier-installateur.js contrôle que ce
  // fichier existe.
  const DIALOGUE_INSTALLATION = './installateur/install-dialog-im156JnI.js';
  const MANIFESTE_FIRMWARE = 'firmware/manifest.json';
  const ALPHABET_MDP = 'abcdefghjkmnpqrstuvwxyz23456789';  // ni i, l, o, 0, 1 : lisible sur une étiquette
  const NB_ZONES = 2;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LIGNE_MAX = 118;                               // tampon de la console du socle : 120 caractères
  const delais = { reponse: 10000, sondage: 2000, essai: 3000, rodageVerif: 30000, identite: 2500, essaisIdentite: 5,
    synchro: 15000, envoi: 400, enchainement: 1500, scan: 10000, branchement: 800 };
  const $ = s => document.querySelector(s);
  const lireJson = (stockage, cle) => { try { return JSON.parse(stockage.getItem(cle) || 'null'); } catch (e) { return null; } };
  const ecrireJson = (stockage, cle, v) => { try { if (v) stockage.setItem(cle, JSON.stringify(v)); else stockage.removeItem(cle); } catch (e) { /* stockage refusé */ } };
  // Serveur Terrariums fixé au déploiement (balise vide dans le dépôt).
  const serveurDeploye = (() => {
    const m = document.querySelector('meta[name="terrarium-serveur"]');
    try { const u = new URL((m && m.getAttribute('content') || '').trim()); return u.protocol === 'https:' ? u.origin : ''; }
    catch (e) { return ''; }
  })();

  // ------------------------------------------------------------------ outils
  /** Crée un élément : h('p', { class: 'aide' }, 'texte', autreElement). */
  function h(tag, attrs, ...enfants) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'texte') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const e of enfants.flat(Infinity)) if (e !== null && e !== undefined && e !== false) el.append(e instanceof Node ? e : String(e));
    return el;
  }
  const Node = window.Node;
  function s(tag, attrs, ...enfants) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    for (const e of enfants) if (e !== null && e !== undefined && e !== false) el.append(e instanceof Node ? e : String(e));
    return el;
  }
  const attendre = ms => new Promise(r => setTimeout(r, ms));
  const deux = n => String(n).padStart(2, '0');
  function dateCourte(t) {
    if (!t) return '';
    const d = new Date(t);
    return `${deux(d.getDate())}/${deux(d.getMonth() + 1)} ${deux(d.getHours())}:${deux(d.getMinutes())}`;
  }
  function duree(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return `${m} min`;
    const hh = Math.floor(m / 60), mm = m % 60;
    return mm ? `${hh} h ${deux(mm)}` : `${hh} h`;
  }
  function secondes(n) { n = Math.max(0, Math.round(n)); return n >= 60 ? `${Math.floor(n / 60)} min ${deux(n % 60)} s` : `${n} s`; }

  let minuteurMessage = 0;
  function message(texte, erreur = false) {
    const m = $('#message');
    m.textContent = texte;
    m.classList.toggle('erreur', !!erreur);
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('visible'));
    clearTimeout(minuteurMessage);
    minuteurMessage = setTimeout(() => { m.classList.remove('visible'); setTimeout(() => { m.hidden = true; }, 250); }, erreur ? 7000 : 3500);
  }

  // Mot de passe de la page locale : 12 caractères tirés par le générateur
  // cryptographique, sans biais (un octet ≥ 248 est retiré : 248 = 8 × 31).
  function motDePasse() {
    let r = '';
    while (r.length < 12) {
      const o = crypto.getRandomValues(new Uint8Array(24));
      for (const b of o) if (b < 248 && r.length < 12) r += ALPHABET_MDP[b % 31];
    }
    return r;
  }

  // ---------------------------------------------------------------- registre
  function reglagesParDefaut() {
    return {
      urlApp: new URL('./', location.href).href,
      ssid: '',
      liaison: serveurDeploye ? 'serveur' : 'aucune',
      serveur: { url: serveurDeploye, hote: '', port: 8883, ws: '' },
      broker: { ws: '', hote: '', port: 8883, prefixe: 'terrarium', utilisateur: '', oublier: true },
      rodageH: 24,
      auto: true                 // une carte branchée lance l'étape qui l'attend
    };
  }
  function nouveauLot() {
    const d = new Date();
    return { id: 'lot-' + Date.now().toString(36), nom: `Lot du ${deux(d.getDate())}/${deux(d.getMonth() + 1)}/${d.getFullYear()}`, cree: Date.now() };
  }
  function charger() {
    let r = null;
    try { r = JSON.parse(localStorage.getItem(CLE) || 'null'); } catch (e) { r = null; }
    if (!r || r.v !== 1) {
      const lot = nouveauLot();
      r = { v: 1, reglages: reglagesParDefaut(), lots: [lot], lotCourant: lot.id, socles: {} };
    }
    const d = reglagesParDefaut();
    r.reglages = { ...d, ...r.reglages, serveur: { ...d.serveur, ...(r.reglages || {}).serveur }, broker: { ...d.broker, ...(r.reglages || {}).broker } };
    // Un atelier ouvert avant que le déploiement fixe le serveur, et encore
    // jamais servi : il prend le serveur du déploiement.
    if (serveurDeploye && !r.reglages.serveur.url) {
      r.reglages.serveur.url = serveurDeploye;
      if (r.reglages.liaison === 'aucune' && !Object.keys(r.socles || {}).length && !r.reglages.ssid) r.reglages.liaison = 'serveur';
    }
    if (!r.lots.length) { const lot = nouveauLot(); r.lots.push(lot); r.lotCourant = lot.id; }
    if (!r.lots.some(l => l.id === r.lotCourant)) r.lotCourant = r.lots[r.lots.length - 1].id;
    return r;
  }
  const reg = charger();
  function ecrireLocal() {
    try { localStorage.setItem(CLE, JSON.stringify(reg)); }
    catch (e) { message('Registre non enregistré : stockage du navigateur plein ou refusé.', true); }
  }
  // Chaque changement est gardé ici, puis envoyé au registre partagé.
  function sauver() { ecrireLocal(); planifierSynchro(); }
  let secrets = {};
  try { secrets = JSON.parse(sessionStorage.getItem(CLE_SECRETS) || '{}') || {}; } catch (e) { secrets = {}; }
  function sauverSecrets() { try { sessionStorage.setItem(CLE_SECRETS, JSON.stringify(secrets)); } catch (e) { /* onglet sans stockage */ } }
  // Ce que l'opérateur a fait retenir sur cet ordinateur.
  const memo = lireJson(localStorage, CLE_MEMO) || {};
  if (!secrets.wifiMdp && memo.wifiMdp) secrets.wifiMdp = memo.wifiMdp;
  // Compte de l'atelier connecté : { serveur (origine), login, jeton, admin }.
  // Son jeton de session ouvre le registre partagé, la création des comptes
  // d'appareil et le broker du serveur (identifiant : l'adresse e-mail), comme
  // le jeton d'administration.
  let session = lireJson(localStorage, CLE_SESSION);
  const origineDe = url => { try { return new URL(url).origin; } catch (e) { return ''; } };
  function sessionValide() {
    const r = reg.reglages;
    return session && session.jeton && r.liaison === 'serveur' && session.serveur === origineDe(r.serveur.url) ? session : null;
  }
  // Ce qui authentifie l'atelier auprès du serveur : le compte, sinon le jeton.
  function authServeur() { const s = sessionValide(); return s ? s.jeton : (secrets.adminJeton || ''); }
  function oublierSession(texte) {
    session = null;
    ecrireJson(localStorage, CLE_SESSION, null);
    relierBanc();
    if (texte) message(texte, true);
  }

  function socle(id) { return reg.socles[id] || null; }
  function noter(rec, texte) {
    rec.journal = rec.journal || [];
    rec.journal.push({ t: Date.now(), texte });
    if (rec.journal.length > 200) rec.journal.splice(0, rec.journal.length - 200);
    rec.maj = Date.now();
  }
  function obtenirSocle(id) {
    let rec = socle(id);
    if (!rec) {
      rec = reg.socles[id] = { id, lot: reg.lotCourant, cree: Date.now(), maj: Date.now(), etape: 1, etat: 'actif', echec: null,
        sondes: [], chauffe: [], rodage: null, expedition: null, journal: [] };
      noter(rec, 'Socle enregistré');
    }
    return rec;
  }
  function echouer(rec, etape, texte) {
    rec.echec = { etape, texte, t: Date.now() };
    noter(rec, `Étape ${etape} : ${texte}`);
    sauver();
    invalider();
  }

  // ------------------------------------------------------- registre partagé
  // Connecté au serveur avec un compte de l'atelier (ou le jeton), le registre
  // vit aussi sur le serveur : on relit ce qui a changé depuis la dernière
  // révision vue, on envoie les fiches changées ici en disant de quelle
  // révision elles partent. Une fiche changée entre-temps ailleurs (autre
  // poste, ou le serveur pendant un rodage) est reprise telle qu'il l'a.
  // Ne partent jamais : le code d'appairage et le mot de passe de la page
  // locale (ils restent sur ce poste), ni ce que ce poste note pour lui.
  const partage = { actif: false, rev: 0, enCours: false, relancer: false, minuteur: 0, wifi: undefined, moi: null, vu: 0 };
  const CHAMPS_LOCAUX = ['code', 'web', 'rev', 'par', 'recu', '_sync'];
  function publique(rec) {
    const p = {};
    for (const [k, v] of Object.entries(rec)) if (!CHAMPS_LOCAUX.includes(k)) p[k] = v;
    return p;
  }
  // Empreinte d'une fiche (cyrb53) : dit si elle a changé depuis son dernier envoi.
  function empreinte(texte) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < texte.length; i++) {
      const c = texte.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const signature = rec => empreinte(JSON.stringify(publique(rec)));
  const changeIci = rec => rec._sync !== signature(rec);
  // La fiche du serveur remplace la nôtre ; nos secrets restent.
  function adopter(f) {
    const local = reg.socles[f.id];
    const rec = { ...f };
    if (local && local.code) rec.code = local.code;
    if (local && local.web) rec.web = local.web;
    rec._sync = signature(rec);
    reg.socles[f.id] = rec;
    return rec;
  }
  const serveurRegistre = () => (reg.reglages.liaison === 'serveur' && reg.reglages.serveur.url ? origineDe(reg.reglages.serveur.url) : '');
  // Le serveur surveille lui-même le rodage des socles qui lui sont reliés.
  const surveilleParServeur = rec => partage.actif && rec.liaison === 'serveur';
  function planifierSynchro(delai = delais.envoi) {
    if (!serveurRegistre() || !authServeur()) return;
    clearTimeout(partage.minuteur);
    partage.minuteur = setTimeout(() => { synchroniser().catch(() => {}); }, delai);
  }
  async function synchroniser() {
    const base = serveurRegistre(), jeton = authServeur();
    if (!base || !jeton) { partage.actif = false; return false; }
    if (partage.enCours) { partage.relancer = true; return false; }
    partage.enCours = true;
    let change = false;
    try {
      // 1. Ce qui a changé ailleurs.
      const r = await appelServeur(base, `/api/atelier/registre?depuis=${partage.actif ? partage.rev : 0}`, { jeton });
      if (r.status === 404 || r.status === 401 || r.status === 403) {
        // Serveur d'avant le registre partagé, ou compte sans les droits : registre de ce poste seul.
        partage.actif = false;
        if (r.status !== 404 && sessionValide()) verifierSession();
        return false;
      }
      if (!r.ok) return false;
      const dejaActif = partage.actif;
      partage.actif = true;
      partage.vu = Date.now();
      for (const f of r.d.socles || []) {
        const l = reg.socles[f.id];
        if (!l || (!changeIci(l) && (f.rev || 0) > (l.rev || 0))) { adopter(f); change = true; }
      }
      for (const l of r.d.lots || []) {
        const x = reg.lots.find(y => y.id === l.id);
        if (x) { x.nom = l.nom; x.rev = l.rev; } else { reg.lots.push({ id: l.id, nom: l.nom, cree: l.cree, rev: l.rev }); change = true; }
      }
      reg.lots.sort((x, y) => (x.cree || 0) - (y.cree || 0));
      // Premier contact d'un poste neuf : le lot qu'il s'était créé tout seul,
      // jamais servi, s'efface devant ceux de l'atelier.
      if (!dejaActif && (r.d.lots || []).length) {
        const servis = new Set(Object.values(reg.socles).map(x => x.lot));
        reg.lots = reg.lots.filter(l => l.rev || servis.has(l.id));
        if (!reg.lots.some(l => l.id === reg.lotCourant) && reg.lots.length) reg.lotCourant = reg.lots[reg.lots.length - 1].id;
        change = true;
      }
      if (r.d.moi) partage.moi = r.d.moi;
      partage.rev = Math.max(partage.rev, r.d.rev || 0);
      if ('wifi' in r.d && await recevoirWifi(r.d.wifi, base, jeton)) change = true;
      // 2. Ce qui a changé ici.
      for (const l of reg.lots.filter(x => !x.rev)) {
        const p = await appelServeur(base, `/api/atelier/lots/${encodeURIComponent(l.id)}`, { methode: 'PUT', corps: { nom: l.nom, cree: l.cree }, jeton });
        if (p.ok && p.d.lot) l.rev = p.d.lot.rev;
      }
      let nouveaux = false;
      for (const rec of Object.values(reg.socles)) {
        if (!changeIci(rec)) continue;
        const corps = publique(rec), envoye = empreinte(JSON.stringify(corps));
        const p = await appelServeur(base, `/api/atelier/socles/${rec.id}`, { methode: 'PUT', corps: { socle: corps, base: rec.rev || 0 }, jeton });
        const cur = reg.socles[rec.id];
        if (p.ok && p.d.socle) {
          // Au registre du serveur pour la première fois : le broker l'ouvre
          // désormais au compte de l'atelier, l'abonnement est à refaire.
          if (!cur.rev) nouveaux = true;
          Object.assign(cur, { rev: p.d.socle.rev, par: p.d.socle.par, recu: p.d.socle.recu, _sync: envoye });
        }
        else if (p.status === 409 && p.d.socle) {
          adopter(p.d.socle);
          change = true;
          message(`${rec.id} : fiche changée entre-temps (autre poste, ou serveur pendant le rodage). La version de l'atelier est reprise.`, true);
        } else if (p.status === 400) cur._sync = envoye;      // refusée telle quelle : ne pas la renvoyer en boucle
        if (p.d && p.d.rev) partage.rev = Math.max(partage.rev, p.d.rev);
      }
      if (nouveaux) abonnes.clear();
      ecrireLocal();
    } finally {
      partage.enCours = false;
      if (partage.relancer) { partage.relancer = false; planifierSynchro(50); }
    }
    if (change) { invalider(); invaliderBanc(); if (!selection && !nouveau) ouvrirDepuisAdresse(); }
    abonner();
    montrerPartage();
    return true;
  }

  // Le Wi-Fi du banc, saisi une fois pour tout l'atelier. Le serveur le garde
  // chiffré ; un poste qui le connaît le donne au serveur qui ne l'a pas.
  async function recevoirWifi(w, base, jeton) {
    const r = reg.reglages;
    partage.wifi = w;
    if ((!w || w.motDePasse === null) && r.ssid && secrets.wifiMdp) {
      await envoyerWifi(base, jeton);
      return false;
    }
    if (!w || !w.ssid) return false;
    const mdp = typeof w.motDePasse === 'string' ? w.motDePasse : null;
    if (w.ssid === r.ssid && (mdp === null || mdp === (secrets.wifiMdp || ''))) return false;
    r.ssid = w.ssid;
    if (mdp !== null) {
      secrets.wifiMdp = mdp;
      sauverSecrets();
      if (memo.retenirWifi !== false) { memo.wifiMdp = mdp; ecrireJson(localStorage, CLE_MEMO, memo); }
    }
    message(`Wi-Fi du banc reçu de l'atelier : « ${w.ssid} ».`);
    return true;
  }
  async function envoyerWifi(base = serveurRegistre(), jeton = authServeur()) {
    const r = reg.reglages;
    if (!base || !jeton || !r.ssid) return false;
    const p = await appelServeur(base, '/api/atelier/wifi', { methode: 'PUT', corps: { ssid: r.ssid, motDePasse: secrets.wifiMdp || '' }, jeton });
    if (p.ok) partage.wifi = { ssid: r.ssid, motDePasse: secrets.wifiMdp || '', rev: p.d.wifi && p.d.wifi.rev };
    return p.ok;
  }

  // -------------------------------------------------------- console série
  // Une seule console à la fois (un câble). Le tampon garde la fin de ce qui
  // est arrivé ; « total » compte tout depuis l'ouverture, pour que les
  // commandes ne cherchent leur réponse que dans ce qui suit leur envoi.
  let serie = null;
  const serieDisponible = () => !!(navigator.serial && window.isSecureContext !== false);

  // Le port : celui qu'on connaît (carte branchée, fenêtre d'installation),
  // sinon le seul déjà autorisé et branché, sinon le choix de l'opérateur.
  async function ouvrirConsole(portConnu) {
    if (serie && serie.ouvert) return serie;
    if (!serieDisponible()) throw new Error('Ce navigateur ne parle pas au port série : Chrome ou Edge, sur ordinateur, en HTTPS.');
    let port = portConnu;
    if (!port && navigator.serial.getPorts) {
      const deja = await navigator.serial.getPorts().catch(() => []);
      if (deja.length === 1) port = deja[0];
    }
    if (!port) port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    serie = { port, ouvert: true, tampon: '', total: 0, improv: [], lecteur: port.readable.getReader(), ecrivain: port.writable.getWriter() };
    etatConsole();
    lireEnBoucle(serie);
    return serie;
  }
  async function lireEnBoucle(c) {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await c.lecteur.read();
        if (done) break;
        const texte = dec.decode(improvTrier(c, value), { stream: true });
        c.tampon += texte; c.total += texte.length;
        if (c.tampon.length > 120000) c.tampon = c.tampon.slice(-60000);
        journalConsole(texte);
      }
    } catch (e) { /* câble débranché, port fermé */ }
    fermerConsole(c);
  }
  async function fermerConsole(c = serie) {
    if (!c || !c.ouvert) return;
    c.ouvert = false;
    try { await c.lecteur.cancel(); } catch (e) { /* déjà fini */ }
    try { c.lecteur.releaseLock(); } catch (e) { /* déjà libéré */ }
    try { c.ecrivain.releaseLock(); } catch (e) { /* déjà libéré */ }
    try { await c.port.close(); } catch (e) { /* déjà fermé */ }
    if (serie === c) serie = null;
    journalConsole('\n— console fermée —\n');
    etatConsole();
  }
  // Ce qui part vers le socle s'affiche, mots de passe masqués.
  function masquer(ligne) {
    const m = ligne.split(' ');
    if (m[0] === 'motdepasse' && m.length >= 3) m[2] = '••••••';
    else if (m[0] === 'wifi' && m.length >= 3) m[2] = '••••••';
    else if (m[0] === 'mqtt' && m.length >= 5) m[4] = '••••••';
    return m.join(' ');
  }
  async function ecrire(ligne) {
    if (!serie || !serie.ouvert) throw new Error('Console fermée : branche l\'USB et « Connecter la console ».');
    journalConsole(`> ${masquer(ligne)}\n`);
    await serie.ecrivain.write(new TextEncoder().encode(ligne + '\n'));
  }
  async function attendreMotif(motif, delaiMs, depuis) {
    const fin = Date.now() + delaiMs;
    for (;;) {
      if (!serie) return null;
      const debut = serie.total - serie.tampon.length;
      const m = motif.exec(serie.tampon.slice(Math.max(0, depuis - debut)));
      if (m) return m;
      if (Date.now() >= fin || !serie.ouvert) return null;
      await attendre(80);
    }
  }
  async function commande(ligne, motif, delaiMs = 8000) {
    if (ligne.length > LIGNE_MAX) throw new Error('Commande trop longue pour la console du socle (120 caractères) : raccourcir l\'hôte ou les identifiants.');
    const depuis = serie ? serie.total : 0;
    await ecrire(ligne);
    return attendreMotif(motif, delaiMs, depuis);
  }
  function journalConsole(texte) {
    const pre = $('#console-journal');
    const bas = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = (pre.textContent + texte).slice(-60000);
    if (bas) pre.scrollTop = pre.scrollHeight;
  }
  function etatConsole() {
    const ouvert = !!(serie && serie.ouvert);
    const e = $('#etat-console');
    e.textContent = ouvert ? 'Ouverte' : 'Fermée';
    e.className = 'etat' + (ouvert ? ' ok' : '');
    $('#console-ligne').disabled = !ouvert;
    $('#form-console button').disabled = !ouvert;
    const b = $('[data-action="console-libre"]');
    b.textContent = ouvert ? 'Fermer' : 'Connecter';
    b.disabled = !serieDisponible();
  }

  // ------------------------------------------------------ Improv Wi-Fi (série)
  // Le firmware parle Improv sur sa console (ESP Web Tools s'en sert après le
  // flashage) : des paquets « IMPROV » binaires mêlés au texte. On les retire
  // du texte, et on s'en sert pour demander au socle les réseaux qu'il capte.
  const ENTETE_IMPROV = [73, 77, 80, 82, 79, 86];                 // « IMPROV »
  let attenteScan = null;                                          // { reseaux, resoudre, minuteur }
  function improvTrier(c, octets) {
    const texte = [];
    for (const o of octets) {
      const p = c.improv;
      if (p.length < 6) {
        if (o === ENTETE_IMPROV[p.length]) { p.push(o); continue; }
        texte.push(...p, o);                                       // fausse alerte : c'était du texte
        p.length = 0;
        continue;
      }
      p.push(o);
      // Version 1, type 1 à 4 : sinon c'était du texte qui commençait par « IMPROV ».
      if ((p.length === 7 && p[6] !== 1) || (p.length === 8 && (p[7] < 1 || p[7] > 4))) { texte.push(...p); p.length = 0; continue; }
      if (p.length < 9) continue;                                  // version, type, longueur
      const total = 9 + p[8] + 1;
      if (p.length < total) continue;
      const somme = p.slice(0, total - 1).reduce((x, y) => (x + y) & 255, 0);
      if (somme === p[total - 1] && p[6] === 1) improvRecu(p[7], p.slice(9, total - 1));
      p.length = 0;
    }
    return Uint8Array.from(texte);
  }
  // Résultat d'un scan : un paquet par réseau (nom, signal, chiffré), puis un vide.
  function improvRecu(type, d) {
    if (type !== 4 || d[0] !== 4 || !attenteScan) return;
    const chaines = [];
    const dec = new TextDecoder();
    for (let k = 2; k < 2 + d[1] && k < d.length;) {
      const l = d[k++];
      chaines.push(dec.decode(Uint8Array.from(d.slice(k, k + l))));
      k += l;
    }
    if (!chaines.length) { const a = attenteScan; attenteScan = null; clearTimeout(a.minuteur); a.resoudre(a.reseaux); return; }
    if (chaines[0]) attenteScan.reseaux.push({ ssid: chaines[0], rssi: parseInt(chaines[1], 10) || -100, securise: chaines[2] !== 'NO' });
  }
  let reseauxCaptes = [];
  async function scannerWifi() {
    if (!serie || !serie.ouvert) return null;
    const donnees = [4, 0];                                        // commande « scan », sans argument
    const paquet = [...ENTETE_IMPROV, 1, 3, donnees.length, ...donnees];
    paquet.push(paquet.reduce((x, y) => (x + y) & 255, 0));
    const fini = new Promise(resoudre => {
      attenteScan = { reseaux: [], resoudre, minuteur: setTimeout(() => { attenteScan = null; resoudre(null); }, delais.scan) };
    });
    await serie.ecrivain.write(Uint8Array.from(paquet));
    const liste = await fini;
    if (!liste) return null;                                       // pas de réponse : firmware sans Improv
    // Le plus fort d'abord, un nom une fois (plusieurs bornes, même réseau).
    const parNom = new Map();
    for (const x of liste.sort((a, b) => b.rssi - a.rssi)) if (!parNom.has(x.ssid)) parNom.set(x.ssid, x);
    reseauxCaptes = [...parNom.values()];
    return reseauxCaptes;
  }

  // ------------------------------------------------------------ le banc (MQTT)
  let client = null, configActive = '';
  const abonnes = new Set();
  const attentes = {};
  const vif = {};          // état vivant par socle : présence, zones, santé, tâche en cours
  const vivant = id => (vif[id] = vif[id] || { enLigne: false, zones: [], sante: null, tache: null, inventaire: null });

  function configBanc() {
    const r = reg.reglages;
    if (r.liaison === 'serveur') {
      let url = r.serveur.ws;
      if (!url && r.serveur.url) { try { url = 'wss://' + new URL(r.serveur.url).host + '/mqtt'; } catch (e) { url = ''; } }
      const s = sessionValide();
      if (url && s) return { url, user: s.login, pass: s.jeton, prefixe: 'terrarium' };
      return url && secrets.adminJeton ? { url, user: 'admin', pass: secrets.adminJeton, prefixe: 'terrarium' } : null;
    }
    // Un utilisateur sans son mot de passe (onglet rouvert) : rien à tenter.
    if (r.liaison === 'broker' && r.broker.ws && !(r.broker.utilisateur && !secrets.brokerMdp))
      return { url: r.broker.ws, user: r.broker.utilisateur || '', pass: secrets.brokerMdp || '', prefixe: r.broker.prefixe || 'terrarium' };
    return null;
  }
  const prefixe = () => (configBanc() || { prefixe: 'terrarium' }).prefixe;
  function surLeBanc(rec) {
    return rec.liaison && rec.liaison !== 'aucune' && ((rec.etat === 'actif' && rec.etape >= 2 && rec.etape <= 4) || rec.etat === 'pret');
  }
  function relierBanc() {
    const c = configBanc();
    const cle = c ? JSON.stringify(c) : '';
    if (cle === configActive && client) { abonner(); return; }
    if (client) { try { client.end(); } catch (e) { /* déjà fermé */ } client = null; }
    abonnes.clear();
    configActive = cle;
    if (!c || !self.mqtt) { etatBanc(); return; }
    client = self.mqtt.connect(c.url, {
      username: c.user || undefined, password: c.pass || undefined,
      clientId: 'atelier-' + Math.random().toString(16).slice(2, 10),
      keepalive: 30, reconnectPeriod: 5000, connectTimeout: 10000
    });
    client.on('connect', () => { abonnes.clear(); abonner(); etatBanc(); });
    client.on('close', etatBanc);
    client.on('offline', etatBanc);
    client.on('error', err => {
      etatBanc();
      // Un compte refusé par le broker : sa session a peut-être expiré.
      if (sessionValide() && /refus/i.test(err && err.message || '')) verifierSession();
    });
    client.on('message', recevoir);
    etatBanc();
  }
  function abonner() {
    if (!client || !client.connected) return;
    const voulus = new Set(Object.values(reg.socles).filter(surLeBanc).map(r => `${prefixe()}/${r.id}/#`));
    const nouveaux = [...voulus].filter(x => !abonnes.has(x));
    const anciens = [...abonnes].filter(x => !voulus.has(x));
    if (nouveaux.length) client.subscribe(nouveaux);
    if (anciens.length) client.unsubscribe(anciens);
    nouveaux.forEach(x => abonnes.add(x));
    anciens.forEach(x => abonnes.delete(x));
  }
  function etatBanc() {
    const e = $('#etat-banc');
    const c = configBanc();
    let texte = 'Banc non relié', classe = '';
    if (reg.reglages.liaison === 'aucune') texte = 'Sans liaison';
    else if (!c) { texte = reg.reglages.liaison === 'serveur' ? 'Banc : compte à connecter' : 'Banc : identifiants à saisir'; classe = ' attente'; }
    else if (client && client.connected) { texte = 'Banc relié'; classe = ' ok'; }
    else if (client) { texte = 'Banc : connexion…'; classe = ' attente'; }
    e.textContent = texte;
    e.className = 'etat' + classe;
  }

  function defautDe(z) {
    if (!z) return null;
    const d = z.defaut;
    if (d === true || d === 1 || d === '1') return z.defaut_libelle && z.defaut_libelle !== 'OK' ? z.defaut_libelle : 'DÉFAUT';
    if (typeof d === 'string' && d.length > 1 && d.toUpperCase() !== 'OK') return d;
    return null;
  }
  function enRodage(rec) { return rec.etat === 'actif' && rec.etape === 4 && rec.rodage && !rec.rodage.verdict; }
  // Cette page note le rodage des socles que le serveur ne voit pas (broker de l'atelier).
  const rodageIci = rec => enRodage(rec) && !surveilleParServeur(rec);
  function incident(rec, texte, grave) {
    rec.rodage.incidents.push({ t: Date.now(), texte, grave: !!grave });
    noter(rec, `Rodage : ${texte}`);
    sauver();
  }

  function recevoir(sujet, charge, paquet) {
    const parts = sujet.split('/');
    const id = parts[1], fin = parts.slice(2).join('/');
    const rec = socle(id);
    if (!rec) return;
    const v = vivant(id);
    const direct = !(paquet && paquet.retain);
    const texte = charge.toString();
    let j = null;
    if (fin !== 'statut') { try { j = JSON.parse(texte); } catch (e) { return; } }
    if (fin === 'statut') {
      const enLigne = texte === 'en ligne';
      if (direct && rodageIci(rec) && enLigne !== v.enLigne) incident(rec, enLigne ? 'de retour en ligne' : 'hors ligne', false);
      v.enLigne = enLigne;
      if (enLigne && rec.etape === 2 && rec.etat === 'actif' && !v.inventaire && !v.lecture && !v.tache) lireSondes(rec);
    } else if (fin === 'sante') {
      // Un temps de fonctionnement qui recule : le socle a redémarré.
      if (direct && rodageIci(rec) && v.sante && typeof j.uptime === 'number' && j.uptime + 5 < v.sante.uptime)
        incident(rec, `redémarrage${j.reset ? ' (' + j.reset + ')' : ''}`, true);
      v.sante = j;
      if (direct) v.enLigne = true;
    } else if (/^zone\d+\/etat$/.test(fin)) {
      const n = parseInt(fin.slice(4), 10) - 1;
      const avant = defautDe(v.zones[n]), apres = defautDe(j);
      if (direct && rodageIci(rec) && apres && apres !== avant) incident(rec, `zone ${n + 1} : ${apres}`, true);
      v.zones[n] = j;
      if (direct) v.enLigne = true;
    } else if (fin === 'reponse') {
      const a = attentes[j.req];
      if (a) { clearTimeout(a.minuteur); delete attentes[j.req]; a.resoudre(j); }
      return;
    } else return;
    invaliderBanc();
    if (selection === id) invalider();
  }

  // Commande au socle par le broker, signée avec le code d'appairage
  // (protocole 4), en clair avant. Les lectures ne demandent rien.
  const LECTURES = ['etat', 'stats', 'version', 'historique'];
  async function signer(code, texte) {
    const enc = new TextEncoder();
    const cle = await crypto.subtle.importKey('raw', enc.encode(code), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const b = await crypto.subtle.sign('HMAC', cle, enc.encode(texte));
    return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
  }
  async function commander(rec, action, params = {}) {
    if (!client || !client.connected) throw new Error('Banc non relié au broker : voir les réglages.');
    if (!LECTURES.includes(action) && !rec.code) {
      throw new Error('Le code de ce socle est resté sur le poste qui l\'a monté : continue là-bas, ou « Reprendre sur ce poste » (USB, une minute).');
    }
    const req = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const cmd = { req, action, ...params };
    let corps;
    if (LECTURES.includes(action)) corps = JSON.stringify(cmd);
    else if ((rec.proto || 0) >= 4 && crypto.subtle) {
      cmd.ts = Math.floor(Date.now() / 1000);
      const c = JSON.stringify(cmd);
      corps = JSON.stringify({ c, sig: await signer(rec.code || '', c) });
    } else corps = JSON.stringify({ ...cmd, jeton: rec.code || '' });
    return new Promise((resoudre, rejeter) => {
      attentes[req] = { resoudre, minuteur: setTimeout(() => { delete attentes[req]; rejeter(new Error('Le socle ne répond pas (hors ligne ?).')); }, delais.reponse) };
      client.publish(`${prefixe()}/${rec.id}/cmd`, corps, { qos: 1 });
    });
  }

  // ------------------------------------------------------- étape 1 : console
  // La procédure de console en cours (étape 1 ou 5), affichée dans la fiche.
  let procedure = null;    // { id|null, etape, coches: [{ cle, texte, etat, detail }] }
  function coche(cle, texte, etat = 'encours', detail = '') {
    const c = procedure.coches.find(x => x.cle === cle);
    if (c) Object.assign(c, { texte, etat, detail });
    else procedure.coches.push({ cle, texte, etat, detail });
    invalider();
  }

  async function lireIdentite({ silencieux = false } = {}) {
    let m = null;
    // Le socle peut redémarrer à l'ouverture du port : quelques essais.
    for (let i = 0; i < delais.essaisIdentite && !m; i++) m = await commande('jeton', /Appareil (terra[0-9A-Za-z]{6})\s*\r?\nCode d'appairage : ([A-Z0-9]{24})/, delais.identite);
    if (!m) {
      if (silencieux) return null;
      throw new Error('Le socle ne répond pas à « jeton » : câble de données ? firmware flashé ? (bouton EN pour redémarrer la carte)');
    }
    const v = await commande('version', /Firmware (\S+), compile le [^\n]*?, protocole (\d+)/, 3000);
    return { id: m[1], code: m[2], firmware: v ? v[1].replace(/,$/, '') : '', proto: v ? parseInt(v[2], 10) : 0 };
  }

  // ------------------------------------------------ installation du firmware
  // Le firmware publié : celui de la dernière release (manifeste écrit à la
  // publication du site), ou null. Lu une fois.
  let manifeste = null;
  function versionPubliee() {
    if (!manifeste) {
      manifeste = Promise.resolve().then(() => fetch(MANIFESTE_FIRMWARE, { cache: 'no-store' }))
        .then(r => (r && r.ok ? r.json() : null))
        .then(m => (m && m.version && Array.isArray(m.builds) && m.builds.length ? String(m.version) : null))
        .catch(() => null);
    }
    return manifeste;
  }
  // Versions X.Y.Z : négatif si a est plus ancienne que b.
  function comparerVersions(a, b) {
    const n = v => String(v || '').split(/[.+-]/).slice(0, 3).map(x => parseInt(x, 10) || 0);
    const x = n(a), y = n(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }
  // La fenêtre d'installation d'ESP Web Tools sur le port de la console : la
  // console le lui laisse, et le reprend quand la fenêtre se ferme. Les bancs
  // d'essai la remplacent (Atelier._installateur).
  let installateur = async port => {
    await import(DIALOGUE_INSTALLATION);
    await port.open({ baudRate: 115200, bufferSize: 8192 });
    await new Promise(resoudre => {
      const d = /** @type {any} */ (document.createElement('ewt-install-dialog'));
      d.port = port;
      d.manifestPath = MANIFESTE_FIRMWARE;
      d.addEventListener('closed', resoudre, { once: true });
      document.body.appendChild(d);
    });
    try { await port.close(); } catch (e) { /* déjà fermé */ }
  };
  async function installerFirmware(version) {
    const port = serie.port;
    await fermerConsole(serie);
    message(`Firmware ${version} : clique « Install » dans la fenêtre, puis ferme-la à la fin.`);
    try { await installateur(port); }
    finally { await ouvrirConsole(port); }
  }
  // L'identité du socle ; une carte vierge, ou un firmware plus ancien que
  // celui publié, passe d'abord par l'installation.
  async function identiteAJour(dejaLue) {
    let ident = dejaLue !== undefined ? dejaLue : await lireIdentite({ silencieux: true });
    const publiee = await versionPubliee();
    if (ident && (!publiee || !ident.firmware || comparerVersions(ident.firmware, publiee) >= 0)) return ident;
    if (!publiee) throw new Error('Le socle ne répond pas à « jeton », et aucun firmware publié n\'est à installer : câble de données ? (bouton EN pour redémarrer la carte)');
    coche('firmware', ident ? `Mise à jour du firmware ${ident.firmware} vers ${publiee}` : `Installation du firmware ${publiee}`);
    await installerFirmware(publiee);
    ident = await lireIdentite({ silencieux: true });
    if (!ident) throw new Error('Après l\'installation, le socle ne répond pas : fenêtre fermée trop tôt ? « Reprendre la console » pour recommencer.');
    if (comparerVersions(ident.firmware, publiee) < 0) throw new Error(`Le socle est toujours en ${ident.firmware} : installation annulée ? « Reprendre la console » pour recommencer.`);
    coche('firmware', `Firmware ${ident.firmware} installé`, 'fait');
    return { ...ident, installe: true };
  }

  // Ce qui manque avant d'ouvrir la console. Le Wi-Fi du banc, lui, se choisit
  // pendant l'étape 1, parmi les réseaux que le socle capte.
  function verifierReglagesConsole() {
    const r = reg.reglages;
    const espace = x => /\s/.test(x || '');
    if (r.liaison === 'serveur' && (!r.serveur.url || !authServeur())) return 'Serveur Terrariums : connecte-toi avec ton compte de l\'atelier (Réglages).';
    if (r.liaison === 'broker') {
      if (!r.broker.hote) return 'Broker de l\'atelier : hôte pour les socles à saisir (Réglages).';
      if (espace(r.broker.utilisateur) || espace(secrets.brokerMdp)) return 'Broker : ni espace dans l\'utilisateur ni dans le mot de passe.';
      if (r.broker.utilisateur && !secrets.brokerMdp) return 'Mot de passe du broker à saisir (Réglages).';
    }
    return '';
  }

  // Le Wi-Fi du banc : celui des réglages s'il est capté par le socle, sinon
  // l'opérateur le choisit parmi ce que le socle capte (la première fois, ou
  // un réseau en 5 GHz seulement, que l'ESP32 ne voit pas).
  async function wifiDuBanc() {
    const r = reg.reglages;
    coche('reseau', 'Réseaux Wi-Fi captés par le socle');
    const reseaux = await scannerWifi();
    const vu = reseaux && r.ssid ? reseaux.find(x => x.ssid === r.ssid) : null;
    const mdpConnu = !!secrets.wifiMdp || (vu && !vu.securise);
    if (r.ssid && mdpConnu && (vu || reseaux === null)) {
      coche('reseau', vu ? `Wi-Fi du banc « ${r.ssid} » capté (signal ${vu.rssi} dBm)` : `Wi-Fi du banc « ${r.ssid} »`, 'fait');
      return;
    }
    const texte = !r.ssid ? 'Choisis le Wi-Fi du banc : le socle le rejoindra pour le rodage, puis l\'oubliera avant l\'expédition.'
      : reseaux && !vu ? `« ${r.ssid} » n'est pas capté par le socle : réseau en 5 GHz seulement (l'ESP32 n'a que le 2,4 GHz), ou trop loin. Choisis un réseau de la liste.`
        : `Mot de passe du Wi-Fi « ${r.ssid} » à saisir.`;
    coche('reseau', 'Wi-Fi du banc à choisir', 'attention', texte);
    const choix = await demanderWifi({ reseaux: reseaux || [], texte, forcer: !!(r.ssid && secrets.wifiMdp && reseaux && !vu) });
    if (!choix) throw new Error('Wi-Fi du banc non choisi : « Reprendre la console » pour recommencer.');
    if (choix !== 'forcer') {
      r.ssid = choix.ssid;
      secrets.wifiMdp = choix.mdp;
      sauverSecrets();
      memo.retenirWifi = choix.retenir;
      if (choix.retenir && choix.mdp) memo.wifiMdp = choix.mdp; else delete memo.wifiMdp;
      ecrireJson(localStorage, CLE_MEMO, memo);
      sauver();
      if (partage.actif) envoyerWifi().catch(() => {});
    }
    const v = reseaux ? reseaux.find(x => x.ssid === r.ssid) : null;
    coche('reseau', `Wi-Fi du banc « ${r.ssid} »${v ? ` (signal ${v.rssi} dBm)` : ''}`, 'fait');
  }
  // La fenêtre du choix : une carte au-dessus des socles, remplie une fois
  // (la fiche se redessine souvent, un champ en cours de saisie y serait perdu).
  let choixWifi = null;            // { resoudre }
  function demanderWifi({ reseaux, texte, forcer }) {
    return new Promise(resoudre => {
      choixWifi = { resoudre };
      const r = reg.reglages;
      $('#choix-wifi-message').textContent = texte;
      $('#choix-wifi-liste').replaceChildren(...reseaux.map(x => h('button', { type: 'button', class: 'reseau', 'data-action': 'wifi-reseau', 'data-ssid': x.ssid,
        'aria-pressed': String(x.ssid === r.ssid) }, h('b', {}, x.ssid), h('span', {}, `${x.rssi} dBm${x.securise ? '' : ' · ouvert'}`))));
      $('#choix-wifi-liste').hidden = !reseaux.length;
      $('#cw-ssid').value = r.ssid || (reseaux[0] ? reseaux[0].ssid : '');
      $('#cw-mdp').value = secrets.wifiMdp || '';
      $('#cw-retenir').checked = memo.retenirWifi !== false;
      $('#cw-partage').hidden = !partage.actif;
      $('#cw-erreur').hidden = true;
      const b = $('[data-action="wifi-forcer"]');
      b.hidden = !forcer;
      b.textContent = `Essayer « ${r.ssid} » quand même`;
      $('#choix-wifi').hidden = false;
      ($('#cw-ssid').value ? $('#cw-mdp') : $('#cw-ssid')).focus();
    });
  }
  function finirChoixWifi(valeur) {
    $('#choix-wifi').hidden = true;
    const c = choixWifi;
    choixWifi = null;
    if (c) c.resoudre(valeur);
  }
  function validerChoixWifi() {
    const ssid = $('#cw-ssid').value.trim(), mdp = $('#cw-mdp').value;
    const erreur = t => { const e = $('#cw-erreur'); e.textContent = t; e.hidden = false; };
    if (!ssid) return erreur('Nom du réseau à choisir.');
    if (/\s/.test(ssid) || /\s/.test(mdp)) return erreur('Ni espace dans le nom ni dans le mot de passe : la console du socle coupe aux espaces. Choisis un autre réseau, ou renomme celui du banc.');
    const vu = reseauxCaptes.find(x => x.ssid === ssid);
    if (!mdp && !(vu && !vu.securise)) return erreur('Mot de passe du réseau à saisir.');
    if (mdp && mdp.length < 8) return erreur('Un mot de passe Wi-Fi fait au moins 8 caractères.');
    finirChoixWifi({ ssid, mdp, retenir: $('#cw-retenir').checked });
  }

  // port : la carte qu'on vient de brancher ; ident : son identité déjà lue
  // (null : carte muette, sans doute vierge).
  async function etapeConsole(idAttendu, { port = null, ident: identLue } = {}) {
    const pb = verifierReglagesConsole();
    if (pb) { message(pb, true); ouvrirReglages(); return; }
    try { await ouvrirConsole(port); }
    catch (e) { if (e && e.name !== 'NotFoundError') message(e.message || String(e), true); return; }
    procedure = { id: idAttendu || null, etape: 1, coches: [] };
    let rec = idAttendu ? socle(idAttendu) : null;
    try {
      coche('identite', 'Identité du socle');
      const ident = await identiteAJour(identLue);
      if (idAttendu && ident.id !== idAttendu) throw new Error(`Ce socle est ${ident.id}, pas ${idAttendu}.`);
      rec = obtenirSocle(ident.id);
      // Un socle déjà connu (remis en état, retour SAV) recommence tout : les
      // résultats d'après l'étape 1 ne valent plus.
      if (rec.etape > 1 || rec.etat !== 'actif') noter(rec, 'Reprise à l\'étape 1');
      if (ident.installe) noter(rec, `Firmware ${ident.firmware} installé par l'atelier`);
      Object.assign(rec, { code: ident.code, firmware: ident.firmware, proto: ident.proto, etape: 1, etat: 'actif', echec: null,
        sondes: [], chauffe: [], rodage: null, expedition: null });
      delete rec.cote;
      delete vif[rec.id];
      procedure.id = rec.id;
      choisir(rec.id);
      coche('identite', `${rec.id} · firmware ${rec.firmware || '?'} · protocole ${rec.proto || '?'}`, 'fait');
      sauver();

      const r = reg.reglages;
      if (r.liaison !== 'aucune' || r.ssid) await wifiDuBanc();

      coche('usine', 'Auto-test usine (30 s)');
      const depuis = serie.total;
      const u = await commande('test usine', /=== TEST USINE : (OK|ECHEC) \((\d+) echec\(s\)\) ===/, 40000);
      const brut = serie ? serie.tampon.slice(Math.max(0, depuis - (serie.total - serie.tampon.length))) : '';
      const lignes = [...brut.matchAll(/\[( OK |ECHEC| -- )\]\s+(\S+(?: \S+)?)\s{2,}(.*)/g)]
        .map(m => ({ ok: m[1] === ' OK ' ? true : m[1] === 'ECHEC' ? false : null, organe: m[2].trim(), detail: m[3].trim() }));
      rec.usine = { ok: !!u && u[1] === 'OK', lignes, t: Date.now() };
      if (!u) throw new Error('Auto-test usine : pas de verdict en 40 s.');
      if (u[1] !== 'OK') {
        const ko = lignes.filter(l => l.ok === false).map(l => `${l.organe} (${l.detail})`).join(', ');
        throw new Error(`Auto-test usine : ${u[2]} échec(s)${ko ? ' — ' + ko : ''}.`);
      }
      coche('usine', `Auto-test usine : ${lignes.filter(l => l.ok).length} vérifications OK`, 'fait');

      coche('web', 'Mot de passe de la page locale');
      await motDePasseWeb(rec);
      coche('web', `Page locale protégée (${rec.web.utilisateur}, mot de passe tiré ici, imprimé sur l'étiquette)`, 'fait');

      if (r.ssid) {
        coche('wifi', `Wi-Fi du banc (${r.ssid})`);
        const w = await commande(`wifi ${r.ssid} ${secrets.wifiMdp || ''}`.trim(), /(Connecte, adresse (\d+\.\d+\.\d+\.\d+))|(Echec de connexion)/, 35000);
        if (!w || !w[1]) throw new Error(w ? `Le socle n'a pas rejoint « ${r.ssid} » : mot de passe, ou réseau en 5 GHz seulement.` : 'Wi-Fi du banc : pas de réponse en 35 s.');
        rec.wifiBanc = w[2];
        coche('wifi', `Wi-Fi du banc rejoint (${w[2]})`, 'fait');
      }

      rec.liaison = r.liaison;
      if (r.liaison === 'serveur') {
        coche('liaison', 'Compte d\'appareil sur le serveur');
        const base = r.serveur.url.replace(/\/+$/, '');
        const rep = await appelServeur(base, '/api/admin/appareils', { methode: 'POST', corps: { id: rec.id }, jeton: authServeur() });
        if (rep.status === 401 && sessionValide()) {
          oublierSession();
          throw new Error('Session expirée : reconnecte-toi dans les réglages, puis « Reprendre la console ».');
        }
        if (!rep.ok) throw new Error(`Serveur : ${rep.d.erreur || 'HTTP ' + rep.status}.`);
        const d = rep.d;
        let hote = r.serveur.hote;
        if (!hote) hote = new URL(base).hostname;
        const port = +r.serveur.port || 8883;
        if (!await commande(`mqtt ${hote} ${port} ${rec.id} ${d.motDePasse}${port === 8883 ? ' tls' : ''}`, /MQTT enregistre/, 5000)) throw new Error('Le socle n\'a pas confirmé la commande mqtt.');
        coche('liaison', `Compte créé sur ${new URL(base).host} ; socle réglé pour ${hote}:${port}`, 'fait');
      } else if (r.liaison === 'broker') {
        coche('liaison', 'Broker de l\'atelier');
        const b = r.broker, port = +b.port || 1883, tls = port === 8883;
        const ligne = b.utilisateur ? `mqtt ${b.hote} ${port} ${b.utilisateur} ${secrets.brokerMdp}${tls ? ' tls' : ''}` : `mqtt ${b.hote} ${port}`;
        if (!await commande(ligne, /MQTT enregistre/, 5000)) throw new Error('Le socle n\'a pas confirmé la commande mqtt.');
        if (!b.utilisateur && tls && !await commande('mqtt tls on', /MQTT chiffre/, 5000)) throw new Error('Le socle n\'a pas confirmé « mqtt tls on ».');
        coche('liaison', `Socle réglé pour ${b.hote}:${port}`, 'fait');
      }

      rec.etape = 2; rec.echec = null;
      noter(rec, 'Étape 1 terminée : console, auto-test, mot de passe, liaison');
      sauver();
      procedure = null;
      await fermerConsole();
      message(`${rec.id} prêt pour le banc : débranche l'USB, puis branche le 12 V.`);
      relierBanc();
    } catch (e) {
      const texte = e && e.message ? e.message : String(e);
      const c = procedure && procedure.coches.find(x => x.etat === 'encours');
      if (c) { c.etat = 'echec'; c.detail = texte; }
      if (rec) echouer(rec, 1, texte); else invalider();
      message(texte, true);
    }
    invalider();
  }

  // ------------------------------------------------------- étape 2 : sondes
  async function lireSondes(rec, relire = false) {
    const v = vivant(rec.id);
    if (v.lecture) return;
    v.lecture = true;
    try {
      const r = await commander(rec, 'sondes', relire ? { relire: true } : {});
      v.inventaire = r.sondes || null;
    } catch (e) { v.inventaire = null; message(e.message, true); }
    v.lecture = false;
    invalider();
  }

  async function identifier(rec, z) {
    const v = vivant(rec.id);
    if (v.tache) return;
    let suivante = null;
    v.tache = { type: 'identifier', zone: z, fin: Date.now() + 120000 };
    rec.echec = null;
    invalider();
    try {
      const r = await commander(rec, 'identifier', { z: z - 1 });
      if (!r.ok) throw new Error(r.erreur || r.message || 'refusé');
      const limite = Date.now() + 135000;
      let resultat = '';
      await attendre(1000);
      while (Date.now() < limite) {
        const s_ = await commander(rec, 'sondes');
        const inv = s_.sondes || {};
        v.inventaire = inv;
        if (inv.identification && inv.identification.zone === z) {
          v.tache.fin = Date.now() + inv.identification.restantS * 1000;
          invalider();
          await attendre(delais.sondage);
          continue;
        }
        resultat = inv.resultat || '';
        break;
      }
      const ok = new RegExp(`^Zone ${z} : sonde ([0-9A-F]{16}) identifiee`).exec(resultat);
      if (!ok) {
        throw new Error(new RegExp(`^Zone ${z} : identification abandonnee`).test(resultat)
          ? `Zone ${z} : aucune sonde n'a pris 1 °C. La serrer plus longtemps dans la main ; sinon, son câblage.`
          : `Zone ${z} : identification interrompue${resultat ? ' (' + resultat + ')' : ''}.`);
      }
      rec.sondes = (rec.sondes || []).filter(x => x.zone !== z && x.rom !== ok[1]);
      rec.sondes.push({ zone: z, rom: ok[1], t: Date.now() });
      rec.sondes.sort((a, b) => a.zone - b.zone);
      noter(rec, `Sonde ${ok[1]} liée à la zone ${z}`);
      if (rec.sondes.length >= NB_ZONES) {
        rec.etape = 3;
        noter(rec, 'Étape 2 terminée : sondes liées');
        message(`${rec.id} : sondes liées. Place-les sur leurs plaques, tapis branchés, pour l'essai de chauffe.`);
      } else suivante = [1, 2].find(n => !rec.sondes.some(x => x.zone === n)) || null;
      sauver();
    } catch (e) {
      echouer(rec, 2, e.message);
      message(e.message, true);
    }
    v.tache = null;
    invalider();
    // Zone reconnue : l'identification de la suivante part d'elle-même.
    if (suivante) {
      message(`Zone ${z} reconnue. Prends la sonde de la zone ${suivante} dans ta main.`);
      setTimeout(() => {
        if (rec.etat === 'actif' && rec.etape === 2 && !vivant(rec.id).tache && !(rec.sondes || []).some(x => x.zone === suivante)) identifier(rec, suivante);
      }, delais.enchainement);
    }
  }

  // ------------------------------------------------------ étape 3 : chauffe
  async function essais(rec) {
    const v = vivant(rec.id);
    if (v.tache) return;
    rec.echec = null;
    rec.chauffe = [];
    try {
      for (let z = 1; z <= NB_ZONES; z++) {
        v.tache = { type: 'essai', zone: z, fin: Date.now() + 600000 };
        invalider();
        const r = await commander(rec, 'essai', { z: z - 1 });
        if (!r.ok) throw new Error(`Zone ${z} : ${r.erreur || r.message || 'essai refusé'}`);
        const limite = Date.now() + 11 * 60000;
        let resultat = '';
        while (Date.now() < limite) {
          await attendre(delais.essai);
          const e = (await commander(rec, 'essai')).essai || {};
          if (e.zone === z) { v.tache.fin = Date.now() + (e.restantS || 0) * 1000; invalider(); continue; }
          if (e.zone === 0) { resultat = e.resultat || ''; break; }
        }
        const ok = new RegExp(`^zone ${z} OK`, 'i').test(resultat);
        rec.chauffe.push({ zone: z, ok, texte: resultat || 'pas de verdict en 11 min', t: Date.now() });
        noter(rec, `Essai de chauffe zone ${z} : ${resultat || 'pas de verdict'}`);
        sauver();
        if (!ok) throw new Error(resultat ? `Essai de chauffe : ${resultat}` : `Zone ${z} : pas de verdict en 11 min.`);
      }
      demarrerRodage(rec);
      message(`${rec.id} : essais réussis, rodage de ${reg.reglages.rodageH} h lancé.`);
    } catch (e) {
      echouer(rec, 3, e.message);
      message(e.message, true);
    }
    v.tache = null;
    invalider();
  }

  // ------------------------------------------------------- étape 4 : rodage
  function demarrerRodage(rec) {
    const debut = Date.now();
    rec.etape = 4; rec.echec = null;
    rec.rodage = { debut, fin: debut + (+reg.reglages.rodageH || 24) * 3600000, incidents: [], verdict: null };
    noter(rec, `Rodage lancé (${reg.reglages.rodageH} h)`);
    sauver();
  }

  async function conclureRodage(rec, force = '') {
    const ro = rec.rodage;
    let ok, texte;
    if (force) {
      ok = force === 'ok';
      texte = ok ? 'Validé par l\'opérateur' : 'Incident constaté par l\'opérateur';
    } else {
      const r = await commander(rec, 'etat');
      const ecouleS = (Date.now() - ro.debut) / 1000;
      const redemarre = !(r.uptime >= ecouleS - 90);
      const defauts = (r.zones || []).map((z, i) => (defautDe(z) ? `zone ${i + 1} : ${defautDe(z)}` : '')).filter(Boolean);
      const graves = ro.incidents.filter(i => i.grave).map(i => i.texte);
      const problemes = [...new Set([...(redemarre ? [`a redémarré pendant le rodage (en marche depuis ${duree(r.uptime * 1000)})`] : []), ...defauts, ...graves])];
      ok = !problemes.length;
      texte = ok ? `En marche depuis ${duree(r.uptime * 1000)}, sans redémarrage ni défaut` : problemes.join(' ; ');
    }
    ro.verdict = { ok, texte, t: Date.now(), force: force || undefined };
    noter(rec, `Rodage : ${ok ? 'réussi' : 'échoué'} — ${texte}`);
    if (ok) { rec.etat = 'pret'; rec.etape = 5; rec.echec = null; }
    else rec.echec = { etape: 4, texte, t: Date.now() };
    sauver();
    invalider();
  }
  // Vérifie les rodages arrivés à terme (socle en ligne requis) ; ceux des
  // socles reliés au serveur, c'est le serveur qui les conclut.
  async function surveillerRodages() {
    for (const rec of Object.values(reg.socles)) {
      if (!rodageIci(rec) || rec.liaison === 'aucune' || Date.now() < rec.rodage.fin) continue;
      const v = vivant(rec.id);
      if (v.conclusion || !client || !client.connected) continue;
      v.conclusion = true;
      try { await conclureRodage(rec); } catch (e) { /* hors ligne : on réessaiera */ }
      v.conclusion = false;
    }
  }
  function recommencerRodage(rec) {
    noter(rec, 'Rodage recommencé');
    demarrerRodage(rec);
    invalider();
  }

  // ----------------------------------------------------- étape 5 : étiquette
  function lienEtiquette(rec) {
    let u;
    try { u = new URL(reg.reglages.urlApp || './', location.href); } catch (e) { u = null; }
    const local = u && u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (!u || (u.protocol !== 'https:' && !local)) return `terrarium:${rec.id}:${rec.code}`;
    return `${u.origin}${u.pathname.replace(/[^/]*$/, '')}#a/${rec.id}/${rec.code}`;
  }
  function etiquetteSvg(rec) {
    const web = rec.web ? `${rec.web.utilisateur} / ${rec.web.motDePasse}` : '';
    const haut = web ? 428 : 400;
    const q = self.QR.chemin(lienEtiquette(rec), { marge: 1 });
    const echelle = 260 / q.cote;
    const t = (y, contenu, extra) => s('text', { x: 150, y, 'text-anchor': 'middle', 'font-family': 'sans-serif', 'font-size': 11, ...extra }, contenu);
    return s('svg', { xmlns: SVG_NS, width: 300, height: haut, viewBox: `0 0 300 ${haut}`, role: 'img', 'aria-label': `Étiquette de ${rec.id}` },
      s('rect', { width: 300, height: haut, fill: '#fff' }),
      t(26, 'Socle chauffant', { 'font-size': 15, 'font-weight': 600 }),
      t(45, rec.id, { fill: '#555' }),
      s('g', { transform: `translate(20 58) scale(${echelle})` },
        s('rect', { width: q.cote, height: q.cote, fill: '#fff' }),
        s('path', { d: q.d, fill: '#000', 'shape-rendering': 'crispEdges' })),
      t(348, rec.code.match(/.{1,6}/g).join('-'), { 'font-family': 'monospace', 'font-size': 13, 'letter-spacing': 1 }),
      t(372, 'Code d\'appairage — ne pas divulguer', { 'font-size': 9.5, fill: '#555' }),
      t(388, 'Regenerable par la commande « jeton nouveau »', { 'font-size': 9.5, fill: '#555' }),
      web ? t(414, `Interface locale : ${web}`, { 'font-family': 'monospace' }) : null
    );
  }

  async function preparerExpedition(rec, { port = null, ident: identLue = null } = {}) {
    try { await ouvrirConsole(port); }
    catch (e) { if (e && e.name !== 'NotFoundError') message(e.message || String(e), true); return; }
    procedure = { id: rec.id, etape: 5, coches: [] };
    try {
      coche('identite', 'Identité du socle');
      const ident = identLue || await lireIdentite();
      if (ident.id !== rec.id) throw new Error(`Ce socle est ${ident.id}, pas ${rec.id} : branche le bon socle avant d'imprimer son étiquette.`);
      if (rec.code && ident.code !== rec.code) noter(rec, 'Code d\'appairage changé depuis l\'étape 1 : l\'étiquette porte le nouveau');
      rec.code = ident.code;
      coche('identite', `${rec.id} : c'est bien lui`, 'fait');
      // Monté sur un autre poste : le mot de passe de la page locale n'est pas
      // ici ; un nouveau, que seule l'étiquette portera.
      if (!rec.web) {
        coche('web', 'Nouveau mot de passe de la page locale (monté sur un autre poste)');
        await motDePasseWeb(rec);
        coche('web', 'Mot de passe de la page locale tiré ici, imprimé sur l\'étiquette', 'fait');
      }

      const exp = rec.expedition = { verifie: Date.now(), wifiOublie: false, brokerOublie: false };
      coche('wifi', 'Oubli du Wi-Fi du banc');
      const w = await commande('wifi off', /(WiFi oublie)|(Echec de connexion)/, 35000);
      if (!w) throw new Error('Le socle n\'a pas répondu à « wifi off ».');
      exp.wifiOublie = !!w[1];
      // Un firmware d'avant « wifi off » cherche un réseau nommé « off » : rien
      // n'est effacé, il ouvrira son point d'accès après trois minutes chez l'acheteur.
      coche('wifi', w[1] ? 'Wi-Fi du banc oublié : point d\'accès de configuration au démarrage' : 'Firmware trop ancien pour oublier le Wi-Fi : point d\'accès au bout de 3 min chez l\'acheteur', w[1] ? 'fait' : 'attention');

      if (rec.liaison === 'broker' && reg.reglages.broker.oublier) {
        coche('broker', 'Oubli du broker de l\'atelier');
        if (!await commande('mqtt off', /MQTT enregistre/, 5000)) throw new Error('Le socle n\'a pas confirmé « mqtt off ».');
        exp.brokerOublie = true;
        coche('broker', 'Broker de l\'atelier oublié', 'fait');
      }
      coche('historique', 'Historique du rodage');
      if (!await commande('effacer-historique', /Historique efface/, 5000)) throw new Error('Le socle n\'a pas confirmé « effacer-historique ».');
      coche('historique', 'Historique vidé : l\'acheteur part d\'une courbe vierge', 'fait');
      rec.echec = null;
      noter(rec, exp.wifiOublie ? 'Prêt à expédier : identité vérifiée, Wi-Fi du banc oublié'
        : 'Prêt à expédier : identité vérifiée ; firmware trop ancien pour oublier le Wi-Fi du banc (point d\'accès au bout de 3 min)');
      sauver();
      await fermerConsole();
      procedure = null;
      // L'étiquette part à l'imprimante d'elle-même ; « Réimprimer » au besoin.
      message(`${rec.id} : étiquette à l'impression. Colle-la, puis « Étiquette collée ».`);
      imprimerEtiquette(rec);
    } catch (e) {
      const c = procedure && procedure.coches.find(x => x.etat === 'encours');
      if (c) { c.etat = 'echec'; c.detail = e.message; }
      echouer(rec, 5, e.message);
      message(e.message, true);
    }
    invalider();
  }

  // Étape 5 sans USB (firmware 3.5.1) : le socle, resté sur le banc, oublie
  // le Wi-Fi du banc et vide son historique sur commande signée, puis affiche
  // « Pret a expedier » et sa référence jusqu'à son débranchement (et sa LED
  // fait un triple éclair) : l'étiquette va sur celui qui l'affiche.
  const VERSION_EXPEDIER = '3.5.1';
  function versionDuSocle(rec) { const v = vivant(rec.id); return (v.sante && v.sante.version) || rec.firmware || ''; }
  function expedierParReseau(rec) {
    const v = vivant(rec.id);
    return rec.etat === 'pret' && !!rec.code && !!rec.web && rec.liaison !== 'aucune' && v.enLigne && !!client && client.connected
      && comparerVersions(versionDuSocle(rec), VERSION_EXPEDIER) >= 0;
  }
  async function preparerParReseau(rec) {
    const v = vivant(rec.id);
    if (v.tache || procedure) return;
    v.tache = { type: 'expedier' };
    procedure = { id: rec.id, etape: 5, coches: [] };
    try {
      coche('expedier', 'Oubli du Wi-Fi du banc et de l\'historique, par le réseau');
      const broker = rec.liaison === 'broker' && reg.reglages.broker.oublier;
      const r = await commander(rec, 'expedier', { id: rec.id, ...(broker ? { broker: false } : {}) });
      if (!r.ok) {
        throw new Error(/action inconnue/.test(r.erreur || '') ? 'Firmware sans « expedier » (avant la 3.5.1) : « Par la console (USB) ».'
          : `Le socle refuse : ${r.erreur || 'raison inconnue'}.`);
      }
      const e = r.expedition || {};
      rec.expedition = { verifie: Date.now(), parReseau: true, wifiOublie: e.wifiOublie !== false, brokerOublie: !!e.brokerOublie, ecran: !!e.ecran };
      coche('expedier', `Wi-Fi du banc oublié${rec.expedition.brokerOublie ? ', broker de l\'atelier oublié' : ''}, historique vidé`, 'fait');
      rec.echec = null;
      noter(rec, `Prêt à expédier, par le réseau : Wi-Fi du banc oublié${rec.expedition.brokerOublie ? ', broker de l\'atelier oublié' : ''}, historique vidé`);
      sauver();
      procedure = null;
      message(rec.expedition.ecran ? `${rec.id} : son écran affiche « Pret a expedier » et sa référence (LED en triple éclair). Colle l'étiquette sur celui-là, puis débranche le 12 V.`
        : `${rec.id} : sa LED fait un triple éclair. Colle l'étiquette sur celui-là, puis débranche le 12 V.`);
      imprimerEtiquette(rec);
    } catch (e) {
      // L'échec s'affiche en tête de la fiche ; les deux chemins restent offerts.
      procedure = null;
      echouer(rec, 5, e.message);
      message(e.message, true);
    }
    v.tache = null;
    invalider();
  }

  async function motDePasseWeb(rec) {
    if (!rec.web) rec.web = { utilisateur: 'admin', motDePasse: motDePasse() };
    sauver();
    if (!await commande(`motdepasse web ${rec.web.motDePasse} ${rec.web.utilisateur}`, /Enregistre/, 5000)) throw new Error('Le socle n\'a pas confirmé « motdepasse web ».');
  }

  // Un socle monté sur un autre poste : son code d'appairage est resté là-bas.
  // L'USB le redonne (12 V débranché), avec un nouveau mot de passe de la page
  // locale que seule l'étiquette portera.
  async function reprendreIci(rec, { port = null, ident: identLue = null } = {}) {
    try { await ouvrirConsole(port); }
    catch (e) { if (e && e.name !== 'NotFoundError') message(e.message || String(e), true); return; }
    procedure = { id: rec.id, etape: 'reprise', coches: [] };
    try {
      coche('identite', 'Identité du socle');
      const ident = identLue || await lireIdentite();
      if (ident.id !== rec.id) throw new Error(`Ce socle est ${ident.id}, pas ${rec.id}.`);
      rec.code = ident.code;
      coche('identite', `${rec.id} : code d'appairage repris`, 'fait');
      if (!rec.web) {
        coche('web', 'Nouveau mot de passe de la page locale');
        await motDePasseWeb(rec);
        coche('web', 'Mot de passe de la page locale tiré ici', 'fait');
      }
      noter(rec, 'Repris sur ce poste (USB) : code d\'appairage relu');
      sauver();
      await fermerConsole();
      procedure = null;
      message(`${rec.id} repris sur ce poste : débranche l'USB, rebranche le 12 V.`);
    } catch (e) {
      const c = procedure && procedure.coches.find(x => x.etat === 'encours');
      if (c) { c.etat = 'echec'; c.detail = e.message; }
      message(e.message, true);
    }
    invalider();
  }

  // Une carte branchée sur un port déjà autorisé : l'étape qui l'attend
  // démarre, sans bouton ni choix du port. Carte inconnue ou muette (vierge) :
  // étape 1 ; socle prêt : étape 5 ; monté ailleurs : reprise du code.
  async function auBranchement(port) {
    if (reg.reglages.auto === false || procedure || choixWifi || (serie && serie.ouvert)) return;
    await attendre(delais.branchement);              // le temps que la carte démarre
    if (procedure || choixWifi || (serie && serie.ouvert)) return;
    let ident;
    try { await ouvrirConsole(port); ident = await lireIdentite({ silencieux: true }); }
    catch (e) { message(e.message || String(e), true); return; }
    const rec = ident ? socle(ident.id) : null;
    if (rec && rec.etat === 'pret') { choisir(rec.id); return preparerExpedition(rec, { port, ident }); }
    if (rec && rec.etat === 'actif' && rec.etape >= 2 && rec.etape <= 3 && !rec.code) { choisir(rec.id); return reprendreIci(rec, { port, ident }); }
    if (rec && (rec.etat !== 'actif' || rec.etape >= 2)) {
      await fermerConsole();
      choisir(rec.id);
      message(`${rec.id} branché en USB : ${resumeSocle(rec).toLowerCase()}. Rien n'est lancé (« Nouveau socle » pour reprendre à l'étape 1).`);
      return;
    }
    if (rec) choisir(rec.id); else { selection = null; nouveau = true; invalider(); }
    return etapeConsole(rec ? rec.id : null, { port, ident });
  }

  function imprimerEtiquette(rec) {
    const zone = $('#etiquette-impression');
    zone.replaceChildren(etiquetteSvg(rec));
    noter(rec, 'Étiquette imprimée');
    rec.etiquetteImprimee = Date.now();
    sauver();
    invalider();
    if (typeof window.print === 'function') window.print();
  }
  function telecharger(nom, type, contenu) {
    const url = URL.createObjectURL(new Blob([contenu], { type }));
    const a = h('a', { href: url, download: nom });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function telechargerEtiquette(rec) {
    telecharger(`${rec.id}-etiquette.svg`, 'image/svg+xml', new window.XMLSerializer().serializeToString(etiquetteSvg(rec)) + '\n');
  }
  function expedier(rec) {
    rec.etat = 'expedie';
    rec.expedition = { ...(rec.expedition || {}), date: Date.now() };
    delete rec.code;
    delete rec.web;
    noter(rec, 'Expédié : code d\'appairage et mot de passe effacés de l\'atelier');
    sauver();
    abonner();
    message(`${rec.id} expédié.`);
    invalider();
    invaliderBanc();
  }

  // ------------------------------------------------- mise de côté, reprise
  function mettreDeCote(rec, raison) {
    rec.cote = { raison: raison || 'sans raison notée', t: Date.now(), etatAvant: rec.etat };
    rec.etat = 'cote';
    noter(rec, `Mis de côté : ${rec.cote.raison}`);
    sauver();
    abonner();
    invalider();
    invaliderBanc();
  }
  function reprendre(rec) {
    rec.etat = rec.cote && rec.cote.etatAvant === 'pret' ? 'pret' : 'actif';
    noter(rec, 'Repris');
    delete rec.cote;
    sauver();
    relierBanc();
    invalider();
  }

  // ---------------------------------------------------------- registre CSV
  function exporterCsv() {
    const lot = id => (reg.lots.find(l => l.id === id) || { nom: '' }).nom;
    const etats = { actif: 'en cours', pret: 'prêt', expedie: 'expédié', cote: 'de côté' };
    const lignes = [['socle', 'lot', 'enregistré', 'état', 'étape', 'firmware', 'protocole', 'auto-test', 'sonde zone 1', 'sonde zone 2',
      'chauffe zone 1', 'chauffe zone 2', 'début rodage', 'rodage', 'expédié', 'mis de côté']];
    for (const r of Object.values(reg.socles).sort((a, b) => a.cree - b.cree)) {
      const sonde = z => ((r.sondes || []).find(x => x.zone === z) || {}).rom || '';
      const ch = z => { const c = (r.chauffe || []).find(x => x.zone === z); return c ? (c.ok ? 'OK' : 'ÉCHEC') : ''; };
      lignes.push([r.id, lot(r.lot), dateCourte(r.cree), etats[r.etat] || r.etat, r.etape, r.firmware || '', r.proto || '',
        r.usine ? (r.usine.ok ? 'OK' : 'ÉCHEC') : '', sonde(1), sonde(2), ch(1), ch(2),
        r.rodage ? dateCourte(r.rodage.debut) : '', r.rodage && r.rodage.verdict ? (r.rodage.verdict.ok ? 'OK' : 'ÉCHEC') + ' — ' + r.rodage.verdict.texte : '',
        r.expedition && r.expedition.date ? dateCourte(r.expedition.date) : '', r.cote ? r.cote.raison : '']);
    }
    const csv = '\uFEFF' + lignes.map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n') + '\r\n';
    const d = new Date();
    telecharger(`registre-atelier-${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}.csv`, 'text/csv;charset=utf-8', csv);
  }

  // ---------------------------------------------------------------- rendu
  let selection = null, nouveau = false, filtre = 'actifs', minuteurRendu = 0, minuteurBanc = 0;
  const intro = $('#fiche').cloneNode(true).childNodes;
  const introNoeuds = [...intro].map(n => n.cloneNode(true));

  function invalider() { clearTimeout(minuteurRendu); minuteurRendu = setTimeout(dessiner, 30); }
  function invaliderBanc() { clearTimeout(minuteurBanc); minuteurBanc = setTimeout(dessinerBanc, 250); }
  function choisir(id) { selection = id; nouveau = false; invalider(); }

  function etatPas(rec, n) {
    if (rec.etat === 'expedie') return 'fait';
    if (n < rec.etape) return 'fait';
    if (n > rec.etape) return 'avenir';
    return (rec.echec && rec.echec.etape === n) || rec.etat === 'cote' ? 'echec' : 'encours';
  }
  function pastilles(rec) {
    return h('span', { class: 'pastilles-etapes', 'aria-label': `étape ${Math.min(rec.etape, 5)} sur 5` },
      [1, 2, 3, 4, 5].map(n => h('i', { 'data-etat': etatPas(rec, n) })));
  }
  function resumeSocle(rec) {
    if (rec.etat === 'expedie') return `Expédié le ${dateCourte(rec.expedition && rec.expedition.date)}`;
    if (rec.etat === 'cote') return `De côté : ${rec.cote ? rec.cote.raison : ''}`;
    if (rec.etat === 'pret') return 'Prêt : étiquette et expédition';
    if (rec.echec) return `Étape ${rec.echec.etape} à reprendre`;
    if (rec.etape === 4 && rec.rodage) return `Rodage : encore ${duree(rec.rodage.fin - Date.now())}`;
    return ['', 'Console', 'Sondes', 'Chauffe', 'Rodage', 'Étiquette'][rec.etape] || '';
  }
  function filtrer(rec) {
    if (filtre === 'tous') return true;
    if (filtre === 'actifs') return rec.etat === 'actif';
    if (filtre === 'prets') return rec.etat === 'pret';
    if (filtre === 'expedies') return rec.etat === 'expedie';
    return rec.etat === 'cote';
  }

  function dessinerListe() {
    const sel = $('#lot-courant');
    if (sel.options.length !== reg.lots.length || [...sel.options].some((o, i) => o.value !== reg.lots[i].id || o.textContent !== reg.lots[i].nom)) {
      sel.replaceChildren(...reg.lots.map(l => h('option', { value: l.id }, l.nom)));
    }
    sel.value = reg.lotCourant;
    const liste = Object.values(reg.socles).filter(r => (filtre === 'tous' || r.lot === reg.lotCourant || r.etat !== 'expedie') && filtrer(r))
      .sort((a, b) => b.maj - a.maj);
    $('#liste-socles').replaceChildren(...liste.map(r => h('li', {},
      h('button', { type: 'button', 'data-action': 'ouvrir', 'data-id': r.id, 'aria-current': r.id === selection ? 'true' : 'false' },
        h('span', { class: 'id' }, r.id), pastilles(r),
        h('span', { class: 'sous' }, resumeSocle(r))))));
    $('#liste-vide').hidden = liste.length > 0;
    document.querySelectorAll('[data-filtre]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filtre === filtre)));
  }

  function coches(liste) {
    return h('ul', { class: 'coches' }, liste.map(c => h('li', { 'data-etat': c.etat }, h('span', {}, c.texte, c.detail ? h('span', { class: 'detail' }, c.detail) : null))));
  }
  function pasCarte(n, titre, etat, resume, corps) {
    return h('section', { class: 'pas-atelier', 'data-etat': etat, 'aria-label': `Étape ${n} : ${titre}` },
      h('h3', {}, h('span', { class: 'num', 'aria-hidden': 'true' }, etat === 'fait' ? '✓' : String(n)), titre),
      resume ? h('p', { class: 'resume' }, resume) : null,
      corps ? h('div', { class: 'pas-corps' }, corps) : null);
  }
  const bouton = (texte, action, attrs = {}, classe = 'btn btn-petit') => h('button', { type: 'button', class: classe, 'data-action': action, ...attrs }, texte);
  const compte = (fin, prefixeTexte = '') => h('span', { 'data-fin': fin, 'data-prefixe': prefixeTexte }, prefixeTexte + secondes((fin - Date.now()) / 1000));

  function corpsConsole(rec, etape) {
    const enCours = procedure && procedure.etape === etape && (procedure.id === (rec ? rec.id : null) || (!rec && !procedure.id));
    const liste = enCours ? procedure.coches : [];
    return [
      etape === 1
        ? h('p', { class: 'aide' }, '12 V débranché, carte en USB. Carte vierge ou firmware en retard : l\'atelier installe d\'abord le firmware publié (« Install » dans la fenêtre qui s\'ouvre), puis enchaîne.')
        : h('p', { class: 'aide' }, 'Débranche le 12 V, branche l\'USB : l\'atelier vérifie que c\'est bien ce socle, lui fait oublier le Wi-Fi du banc, vide l\'historique du rodage, et l\'étiquette s\'imprime d\'elle-même.'),
      liste.length ? coches(liste) : null,
      enCours && liste.some(c => c.etat === 'encours') ? null
        : h('div', { class: 'boutons' }, bouton(etape === 1 ? (liste.length || (rec && rec.echec) ? 'Reprendre la console' : 'Connecter la console') : 'Vérifier et préparer',
          etape === 1 ? 'console' : 'preparer', rec ? { 'data-id': rec.id } : {}, 'btn'))
    ];
  }

  // Monté sur un autre poste : le code d'appairage, que les commandes signées
  // demandent, est resté là-bas. Une minute d'USB le redonne ici.
  function corpsReprise(rec) {
    const enCours = procedure && procedure.etape === 'reprise' && procedure.id === rec.id;
    return [h('p', { class: 'aide' }, `Ce socle a été monté sur un autre poste${rec.par ? ` (${rec.par})` : ''} : son code d'appairage y est resté. Continue là-bas, ou reprends-le ici : 12 V débranché, USB branché.`),
      enCours ? coches(procedure.coches) : null,
      enCours && procedure.coches.some(c => c.etat === 'encours') ? null
        : h('div', { class: 'boutons' }, bouton('Reprendre sur ce poste (USB)', 'reprendre-ici', { 'data-id': rec.id }, 'btn'))];
  }

  function corpsSondes(rec) {
    const v = vivant(rec.id);
    if (rec.liaison !== 'aucune' && !rec.code) return corpsReprise(rec);
    if (rec.liaison === 'aucune') {
      return [h('p', { class: 'aide' }, 'Page locale du socle, Réglages → Sondes : « Identifier » à côté de chaque zone, sonde serrée dans la main. Puis valider ici.'),
        h('div', { class: 'boutons' }, bouton('Sondes liées (page locale)', 'manuel-sondes', { 'data-id': rec.id }, 'btn'))];
    }
    const corps = [];
    if (!v.enLigne) {
      corps.push(h('p', { class: 'aide' }, 'En attente du socle sur le banc : USB débranché, 12 V branché. Il rejoint le Wi-Fi du banc puis le broker (une minute au plus).'));
      return corps;
    }
    const inv = v.inventaire;
    if (inv && Array.isArray(inv.sondes)) {
      corps.push(h('div', { class: 'mesures' }, inv.sondes.map((x, i) => h('div', {}, h('b', {}, x.temp === null ? '—' : `${Number(x.temp).toFixed(1)} °C`),
        h('span', {}, `sonde ${i + 1} · ${x.rom.slice(-4)}${x.zone >= 0 ? ' · zone ' + (x.zone + 1) : ''}`)))));
      if (inv.sondes.length < NB_ZONES) corps.push(h('p', { class: 'erreur-code' }, `${inv.sondes.length} sonde(s) sur le bus pour ${NB_ZONES} zones : câblage (résistance de 4,7 kΩ, soudures).`));
    }
    const lies = new Map((rec.sondes || []).map(x => [x.zone, x.rom]));
    const t = v.tache && v.tache.type === 'identifier' ? v.tache : null;
    if (t) {
      corps.push(h('p', { class: 'compte-a-rebours' }, compte(t.fin)),
        h('p', {}, `Serre la sonde de la zone ${t.zone} dans ta main, sans lâcher : le socle la reconnaît dès qu'elle a pris 1 °C. Chauffe suspendue pendant ce temps.`));
    } else {
      corps.push(h('ul', { class: 'coches' }, [1, 2].map(z => h('li', { 'data-etat': lies.has(z) ? 'fait' : '' },
        h('span', {}, lies.has(z) ? `Zone ${z} : sonde ${lies.get(z)}` : `Zone ${z} : à identifier`)))));
      corps.push(h('div', { class: 'boutons' },
        [1, 2].map(z => bouton(lies.has(z) ? `Refaire la zone ${z}` : `Identifier la zone ${z}`, 'identifier', { 'data-id': rec.id, 'data-zone': z }, lies.has(z) ? 'btn btn-secondaire btn-petit' : 'btn btn-petit')),
        bouton('Relire le bus', 'relire', { 'data-id': rec.id }, 'btn btn-fantome btn-petit')));
    }
    return corps;
  }

  function corpsChauffe(rec) {
    const v = vivant(rec.id);
    if (rec.liaison !== 'aucune' && !rec.code) return corpsReprise(rec);
    if (rec.liaison === 'aucune') {
      return [h('p', { class: 'aide' }, 'Page locale, Réglages → Sondes : « Essai de chauffe » pour chaque zone, tapis branchés et sondes sur leurs plaques. Le socle donne son verdict.'),
        h('div', { class: 'boutons' }, bouton('Essais réussis (page locale)', 'manuel-chauffe', { 'data-id': rec.id }, 'btn'))];
    }
    const t = v.tache && v.tache.type === 'essai' ? v.tache : null;
    const faits = (rec.chauffe || []).map(c => ({ etat: c.ok ? 'fait' : 'echec', texte: `Zone ${c.zone} : ${c.ok ? 'OK' : 'ÉCHEC'}`, detail: c.texte }));
    return [
      h('p', { class: 'aide' }, 'Tapis branchés, chaque sonde sur sa plaque. Chaque zone chauffe seule à pleine puissance, dix minutes au plus, jusqu\'au verdict du socle. Ne pas laisser sans surveillance.'),
      faits.length ? coches(faits) : null,
      t ? h('p', { class: 'compte-a-rebours' }, `Zone ${t.zone} : `, compte(t.fin, 'verdict d\'ici ')) : null,
      t || !v.enLigne ? (v.enLigne ? null : h('p', { class: 'aide' }, 'En attente du socle sur le banc…'))
        : h('div', { class: 'boutons' }, bouton(faits.length ? 'Refaire les essais' : 'Lancer les essais de chauffe', 'essais', { 'data-id': rec.id }, 'btn'))
    ];
  }

  function corpsRodage(rec) {
    const ro = rec.rodage;
    if (!ro) return null;
    const v = vivant(rec.id);
    const total = ro.fin - ro.debut, ecoule = Math.min(total, Date.now() - ro.debut);
    const corps = [];
    if (!ro.verdict) {
      corps.push(h('progress', { class: 'progres-rodage', max: total, value: ecoule, 'aria-label': 'Avancement du rodage' }),
        h('p', { class: 'aide' }, `Depuis le ${dateCourte(ro.debut)} — fin prévue le ${dateCourte(ro.fin)} (encore ${duree(ro.fin - Date.now())}).`));
      if (rec.liaison !== 'aucune') {
        corps.push(h('div', { class: 'mesures' },
          h('div', {}, h('b', {}, v.enLigne ? 'en ligne' : 'hors ligne'), h('span', {}, v.sante ? `en marche depuis ${duree(v.sante.uptime * 1000)}` : 'présence')),
          [0, 1].map(i => { const z = v.zones[i]; return h('div', {}, h('b', {}, z ? `${Number(z.temp).toFixed(1)} °C` : '—'), h('span', {}, `zone ${i + 1}${z ? ' → ' + Number(z.consigne).toFixed(1) + ' °C' : ''}${defautDe(z) ? ' · ' + defautDe(z) : ''}`)); })));
        corps.push(h('p', { class: 'aide' }, surveilleParServeur(rec)
          ? 'Le serveur surveille ce rodage, page fermée ou non : redémarrages, défauts et coupures sont notés, et l\'équipe est prévenue à la fin (e-mail, notification).'
          : 'Cette page note les redémarrages, défauts et coupures tant qu\'elle reste ouverte ; à la fin, le socle doit être en marche depuis le début du rodage.'));
        if (Date.now() >= ro.fin) corps.push(h('div', { class: 'boutons' }, bouton('Conclure maintenant', 'conclure', { 'data-id': rec.id }, 'btn')));
      } else {
        corps.push(h('div', { class: 'boutons' },
          bouton('Rodage sans incident', 'manuel-rodage-ok', { 'data-id': rec.id, disabled: Date.now() < ro.fin }, 'btn'),
          bouton('Incident constaté', 'manuel-rodage-ko', { 'data-id': rec.id }, 'btn btn-danger')));
      }
    } else if (rec.etape === 4) {
      corps.push(h('p', { class: ro.verdict.ok ? 'aide' : 'erreur-code' }, ro.verdict.texte));
      if (!ro.verdict.ok && rec.etat === 'actif') corps.push(h('div', { class: 'boutons' },
        bouton('Recommencer le rodage', 'recommencer', { 'data-id': rec.id }, 'btn'),
        bouton('Accepter malgré tout', 'forcer', { 'data-id': rec.id }, 'btn btn-secondaire')));
    }
    if (ro.incidents.length) corps.push(h('ul', { class: 'incidents' }, ro.incidents.map(i => h('li', { 'data-grave': i.grave ? 'true' : 'false' }, `${dateCourte(i.t)} — ${i.texte}`))));
    return corps;
  }

  function corpsEtiquette(rec) {
    if (rec.etat === 'expedie') return null;
    const pret = rec.expedition && rec.expedition.verifie && !(rec.echec && rec.echec.etape === 5) && !(procedure && procedure.id === rec.id);
    const corps = [...corpsConsole(rec, 5)];
    // Resté sur le banc, en 3.5.1 : tout se fait par le réseau, l'USB reste possible.
    const enCours = procedure && procedure.id === rec.id && procedure.etape === 5;
    if (!pret && !enCours && expedierParReseau(rec)) {
      corps.splice(0, corps.length,
        h('p', { class: 'aide' }, 'Le socle est en ligne sur le banc : il oublie le Wi-Fi du banc et vide son historique par le réseau, puis affiche « Pret a expedier » et sa référence (LED en triple éclair) jusqu\'à son débranchement. L\'étiquette s\'imprime aussitôt : colle-la sur celui qui l\'affiche.'),
        h('div', { class: 'boutons' }, bouton('Préparer et imprimer, sans USB', 'preparer-reseau', { 'data-id': rec.id }, 'btn'),
          bouton('Par la console (USB)', 'preparer', { 'data-id': rec.id }, 'btn btn-secondaire')));
    }
    if (pret && rec.code) {
      const comment = rec.expedition.parReseau
        ? `Préparé par le réseau : Wi-Fi du banc oublié${rec.expedition.brokerOublie ? ', broker de l\'atelier oublié' : ''}. ${rec.expedition.ecran ? 'Son écran affiche « Pret a expedier » et sa référence' : 'Sa LED fait un triple éclair'} jusqu'au débranchement.`
        : `Identité vérifiée sur la console${rec.expedition.wifiOublie ? ', Wi-Fi du banc oublié' : ' (Wi-Fi du banc gardé : firmware trop ancien)'}.`;
      corps.splice(0, corps.length,
        h('div', { class: 'etiquette-apercu' }, etiquetteSvg(rec),
          h('div', {}, h('p', { class: 'aide' }, `${comment} L'étiquette porte le lien d'installation (le téléphone l'ouvre sans application), le code et le mot de passe de la page locale.`),
            h('div', { class: 'boutons' }, bouton(rec.etiquetteImprimee ? 'Réimprimer l\'étiquette' : 'Imprimer l\'étiquette', 'imprimer', { 'data-id': rec.id }, rec.etiquetteImprimee ? 'btn btn-secondaire' : 'btn'),
              bouton('SVG', 'svg', { 'data-id': rec.id }, 'btn btn-secondaire btn-petit')),
            h('div', { class: 'boutons' }, bouton('Étiquette collée : marquer comme expédié', 'expedier', { 'data-id': rec.id }, 'btn')),
            h('p', { class: 'discret' }, 'À l\'expédition, le code d\'appairage et le mot de passe sont effacés de cet ordinateur.'))));
    }
    return corps;
  }

  function dessinerFiche() {
    const f = $('#fiche');
    // Le focus survit au redessin : même action, même socle, même zone.
    const actif = document.activeElement && f.contains(document.activeElement) ? document.activeElement : null;
    const cleFocus = actif ? [actif.dataset.action, actif.dataset.id, actif.dataset.zone, actif.id].join('|') : '';
    if (nouveau) {
      f.replaceChildren(h('h2', { id: 'fiche-titre' }, 'Nouveau socle'), pasCarte(1, 'Console', procedure && procedure.coches.some(c => c.etat === 'echec') ? 'echec' : 'encours', '', corpsConsole(null, 1)));
    } else if (!selection || !socle(selection)) {
      f.replaceChildren(...introNoeuds.map(n => n.cloneNode(true)));
    } else {
      const rec = socle(selection);
      const lot = (reg.lots.find(l => l.id === rec.lot) || { nom: '' }).nom;
      const badge = { actif: ['', 'en cours'], pret: [' ok', 'prêt'], expedie: [' ok', 'expédié'], cote: [' danger', 'de côté'] }[rec.etat] || ['', rec.etat];
      const usine = rec.usine ? rec.usine.lignes.map(l => h('li', { 'data-ok': String(l.ok !== false) }, `${l.ok === false ? 'ÉCHEC' : l.ok ? 'OK   ' : '--   '} ${l.organe} — ${l.detail}`)) : [];
      const resume1 = rec.etape > 1 || rec.etat !== 'actif'
        ? `Firmware ${rec.firmware || '?'} · auto-test ${rec.usine && rec.usine.ok ? 'OK' : '—'} · ${rec.liaison === 'serveur' ? 'serveur Terrariums' : rec.liaison === 'broker' ? 'broker de l\'atelier' : 'sans liaison'}${rec.wifiBanc ? ' · banc ' + rec.wifiBanc : ''}`
        : '';
      const pas = [
        pasCarte(1, 'Console', etatPas(rec, 1), resume1, rec.etape === 1 && rec.etat === 'actif' ? corpsConsole(rec, 1) : (usine.length ? [h('details', {}, h('summary', {}, 'Auto-test usine'), h('ul', { class: 'verdicts' }, usine))] : null)),
        pasCarte(2, 'Sondes', etatPas(rec, 2), (rec.sondes || []).map(x => `zone ${x.zone} : ${x.rom}`).join(' · '), rec.etape === 2 && rec.etat === 'actif' ? corpsSondes(rec) : null),
        pasCarte(3, 'Chauffe', etatPas(rec, 3), rec.etape > 3 ? (rec.chauffe || []).map(c => `zone ${c.zone} ${c.ok ? 'OK' : 'ÉCHEC'}`).join(' · ') : '', rec.etape === 3 && rec.etat === 'actif' ? corpsChauffe(rec) : null),
        pasCarte(4, 'Rodage', etatPas(rec, 4), rec.rodage && rec.rodage.verdict && rec.etape > 4 ? rec.rodage.verdict.texte : '', rec.etape === 4 || (rec.rodage && rec.rodage.incidents.length && rec.etat !== 'expedie') ? corpsRodage(rec) : null),
        pasCarte(5, 'Étiquette et expédition', etatPas(rec, 5), rec.etat === 'expedie' ? `Expédié le ${dateCourte(rec.expedition.date)}` : '', rec.etat === 'pret' ? corpsEtiquette(rec) : null)
      ];
      const echec = rec.echec && rec.etat !== 'expedie' ? h('p', { class: 'erreur-code', role: 'alert' }, rec.echec.texte) : null;
      const cote = rec.etat === 'cote'
        ? h('div', { class: 'boutons' }, bouton('Reprendre', 'reprendre', { 'data-id': rec.id }, 'btn btn-secondaire btn-petit'))
        : rec.etat !== 'expedie'
          ? h('form', { class: 'mise-de-cote mt', 'data-form': 'cote', 'data-id': rec.id },
            h('div', {}, h('label', { for: 'raison-' + rec.id }, 'Mettre de côté'), h('input', { id: 'raison-' + rec.id, name: 'raison', placeholder: 'Raison (sonde HS, soudure…)', autocomplete: 'off' })),
            h('button', { type: 'submit', class: 'btn btn-danger btn-petit' }, 'Mettre de côté'))
          : null;
      f.replaceChildren(...[
        h('div', { class: 'fiche-tete' }, h('h2', { id: 'fiche-titre' }, rec.id), h('span', { class: 'badge' + badge[0] }, badge[1])),
        h('p', { class: 'discret' }, `${lot} · enregistré le ${dateCourte(rec.cree)}`),
        echec, ...pas, cote,
        h('details', { class: 'mt' }, h('summary', {}, 'Journal du socle'), h('ul', { class: 'incidents' }, (rec.journal || []).slice().reverse().map(j => h('li', {}, `${dateCourte(j.t)} — ${j.texte}`))))
      ].filter(Boolean));
    }
    if (cleFocus) {
      const cible = [...f.querySelectorAll('button, input, a, summary')].find(el => [el.dataset.action, el.dataset.id, el.dataset.zone, el.id].join('|') === cleFocus);
      if (cible) cible.focus();
    }
  }

  function dessinerBanc() {
    const liste = Object.values(reg.socles).filter(surLeBanc);
    $('#banc').hidden = !liste.length;
    $('#banc-grille').replaceChildren(...liste.map(r => {
      const v = vivant(r.id);
      const etat = r.etat === 'pret' ? 'prêt — à débrancher' : ['', '', 'sondes', 'chauffe', 'rodage'][r.etape];
      return h('div', { class: 'banc-carte' },
        h('div', { class: 'carte-tete' }, h('span', { class: 'id' }, r.id), h('span', { class: 'etat' + (v.enLigne ? ' ok' : '') }, v.enLigne ? 'en ligne' : 'absent')),
        h('div', { class: 'temps' }, [0, 1].map(i => h('span', {}, v.zones[i] ? `${Number(v.zones[i].temp).toFixed(1)} °C` : '—'))),
        h('span', { class: 'discret' }, etat + (r.etape === 4 && r.rodage && !r.rodage.verdict ? ` · encore ${duree(r.rodage.fin - Date.now())}` : '')
          + (r.rodage && r.rodage.incidents.length ? ` · ${r.rodage.incidents.length} incident(s)` : '')),
        bouton('Ouvrir', 'ouvrir', { 'data-id': r.id }, 'btn btn-secondaire btn-petit'));
    }));
  }

  function dessiner() { dessinerListe(); dessinerFiche(); }

  // Comptes à rebours : le texte change chaque seconde, l'arbre ne bouge pas.
  setInterval(() => {
    document.querySelectorAll('[data-fin]').forEach(el => {
      el.textContent = (el.dataset.prefixe || '') + secondes((+el.dataset.fin - Date.now()) / 1000);
    });
  }, 1000);
  setInterval(() => { surveillerRodages(); invaliderBanc(); }, delais.rodageVerif);

  // ------------------------------------------------- serveur et compte
  async function appelServeur(base, chemin, { methode = 'GET', corps, jeton } = {}) {
    let rep;
    try {
      rep = await fetch(base.replace(/\/+$/, '') + chemin, {
        method: methode,
        headers: { ...(corps ? { 'Content-Type': 'application/json' } : {}), ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
        body: corps ? JSON.stringify(corps) : undefined
      });
    } catch (e) { throw new Error(`Serveur injoignable (${base}) : adresse, ou cette page absente de ses ORIGINES.`, { cause: e }); }
    const d = await rep.json().catch(() => ({}));
    return { ok: rep.ok, status: rep.status, d: d || {} };
  }
  // Une session refusée (expirée, ou compte qui n'est plus administrateur) est
  // oubliée ; hors ligne, elle est gardée.
  async function verifierSession() {
    const s = sessionValide();
    if (!s) return;
    let r;
    try { r = await appelServeur(s.serveur, '/api/moi', { jeton: s.jeton }); } catch (e) { return; }
    if (session !== s) return;
    if (r.status === 401) oublierSession('Session expirée : reconnecte-toi dans les réglages de l\'atelier.');
    else if (r.ok && !r.d.admin && !r.d.atelier) oublierSession('Ce compte n\'a plus le rôle atelier : reconnecte-toi avec un compte de l\'atelier.');
    else if (r.ok && s.admin !== !!r.d.admin) { s.admin = !!r.d.admin; ecrireJson(localStorage, CLE_SESSION, s); }
  }
  const serveurSaisi = () => { const v = $('#r-serveur').value.trim(); return /^https:\/\//.test(v) ? origineDe(v) : ''; };
  function erreurReglages(texte) {
    const e = $('#reglages-erreur');
    e.textContent = texte;
    e.hidden = !texte;
  }
  function montrerCompte() {
    const s = session && session.serveur === (serveurSaisi() || origineDe(reg.reglages.serveur.url)) ? session : null;
    $('#compte-connecte').hidden = !s;
    $('#compte-connexion').hidden = !!s;
    $('#compte-login').textContent = s ? s.login : '';
  }
  async function demanderCode() {
    const base = serveurSaisi();
    if (!base) return erreurReglages('Adresse du serveur : https://…');
    const email = $('#r-email').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erreurReglages('Adresse e-mail invalide.');
    erreurReglages('');
    let r;
    try { r = await appelServeur(base, '/api/compte/code', { methode: 'POST', corps: { email } }); }
    catch (e) { return erreurReglages(e.message); }
    if (!r.ok) return erreurReglages(`Serveur : ${r.d.erreur || 'HTTP ' + r.status}.`);
    memo.email = email;
    ecrireJson(localStorage, CLE_MEMO, memo);
    $('#bloc-code').hidden = false;
    $('#r-code').focus();
    message(`Code envoyé à ${email} : il vaut 10 minutes.`);
  }
  async function connecterCompte() {
    const base = serveurSaisi();
    if (!base) return erreurReglages('Adresse du serveur : https://…');
    const email = $('#r-email').value.trim().toLowerCase();
    const code = $('#r-code').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return erreurReglages('Le code reçu par e-mail fait six chiffres.');
    erreurReglages('');
    let r;
    try { r = await appelServeur(base, '/api/compte/verifier', { methode: 'POST', corps: { email, code } }); }
    catch (e) { return erreurReglages(e.message); }
    if (!r.ok || !r.d.jeton) return erreurReglages(`Serveur : ${r.d.erreur || 'HTTP ' + r.status}.`);
    if (!r.d.admin && !r.d.atelier) {
      appelServeur(base, '/api/session', { methode: 'DELETE', jeton: r.d.jeton }).catch(() => {});
      return erreurReglages('Ce compte n\'a pas le rôle atelier : un administrateur le lui donne dans la console (Comptes → le compte → « Donner le rôle atelier »).');
    }
    session = { serveur: base, login: r.d.login || email, jeton: r.d.jeton, admin: !!r.d.admin };
    ecrireJson(localStorage, CLE_SESSION, session);
    // La liaison suit le compte : le serveur, à cette adresse.
    reg.reglages.liaison = 'serveur';
    reg.reglages.serveur.url = base;
    sauver();
    montrerLiaison('serveur');
    $('#r-code').value = '';
    $('#bloc-code').hidden = true;
    montrerCompte();
    relierBanc();
    message(`Connecté : ${session.login}.`);
    synchroniser().catch(() => {});
  }
  function deconnecterCompte() {
    const s = session;
    oublierSession();
    partage.actif = false;
    montrerCompte();
    montrerPartage();
    if (s) appelServeur(s.serveur, '/api/session', { methode: 'DELETE', jeton: s.jeton }).catch(() => {});
    message('Compte déconnecté de l\'atelier.');
  }

  // ------------------------------------------------ partage et alertes (réglages)
  function montrerPartage() {
    const actif = partage.actif;
    const e = $('#etat-partage');
    if (e) {
      e.hidden = !actif;
      e.textContent = actif ? `Registre partagé avec les autres postes de l'atelier${partage.vu ? ` (à jour à ${dateCourte(partage.vu).slice(-5)})` : ''}.` : '';
    }
    $('#wifi-partage').hidden = !actif;
    const alertes = partage.moi && partage.moi.alertes;
    $('#alertes-atelier').hidden = !(actif && alertes);
    if (alertes) $('#r-alertes-email').checked = alertes.email !== false;
  }
  async function reglerAlertesEmail(oui) {
    const s = sessionValide();
    if (!s) return;
    const r = await appelServeur(s.serveur, '/api/atelier/alertes', { methode: 'POST', corps: { email: oui }, jeton: s.jeton }).catch(e => ({ ok: false, d: { erreur: e.message } }));
    if (!r.ok) { message(`Alertes : ${r.d.erreur || 'serveur injoignable'}.`, true); return; }
    if (partage.moi) partage.moi.alertes = r.d.alertes;
    message(oui ? 'Alertes de l\'atelier par e-mail : activées.' : 'Alertes de l\'atelier par e-mail : coupées.');
  }
  // Notifications sur cet ordinateur : l'agent de service de l'application
  // (même origine), abonné auprès du service de push du navigateur ; le
  // serveur y envoie les alertes de l'atelier (fin de rodage, incident).
  const tt = /** @type {any} */ (window).trustedTypes;
  const politique = tt && typeof tt.createPolicy === 'function'
    ? (() => { try { return tt.createPolicy('atelier', { createScriptURL: u => { if (u !== 'sw.js') throw new Error('script refusé'); return u; } }); } catch (e) { return null; } })() : null;
  async function activerNotifications() {
    const s = sessionValide();
    const etat = t => { $('#etat-notifications').textContent = t; };
    if (!s) return etat('Connecte d\'abord ton compte.');
    if (!navigator.serviceWorker || !('PushManager' in window) || typeof window.Notification !== 'function') return etat('Ce navigateur ne reçoit pas de notifications.');
    const permis = await window.Notification.requestPermission();
    if (permis !== 'granted') return etat('Refusées par le navigateur : autorise-les dans les réglages du site (cadenas de la barre d\'adresse).');
    try {
      const k = await appelServeur(s.serveur, '/api/push/cle');
      if (!k.ok || !k.d.cle) return etat('Le serveur n\'envoie pas de notifications.');
      const reg = await navigator.serviceWorker.register(/** @type {any} */ (politique ? politique.createScriptURL('sw.js') : 'sw.js'));
      await navigator.serviceWorker.ready;
      const cle = k.d.cle;
      const brut = atob(cle.replace(/-/g, '+').replace(/_/g, '/').padEnd(cle.length + (4 - cle.length % 4) % 4, '='));
      const abo = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(brut, c => c.charCodeAt(0)) });
      const r = await appelServeur(s.serveur, '/api/push/abonnement', { methode: 'POST', corps: { abonnement: abo.toJSON ? abo.toJSON() : abo }, jeton: s.jeton });
      if (!r.ok) return etat(`Serveur : ${r.d.erreur || 'HTTP ' + r.status}.`);
      memo.notifications = true;
      ecrireJson(localStorage, CLE_MEMO, memo);
      etat('Activées sur cet ordinateur.');
    } catch (e) { etat(`Impossible : ${e.message || e}`); }
  }

  // ------------------------------------------------------------ réglages
  function ouvrirReglages() {
    const r = reg.reglages;
    const v = (id, x) => { $(id).value = x === undefined || x === null ? '' : x; };
    v('#r-url', r.urlApp); v('#r-ssid', r.ssid); v('#r-wifi-mdp', secrets.wifiMdp);
    // Retenir le Wi-Fi : coché d'office, sauf si l'opérateur l'a décoché.
    $('#r-wifi-retenir').checked = memo.retenirWifi !== false && (!!memo.wifiMdp || !secrets.wifiMdp);
    v('#r-serveur', r.serveur.url || serveurDeploye); v('#r-admin', secrets.adminJeton); v('#r-s-hote', r.serveur.hote); v('#r-s-port', r.serveur.port); v('#r-s-ws', r.serveur.ws);
    v('#r-email', (session && session.login) || memo.email); v('#r-code', '');
    $('#bloc-code').hidden = true;
    montrerCompte();
    v('#r-b-ws', r.broker.ws); v('#r-b-hote', r.broker.hote); v('#r-b-port', r.broker.port); v('#r-b-prefixe', r.broker.prefixe);
    v('#r-b-user', r.broker.utilisateur); v('#r-b-mdp', secrets.brokerMdp);
    $('#r-b-oublier').checked = r.broker.oublier !== false;
    v('#r-rodage', r.rodageH);
    $('#r-auto').checked = r.auto !== false;
    $('#reseaux-captes').replaceChildren(...reseauxCaptes.map(x => h('option', { value: x.ssid }, `${x.rssi} dBm`)));
    montrerPartage();
    montrerLiaison(r.liaison);
    $('#reglages-erreur').hidden = true;
    $('#reglages').hidden = false;
    $('[data-action="reglages"]').setAttribute('aria-expanded', 'true');
    $('#r-url').focus();
  }
  function fermerReglages() {
    $('#reglages').hidden = true;
    $('[data-action="reglages"]').setAttribute('aria-expanded', 'false');
  }
  function montrerLiaison(l) {
    document.querySelectorAll('[data-liaison]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.liaison === l)));
    document.querySelectorAll('[data-pour]').forEach(d => { d.hidden = d.dataset.pour !== l; });
  }
  function enregistrerReglages() {
    const val = id => $(id).value.trim();
    const liaison = (document.querySelector('[data-liaison][aria-pressed="true"]') || { dataset: { liaison: 'aucune' } }).dataset.liaison;
    const erreur = t => { const e = $('#reglages-erreur'); e.textContent = t; e.hidden = false; return false; };
    const url = val('#r-url');
    if (url) { try { new URL(url); } catch (e) { return erreur('Adresse de l\'application invalide.'); } }
    const ssid = val('#r-ssid'), wifiMdp = $('#r-wifi-mdp').value;
    if (/\s/.test(ssid) || /\s/.test(wifiMdp)) return erreur('Wi-Fi du banc : ni espace dans le nom ni dans le mot de passe.');
    if (liaison === 'serveur' && !/^https:\/\//.test(val('#r-serveur'))) return erreur('Adresse du serveur : https://…');
    if (liaison === 'broker' && !/^wss?:\/\//.test(val('#r-b-ws'))) return erreur('Broker pour cette page : wss://…');
    const rodageH = Math.min(168, Math.max(1, parseInt(val('#r-rodage'), 10) || 24));
    const wifiAvant = `${reg.reglages.ssid}\n${secrets.wifiMdp || ''}`;
    reg.reglages = {
      urlApp: url || new URL('./', location.href).href, ssid, liaison,
      serveur: { url: val('#r-serveur'), hote: val('#r-s-hote'), port: parseInt(val('#r-s-port'), 10) || 8883, ws: val('#r-s-ws') },
      broker: { ws: val('#r-b-ws'), hote: val('#r-b-hote'), port: parseInt(val('#r-b-port'), 10) || 8883, prefixe: val('#r-b-prefixe') || 'terrarium', utilisateur: val('#r-b-user'), oublier: $('#r-b-oublier').checked },
      rodageH, auto: $('#r-auto').checked
    };
    secrets = { wifiMdp, adminJeton: $('#r-admin').value.trim(), brokerMdp: $('#r-b-mdp').value };
    memo.retenirWifi = $('#r-wifi-retenir').checked;
    if (memo.retenirWifi && wifiMdp) memo.wifiMdp = wifiMdp; else delete memo.wifiMdp;
    ecrireJson(localStorage, CLE_MEMO, memo);
    sauver(); sauverSecrets();
    // Le Wi-Fi du banc, saisi ici, vaut pour tout l'atelier.
    if (partage.actif && ssid && `${ssid}\n${wifiMdp}` !== wifiAvant) envoyerWifi().catch(() => {});
    relierBanc();
    fermerReglages();
    message('Réglages enregistrés.');
    return true;
  }

  // ----------------------------------------------------------- événements
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action], [data-liaison], [data-filtre]');
    if (!b || b.disabled) return;
    if (b.dataset.liaison) { montrerLiaison(b.dataset.liaison); return; }
    if (b.dataset.filtre) { filtre = b.dataset.filtre; invalider(); return; }
    const rec = b.dataset.id ? socle(b.dataset.id) : null;
    switch (b.dataset.action) {
      case 'reglages': $('#reglages').hidden ? ouvrirReglages() : fermerReglages(); break;
      case 'fermer-reglages': fermerReglages(); break;
      // Nouveau socle : la console s'ouvre tout de suite (la carte est déjà
      // branchée) ; sans port choisi, la fiche propose de la connecter.
      case 'nouveau':
        selection = null; nouveau = true;
        if (procedure && !procedure.id) procedure = null;
        invalider(); $('#fiche').focus();
        if (!procedure) etapeConsole(null);
        break;
      case 'code': demanderCode(); break;
      case 'connecter': connecterCompte(); break;
      case 'deconnecter': deconnecterCompte(); break;
      case 'nouveau-lot': { const l = nouveauLot(); if (reg.lots.some(x => x.nom === l.nom)) l.nom += ` (${reg.lots.length + 1})`; reg.lots.push(l); reg.lotCourant = l.id; sauver(); invalider(); message(`${l.nom} créé.`); break; }
      case 'ouvrir': choisir(b.dataset.id); $('#fiche').focus(); break;
      case 'console': etapeConsole(rec ? rec.id : null); break;
      // Console seule, pour taper des commandes (dépannage, SAV) : sans procédure.
      case 'console-libre':
        if (serie && serie.ouvert) fermerConsole();
        else ouvrirConsole().then(() => $('#console-ligne').focus(), err => { if (err && err.name !== 'NotFoundError') message(err.message || String(err), true); });
        break;
      case 'identifier': if (rec) identifier(rec, parseInt(b.dataset.zone, 10)); break;
      case 'relire': if (rec) lireSondes(rec, true); break;
      case 'essais': if (rec) essais(rec); break;
      case 'conclure': if (rec) conclureRodage(rec).catch(err => message(err.message, true)); break;
      case 'recommencer': if (rec) recommencerRodage(rec); break;
      case 'forcer': if (rec) conclureRodage(rec, 'ok'); break;
      case 'manuel-sondes': if (rec) { rec.etape = 3; rec.echec = null; noter(rec, 'Sondes liées sur la page locale (validé par l\'opérateur)'); sauver(); invalider(); } break;
      case 'manuel-chauffe': if (rec) { rec.chauffe = [1, 2].map(z => ({ zone: z, ok: true, texte: 'validé sur la page locale', t: Date.now() })); demarrerRodage(rec); invalider(); } break;
      case 'manuel-rodage-ok': if (rec) conclureRodage(rec, 'ok'); break;
      case 'manuel-rodage-ko': if (rec) conclureRodage(rec, 'ko'); break;
      case 'preparer': if (rec) preparerExpedition(rec); break;
      case 'preparer-reseau': if (rec) preparerParReseau(rec); break;
      case 'reprendre-ici': if (rec) reprendreIci(rec); break;
      case 'wifi-reseau':
        $('#cw-ssid').value = b.dataset.ssid;
        document.querySelectorAll('[data-action="wifi-reseau"]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        $('#cw-mdp').focus();
        break;
      case 'wifi-forcer': finirChoixWifi('forcer'); break;
      case 'wifi-annuler': finirChoixWifi(null); break;
      case 'notifications': activerNotifications(); break;
      case 'imprimer': if (rec) imprimerEtiquette(rec); break;
      case 'svg': if (rec) telechargerEtiquette(rec); break;
      case 'expedier': if (rec) expedier(rec); break;
      case 'reprendre': if (rec) reprendre(rec); break;
      case 'exporter': exporterCsv(); break;
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'lot-courant') { reg.lotCourant = e.target.value; ecrireLocal(); invalider(); }
    if (e.target.id === 'r-alertes-email') reglerAlertesEmail(e.target.checked);
  });
  document.addEventListener('input', e => { if (e.target.id === 'r-serveur') montrerCompte(); });
  // Entrée dans le champ du code : se connecter (et non enregistrer tout le formulaire).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'r-code') { e.preventDefault(); connecterCompte(); }
    else if (e.target.id === 'r-email') { e.preventDefault(); demanderCode(); }
  });
  document.addEventListener('submit', e => {
    const f = e.target;
    e.preventDefault();
    if (f.id === 'form-reglages') enregistrerReglages();
    else if (f.id === 'form-choix-wifi') validerChoixWifi();
    else if (f.id === 'form-console') {
      const ligne = $('#console-ligne').value.trim();
      if (!ligne) return;
      ecrire(ligne).then(() => { $('#console-ligne').value = ''; }, err => message(err.message, true));
    } else if (f.dataset.form === 'cote') {
      const rec = socle(f.dataset.id);
      if (rec) mettreDeCote(rec, f.elements.raison.value.trim());
    }
  });
  if (navigator.serial && navigator.serial.addEventListener) {
    navigator.serial.addEventListener('disconnect', ev => { if (serie && ev.target === serie.port) fermerConsole(serie); });
    // Une carte branchée sur un port déjà autorisé : l'étape qui l'attend démarre.
    navigator.serial.addEventListener('connect', ev => { auBranchement(ev.target).catch(err => message(err.message || String(err), true)); });
  }

  // ------------------------------------------------------------ démarrage
  $('#sans-serie').hidden = serieDisponible();
  etatConsole();
  dessiner();
  dessinerBanc();
  // mqtt.js est chargé avant (defer, dans l'ordre) ; relier le banc s'il est réglé.
  relierBanc();
  verifierSession();
  if (!localStorage.getItem(CLE)) ecrireLocal();
  // Une alerte touchée (notification) ouvre l'atelier sur son socle.
  function ouvrirDepuisAdresse() { const m = /^#(terra[0-9A-Za-z]{6})$/.exec(location.hash); if (m && socle(m[1])) choisir(m[1]); }
  ouvrirDepuisAdresse();
  window.addEventListener('hashchange', ouvrirDepuisAdresse);
  if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', e => {
      const d = e.data || {};
      if (d.type === 'ouvrirSocle' && d.page === 'atelier' && socle(d.socle)) choisir(d.socle);
    });
  }
  // Le registre partagé : relu tout de suite, puis toutes les quinze secondes.
  synchroniser().catch(() => {});
  setInterval(() => { if (!document.hidden || Date.now() - partage.vu > 60000) synchroniser().catch(() => {}); }, delais.synchro);

  // Pour les bancs d'essai (outils/test-atelier.js).
  window.Atelier = {
    registre: () => reg,
    vif: id => vivant(id),
    procedure: () => procedure,
    choisir,
    lienEtiquette: id => lienEtiquette(socle(id)),
    etiquette: id => new window.XMLSerializer().serializeToString(etiquetteSvg(socle(id))),
    _delais: d => Object.assign(delais, d),
    _surveiller: surveillerRodages,
    _connecte: () => !!(client && client.connected),
    _installateur: f => { installateur = f; },
    _session: () => session,
    _synchro: synchroniser,
    _partage: () => partage,
    _branchement: auBranchement,
    _reseaux: () => reseauxCaptes,
    _choixWifi: reseaux => { reseauxCaptes = reseaux; return demanderWifi({ reseaux, texte: 'Choisis le Wi-Fi du banc.', forcer: true }); },
    _montrerPartage: montrerPartage
  };
})();
