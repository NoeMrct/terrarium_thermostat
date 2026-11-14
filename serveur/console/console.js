/* =============================================================================
   Console d'administration du serveur Terrariums (/console/).
   -----------------------------------------------------------------------------
   Pour l'exploitant : l'état de la flotte (ce que les socles publient), les
   comptes et leurs droits, les comptes d'appareil (mots de passe MQTT), les
   rapports de diagnostic envoyés par les propriétaires, et le journal d'audit
   chaîné où chaque geste fait ici est noté.

   - Connexion : compte administrateur (mot de passe, code par e-mail ou clé
     d'accès) ou jeton d'administration. Le jeton de session vit dans
     sessionStorage : il disparaît avec l'onglet.
   - Données personnelles masquées par défaut (« no…@exemple.fr ») : un bouton
     les montre le temps d'une recherche, jusqu'au prochain chargement.
   - Gestes lourds (effacer un compte, retirer un compte d'appareil) : la
     référence est à taper. Un mot de passe tiré par le serveur n'est montré
     qu'une fois, puis effacé de la page.
   - Le DOM s'écrit élément par élément (pas d'innerHTML) : la politique de
     sécurité de la page exige les Trusted Types, sans politique permise.
   ============================================================================= */
(function () {
  'use strict';

  const CLE = 'terrarium.console.session';
  const RAFRAICHIR_MS = 15000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const Node = window.Node;

  const etat = {
    session: null,            // { jeton, type: 'compte' | 'jeton', qui }
    moi: null,                // réponse de /api/admin/moi
    infos: null,              // /api/infos (public)
    onglet: 'tableau',
    donneesVisibles: false,
    filtres: { socles: 'tous', comptes: 'tous' },
    tableau: null, socles: [], comptes: [], appareils: [], rapports: [], journal: null,
    fiche: null,              // { type: 'socle' | 'compte', id }
    lecture: null,            // nom du rapport ouvert
    emailEnCours: null,
    minuteur: null
  };

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
  function s(tag, attrs, ...enfants) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    for (const e of enfants) if (e !== null && e !== undefined && e !== false) el.append(e instanceof Node ? e : String(e));
    return el;
  }
  const vider = el => { while (el.firstChild) el.firstChild.remove(); return el; };
  const remplir = (el, ...enfants) => { vider(el).append(...enfants.flat(Infinity).filter(e => e !== null && e !== undefined && e !== false)); return el; };

  const nombre = n => Number(n || 0).toLocaleString('fr-FR');
  const degres = c => (c === undefined || c === null || c === '' || !isFinite(Number(c))) ? '—'
    : `${Number(c).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°`;
  const date = iso => iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  function depuis(iso) {
    if (!iso) return 'jamais';
    const s_ = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s_ < 60) return 'à l\'instant';
    if (s_ < 3600) return `il y a ${Math.floor(s_ / 60)} min`;
    if (s_ < 86400) return `il y a ${Math.floor(s_ / 3600)} h`;
    if (s_ < 30 * 86400) return `il y a ${Math.floor(s_ / 86400)} j`;
    return date(iso);
  }
  function duree(sec) {
    if (!(sec >= 0)) return '—';
    const j = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return j ? `${j} j ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
  }
  const octets = n => n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Ko` : `${(n / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;

  // Données personnelles : masquées tant que l'exploitant ne les demande pas.
  function pii(x) {
    if (x === null || x === undefined || x === '') return '—';
    const t = String(x);
    if (etat.donneesVisibles) return t;
    if (t.includes('@')) return t.replace(/^(.{0,2})[^@]*/, '$1…');
    return t.length <= 2 ? t : t.slice(0, 2) + '…';
  }
  // Les références du journal (« no…@exemple.fr #3f9a… ») sont déjà pseudonymes.
  const quiAffiche = q => (['titulaire', 'jeton d\'administration', 'ligne de commande', 'serveur'].includes(q) ? q : pii(q));

  let minuteurMessage = null;
  function message(texte, erreur = false) {
    const m = $('#message');
    remplir(m, texte);
    m.classList.toggle('erreur', !!erreur);
    m.classList.add('visible');
    clearTimeout(minuteurMessage);
    minuteurMessage = setTimeout(() => m.classList.remove('visible'), erreur ? 7000 : 3500);
  }

  function telecharger(nom, contenu, type) {
    const url = URL.createObjectURL(new Blob([contenu], { type }));
    const a = h('a', { href: url, download: nom, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const versB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const deB64u = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4)), c => c.charCodeAt(0));

  // ------------------------------------------------------------------ API
  class ErreurApi extends Error {
    constructor(message, statut) { super(message); this.statut = statut; }
  }

  /** @param {string} methode @param {string} chemin @param {any} [corps] @param {{ jeton?: string, brut?: boolean }} [options] */
  async function requete(methode, chemin, corps, options = {}) {
    const { jeton, brut } = options;
    const entetes = {};
    if (corps !== undefined) entetes['Content-Type'] = 'application/json';
    if (jeton) entetes.Authorization = `Bearer ${jeton}`;
    let r;
    try { r = await fetch(chemin, { method: methode, headers: entetes, body: corps === undefined ? undefined : JSON.stringify(corps), cache: 'no-store' }); }
    catch (e) { throw new ErreurApi('serveur injoignable', 0); }
    if (brut && r.ok) return r;
    let d = null;
    try { d = await r.json(); } catch (e) { /* corps vide ou texte */ }
    if (!r.ok) throw new ErreurApi((d && d.erreur) || `erreur ${r.status}`, r.status);
    return d;
  }

  // Appel administrateur : une session refusée ramène à la connexion.
  async function admin(methode, chemin, corps, options = {}) {
    if (!etat.session) throw new ErreurApi('session requise', 401);
    try { return await requete(methode, chemin, corps, { ...options, jeton: etat.session.jeton }); }
    catch (e) {
      if (e.statut === 401 || e.statut === 403) { sortir(e.statut === 403 ? 'Accès refusé : session expirée ou droits retirés.' : 'Session expirée.'); }
      throw e;
    }
  }
  const echec = e => { if (e && e.statut !== 401 && e.statut !== 403) message(e.message || String(e), true); };

  // ------------------------------------------------------------------ connexion
  function mode(m) {
    for (const b of $$('#connexion [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    $('#form-compte').hidden = m !== 'compte';
    $('#form-code').hidden = true;
    $('#form-jeton').hidden = m !== 'jeton';
    remplir($('#connexion-erreur'));
    (m === 'jeton' ? $('#c-jeton') : $('#c-login')).focus();
  }
  const erreurConnexion = t => remplir($('#connexion-erreur'), t);

  async function ouvrirAvec(jeton, type) {
    const moi = await requete('GET', '/api/admin/moi', undefined, { jeton });
    etat.session = { jeton, type, qui: moi.qui };
    etat.moi = moi;
    try { sessionStorage.setItem(CLE, JSON.stringify(etat.session)); } catch (e) { /* navigation privée stricte : la session vit le temps de la page */ }
    entrer();
  }

  // Une session de compte qui n'est pas administrateur est refermée aussitôt.
  async function sessionCompte(r) {
    if (!r.admin) {
      await requete('DELETE', '/api/session', undefined, { jeton: r.jeton }).catch(() => {});
      throw new ErreurApi('ce compte n\'a pas accès à la console (il n\'est pas administrateur)', 403);
    }
    await ouvrirAvec(r.jeton, 'compte');
  }

  async function connexionCompte() {
    const login = $('#c-login').value.trim(), mdp = $('#c-mdp').value;
    if (!login) { erreurConnexion('Indiquer l\'identifiant ou l\'e-mail.'); $('#c-login').focus(); return; }
    erreurConnexion('');
    try {
      if (mdp) {
        const r = await requete('POST', '/api/session', { login, motDePasse: mdp });
        $('#c-mdp').value = '';
        await sessionCompte(r);
        return;
      }
      if (!/@/.test(login)) { erreurConnexion('Mot de passe requis pour un identifiant (le code par e-mail vaut pour une adresse e-mail).'); $('#c-mdp').focus(); return; }
      if (etat.infos && etat.infos.comptes && !etat.infos.comptes.email) { erreurConnexion('Ce serveur n\'envoie pas d\'e-mail (SMTP_URL absent) : se connecter avec un mot de passe ou le jeton.'); return; }
      await requete('POST', '/api/compte/code', { email: login });
      etat.emailEnCours = login.toLowerCase();
      $('#form-compte').hidden = true;
      $('#form-code').hidden = false;
      remplir($('#c-code-aide'), `Un code à six chiffres vient de partir vers ${login}. Il vaut 10 minutes.`);
      $('#c-code').value = '';
      $('#c-code').focus();
    } catch (e) { erreurConnexion(e.message); }
  }

  async function connexionCode() {
    const code = $('#c-code').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { erreurConnexion('Le code a six chiffres.'); return; }
    try { await sessionCompte(await requete('POST', '/api/compte/verifier', { email: etat.emailEnCours, code })); }
    catch (e) { erreurConnexion(e.statut === 401 ? 'Code incorrect ou expiré.' : e.message); }
  }

  async function connexionCle() {
    erreurConnexion('');
    try {
      const o = await requete('POST', '/api/cles/options-connexion', {});
      const cred = await navigator.credentials.get({ publicKey: { challenge: deB64u(o.challenge), rpId: o.rpId, timeout: o.timeout,
        userVerification: o.userVerification, allowCredentials: [] } });
      const r = /** @type {any} */ (cred).response;
      await sessionCompte(await requete('POST', '/api/cles/connexion', { defi: o.challenge, id: cred.id,
        clientDataJSON: versB64u(r.clientDataJSON), authenticatorData: versB64u(r.authenticatorData),
        signature: versB64u(r.signature), userHandle: r.userHandle ? versB64u(r.userHandle) : null }));
    } catch (e) {
      erreurConnexion(e && e.name === 'NotAllowedError' ? 'Clé d\'accès annulée.' : `Clé d'accès refusée : ${e.message || e}`);
    }
  }

  async function connexionJeton() {
    const jeton = $('#c-jeton').value.trim();
    if (!jeton) { erreurConnexion('Coller le jeton d\'administration.'); return; }
    try { await ouvrirAvec(jeton, 'jeton'); $('#c-jeton').value = ''; }
    catch (e) { erreurConnexion(e.statut === 403 ? 'Jeton refusé.' : e.message); }
  }

  function entrer() {
    $('#connexion').hidden = true;
    $('#espace').hidden = false;
    $('#btn-sortir').hidden = false;
    $('#btn-donnees').hidden = false;
    const e = $('#etat-serveur');
    e.className = 'etat ok';
    remplir(e, etat.session.type === 'jeton' ? 'Jeton d\'administration' : pii(etat.session.qui));
    onglet(etat.onglet, false);
    planifier();
  }

  // Fin de session (demandée ou subie) : tout ce qui vient du serveur quitte la page.
  function sortir(raison) {
    const s_ = etat.session;
    etat.session = null; etat.moi = null;
    try { sessionStorage.removeItem(CLE); } catch (e) { /* rien à retirer */ }
    if (s_ && s_.type === 'compte' && !raison) requete('DELETE', '/api/session', undefined, { jeton: s_.jeton }).catch(() => {});
    clearTimeout(etat.minuteur);
    for (const d of $$('dialog[open]')) d.close();
    for (const id of ['#corps-socles', '#corps-comptes', '#corps-appareils', '#corps-rapports', '#liste-journal', '#tuiles', '#a-regarder', '#infos-serveur', '#versions', '#fiche-corps', '#lecture-texte']) vider($(id));
    etat.tableau = null; etat.socles = []; etat.comptes = []; etat.appareils = []; etat.rapports = []; etat.journal = null;
    etat.donneesVisibles = false;
    $('#btn-donnees').setAttribute('aria-pressed', 'false');
    remplir($('#btn-donnees'), 'Afficher les données personnelles');
    $('#espace').hidden = true;
    $('#btn-sortir').hidden = true;
    $('#btn-donnees').hidden = true;
    $('#connexion').hidden = false;
    const e = $('#etat-serveur');
    e.className = 'etat';
    remplir(e, 'Hors connexion');
    mode('compte');
    if (raison) erreurConnexion(raison);
  }

  // ------------------------------------------------------------------ navigation
  function onglet(nom, focus = true) {
    etat.onglet = nom;
    for (const b of $$('.rubriques-console [data-onglet]')) {
      if (b.dataset.onglet === nom) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    for (const v of $$('.vue-console')) v.hidden = v.id !== `v-${nom}`;
    charger(nom).catch(echec);
    if (focus) { const t = $(`#v-${nom} h2`); if (t) { t.setAttribute('tabindex', '-1'); t.focus(); } }
  }

  async function charger(nom) {
    if (nom === 'tableau') {
      const [t, sl] = await Promise.all([admin('GET', '/api/admin/tableau'), admin('GET', '/api/admin/socles')]);
      etat.tableau = t; etat.socles = sl.socles;
      vueTableau();
    } else if (nom === 'socles') { etat.socles = (await admin('GET', '/api/admin/socles')).socles; vueSocles(); }
    else if (nom === 'comptes') { etat.comptes = (await admin('GET', '/api/admin/utilisateurs')).utilisateurs; vueComptes(); }
    else if (nom === 'appareils') { etat.appareils = (await admin('GET', '/api/admin/appareils')).appareils; vueAppareils(); }
    else if (nom === 'rapports') { etat.rapports = (await admin('GET', '/api/admin/rapports')).rapports; vueRapports(); }
    else if (nom === 'journal') { await chargerJournal(); }
  }

  // Le tableau de bord et la liste des socles suivent la flotte d'eux-mêmes,
  // onglet visible seulement ; une fiche de socle ouverte aussi.
  function planifier() {
    clearTimeout(etat.minuteur);
    etat.minuteur = setTimeout(async () => {
      if (etat.session && document.visibilityState === 'visible') {
        try {
          if (etat.onglet === 'tableau' || etat.onglet === 'socles') await charger(etat.onglet);
          if (etat.fiche && etat.fiche.type === 'socle' && $('#fiche').open) await ficheSocle(etat.fiche.id, false);
        } catch (e) { /* une coupure passagère : on réessaie au tour suivant */ }
      }
      if (etat.session) planifier();
    }, RAFRAICHIR_MS);
  }

  function rerendre() {
    if (etat.onglet === 'tableau' && etat.tableau) vueTableau();
    else if (etat.onglet === 'socles') vueSocles();
    else if (etat.onglet === 'comptes') vueComptes();
    else if (etat.onglet === 'appareils') vueAppareils();
    else if (etat.onglet === 'rapports') vueRapports();
    else if (etat.onglet === 'journal' && etat.journal) vueJournal();
    if (etat.fiche && $('#fiche').open) (etat.fiche.type === 'socle' ? ficheSocle : ficheCompte)(etat.fiche.id, false).catch(echec);
    if (etat.session) remplir($('#etat-serveur'), etat.session.type === 'jeton' ? 'Jeton d\'administration' : pii(etat.session.qui));
  }

  // ------------------------------------------------------------------ vues
  const badge = (texte, ton) => h('span', { class: `badge ${ton || 'neutre'}`, texte });
  function badgesSocle(x) {
    const b = [];
    if (x.jamaisVu) b.push(badge('jamais vu', 'neutre'));
    else b.push(x.enLigne ? badge('en ligne', 'ok') : badge('hors ligne', 'warn'));
    if (x.zones && x.zones.some(z => z.defaut)) b.push(badge('défaut', 'ko'));
    if (x.plantage) b.push(badge('plantage', 'warn'));
    if (x.maj && /echec|retour/.test(x.maj.etape || '')) b.push(badge(`mise à jour : ${x.maj.etape}`, 'ko'));
    return h('span', { class: 'badges' }, b);
  }
  const lienSocle = id => h('button', { type: 'button', class: 'lien id-socle', 'data-socle': id, texte: id });
  const lienCompte = login => h('button', { type: 'button', class: 'lien', 'data-compte': login, texte: pii(login) });
  function zonesMini(zones) {
    if (!zones || !zones.length) return h('span', { class: 'discret', texte: '—' });
    return h('span', { class: 'zones-mini' }, zones.map(z => h('span', {},
      h('i', { 'aria-hidden': 'true' }),
      z.defaut ? h('span', { class: 'ko', texte: typeof z.defaut === 'string' ? z.defaut : 'défaut' }) : `${degres(z.temp)} / ${degres(z.consigne)}`)));
  }

  function tuile(valeur, libelle, cible, ton) {
    return h('button', { type: 'button', class: 'tuile', 'data-aller': cible, 'data-ton': ton || null },
      h('b', { texte: valeur }), h('span', { texte: libelle }));
  }

  function vueTableau() {
    const t = etat.tableau;
    remplir($('#tuiles'),
      tuile(`${nombre(t.socles.enLigne)} / ${nombre(t.socles.total)}`, 'socles en ligne', 'socles:enligne'),
      tuile(nombre(t.socles.horsLigne), 'hors ligne', 'socles:horsligne', t.socles.horsLigne ? 'warn' : null),
      tuile(nombre(t.socles.enDefaut), 'en défaut', 'socles:defaut', t.socles.enDefaut ? 'ko' : null),
      tuile(nombre(t.socles.sansProprietaire), 'sans propriétaire', 'socles:orphelin'),
      tuile(nombre(t.comptes.total), `comptes (${nombre(t.comptes.email)} par e-mail)`, 'comptes:tous'),
      tuile(nombre(t.comptes.admins), 'administrateurs', 'comptes:admins'),
      tuile(nombre(t.rapports.semaine), 'rapports sur 7 jours', 'rapports'),
      tuile(t.audit.ok ? nombre(t.audit.n) : 'rupture', t.audit.ok ? 'lignes au journal, chaîne intègre' : 'journal d\'audit', 'journal', t.audit.ok ? null : 'ko'));

    // À regarder : du plus urgent au plus doux.
    const items = [];
    for (const x of etat.socles) {
      const def = (x.zones || []).filter(z => z.defaut);
      if (def.length) items.push(h('li', {}, h('span', {}, lienSocle(x.id), ` — défaut : ${def.map(z => (typeof z.defaut === 'string' ? z.defaut : 'défaut')).join(', ')}`), h('span', { texte: depuis(x.vu) })));
    }
    for (const x of etat.socles) if (x.maj && /echec|retour/.test(x.maj.etape || '')) items.push(h('li', {}, h('span', {}, lienSocle(x.id), ` — mise à jour ${x.maj.etape} (${x.maj.version || '?'})`), h('span', { texte: '' })));
    for (const x of etat.socles) if (x.plantage) items.push(h('li', {}, h('span', {}, lienSocle(x.id), ' — un plantage attend d\'être lu (coredump)'), h('span', { texte: '' })));
    for (const x of etat.socles) {
      if (!x.jamaisVu && !x.enLigne && x.proprietaires.length && Date.now() - Date.parse(x.vu) > 3600000) {
        items.push(h('li', {}, h('span', {}, lienSocle(x.id), ' — hors ligne'), h('span', { texte: depuis(x.vu) })));
      }
    }
    if (!t.audit.ok) items.unshift(h('li', {}, h('span', { texte: `Journal d'audit : ${t.audit.rupture ? t.audit.rupture.raison : 'rupture'}` }), h('span', { texte: '' })));
    remplir($('#a-regarder'), items.length ? items : h('li', {}, h('span', { texte: 'Rien à signaler.' })));

    const sv = t.serveur;
    const ligne = (dt, dd) => [h('dt', { texte: dt }), h('dd', {}, dd)];
    remplir($('#infos-serveur'),
      ligne('Version', sv.version),
      ligne('Démarré', `${date(sv.demarre)} (${depuis(sv.demarre)})`),
      ligne('Clients MQTT', nombre(sv.mqtt.clients)),
      ligne('MQTT TCP', sv.mqtt.tcp ? String(sv.mqtt.tcp) : 'désactivé'),
      ligne('Pont amont', sv.amont ? `${sv.amont.hote} — ${sv.amont.connecte ? 'connecté' : 'déconnecté'}` : 'aucun'),
      ligne('Notifications push', sv.push ? 'actives' : 'désactivées'),
      ligne('Connexion par e-mail', sv.email ? 'active' : 'non configurée (SMTP_URL)'),
      ligne('Clés d\'accès (RP ID)', sv.rpId || 'domaine de chaque page'),
      ligne('Origines de l\'API', Array.isArray(sv.origines) ? sv.origines.join(', ') : 'toutes'));
    remplir($('#nom-serveur'), `· serveur ${sv.version}`);

    const versions = Object.entries(t.socles.versions).sort((a, b) => b[1] - a[1]);
    remplir($('#versions'), versions.length ? versions.map(([v, n]) => h('li', {}, h('span', { class: 'id-socle', texte: v }), h('span', { texte: `${nombre(n)} socle${n > 1 ? 's' : ''}` })))
      : h('li', {}, h('span', { texte: 'Aucun socle n\'a encore publié sa santé.' })));
  }

  function filtrer(liste, champTexte, filtre, recherche) {
    const q = recherche.trim().toLowerCase();
    return liste.filter(x => filtre(x) && (!q || champTexte(x).toLowerCase().includes(q)));
  }

  function vueSocles() {
    const f = etat.filtres.socles;
    const garde = { tous: () => true, enligne: x => x.enLigne, horsligne: x => !x.enLigne && !x.jamaisVu,
      defaut: x => (x.zones || []).some(z => z.defaut), orphelin: x => !x.proprietaires.length }[f] || (() => true);
    const liste = filtrer(etat.socles, x => [x.id, ...x.proprietaires].join(' '), garde, $('#f-socles').value);
    remplir($('#corps-socles'), liste.map(x => h('tr', {},
      h('th', { scope: 'row' }, lienSocle(x.id)),
      h('td', {}, badgesSocle(x)),
      h('td', { class: 'num' }, depuis(x.vu)),
      h('td', { class: 'num' }, x.version ? `${x.version}${x.proto ? ` · p${x.proto}` : ''}` : '—'),
      h('td', { class: 'num' }, x.rssi !== undefined && x.rssi !== null ? `${x.rssi} dBm` : '—'),
      h('td', {}, zonesMini(x.zones)),
      h('td', {}, x.proprietaires.length ? x.proprietaires.map((p, i) => [i ? ', ' : '', lienCompte(p)]) : h('span', { class: 'discret', texte: 'aucun' })))));
    $('#socles-vide').hidden = liste.length > 0;
  }

  function vueComptes() {
    const f = etat.filtres.comptes;
    const garde = { tous: () => true, admins: x => x.admin, sanssocle: x => !x.socles.length }[f] || (() => true);
    const liste = filtrer(etat.comptes, x => [x.login, x.email || ''].join(' '), garde, $('#f-comptes').value);
    remplir($('#corps-comptes'), liste.map(x => h('tr', {},
      h('th', { scope: 'row' }, lienCompte(x.login)),
      h('td', {}, x.type === 'email' ? 'e-mail' : 'mot de passe'),
      h('td', {}, x.admin ? badge('administrateur', 'warn') : h('span', { class: 'discret', texte: 'propriétaire' })),
      h('td', { class: 'num' }, x.socles.length ? x.socles.map((id, i) => [i ? ' ' : '', lienSocle(id)]) : '0'),
      h('td', { class: 'num' }, nombre(x.cles)),
      h('td', { class: 'num' }, nombre(x.sessions)),
      h('td', { class: 'num' }, depuis(x.derniereConnexion)))));
    $('#comptes-vide').hidden = liste.length > 0;
  }

  function vueAppareils() {
    remplir($('#corps-appareils'), etat.appareils.map(x => h('tr', {},
      h('th', { scope: 'row' }, lienSocle(x.id)),
      h('td', { class: 'num' }, date(x.cree)),
      h('td', { class: 'num' }, x.renouvele ? date(x.renouvele) : '—'),
      h('td', { class: 'num' }, x.enLigne ? badge('en ligne', 'ok') : depuis(x.vu)),
      h('td', {}, x.proprietaires.length ? x.proprietaires.map((p, i) => [i ? ', ' : '', lienCompte(p)]) : h('span', { class: 'discret', texte: 'aucun' })),
      h('td', {}, h('span', { class: 'badges' },
        h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'renouveler-appareil', 'data-id': x.id, texte: 'Changer le mot de passe' }),
        h('button', { type: 'button', class: 'btn btn-danger btn-petit', 'data-action': 'retirer-appareil', 'data-id': x.id, texte: 'Retirer' }))))));
    $('#appareils-vide').hidden = etat.appareils.length > 0;
  }

  function vueRapports() {
    remplir($('#corps-rapports'), etat.rapports.map(x => h('tr', {},
      h('th', { scope: 'row', class: 'num' }, date(x.date)),
      h('td', {}, pii(x.compte)),
      h('td', { class: 'num' }, octets(x.octets)),
      h('td', {}, h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'lire-rapport', 'data-nom': x.nom, texte: 'Lire' })))));
    $('#rapports-vide').hidden = etat.rapports.length > 0;
  }

  // ------------------------------------------------------------------ journal
  const ACTIONS = {
    'compte.creer': 'Compte créé', 'compte.ouvrir': 'Compte ouvert par e-mail', 'compte.supprimer': 'Compte effacé',
    'compte.admin': 'Droits d\'administration', 'compte.sessions.fermer': 'Sessions fermées', 'compte.motdepasse': 'Mot de passe réinitialisé',
    'compte.export': 'Données du compte exportées', 'compte.cle.ajouter': 'Clé d\'accès ajoutée', 'compte.cle.retirer': 'Clé d\'accès retirée',
    'socle.rattacher': 'Socle rattaché à un compte', 'socle.detacher': 'Socle détaché d\'un compte',
    'appareil.creer': 'Compte d\'appareil créé', 'appareil.renouveler': 'Mot de passe d\'appareil changé', 'appareil.retirer': 'Compte d\'appareil retiré',
    'rapport.envoyer': 'Rapport de diagnostic envoyé', 'rapport.lire': 'Rapport lu', 'rapport.supprimer': 'Rapport supprimé',
    'audit.export': 'Journal exporté', 'audit.rupture': 'Fin du journal coupée (rupture notée)'
  };
  const LIBELLES_DETAILS = { compte: 'compte', admin: 'administrateur', sessions: 'sessions', socles: 'socles', historiquesEffaces: 'historiques effacés',
    motDePasse: 'mot de passe', proprietairesDetaches: 'propriétaires détachés', nom: 'nom', fichier: 'fichier', lignes: 'lignes', raison: 'raison', teteAttendue: 'tête attendue' };
  function texteDetails(d) {
    if (!d) return '';
    return Object.entries(d).map(([k, v]) => `${LIBELLES_DETAILS[k] || k} : ${typeof v === 'boolean' ? (v ? 'oui' : 'non') : v}`).join(' · ');
  }
  function ligneJournal(e) {
    return h('li', { 'data-action': e.action },
      h('time', { datetime: e.t, texte: date(e.t) }),
      h('span', {}, h('span', { class: 'quoi', texte: ACTIONS[e.action] || e.action }),
        e.cible ? [' — ', /^terra[0-9A-Za-z]{6}$/.test(e.cible) ? lienSocle(e.cible) : e.cible] : null,
        h('span', { class: 'discret', texte: ` · par ${quiAffiche(e.qui)}` })),
      e.details ? h('span', { class: 'detail', texte: texteDetails(e.details) }) : null);
  }

  function paramsJournal() {
    const q = $('#f-journal').value.trim();
    if (/^terra[0-9A-Za-z]{6}$/.test(q)) return `cible=${encodeURIComponent(q)}`;
    if (q) return `compte=${encodeURIComponent(q)}`;
    return '';
  }
  async function chargerJournal() {
    const p = paramsJournal();
    etat.journal = await admin('GET', `/api/admin/audit?limite=300${p ? '&' + p : ''}`);
    vueJournal();
  }
  function vueJournal() {
    const j = etat.journal, v = j.verification;
    const b = $('#etat-chaine');
    b.classList.toggle('ko', !v.ok);
    remplir(b, v.ok
      ? `Chaîne intègre : ${nombre(v.n)} ligne${v.n > 1 ? 's' : ''}${v.premier ? `, du ${date(v.premier)} au ${date(v.dernier)}` : ''}. Tête : ${String(v.tete || '').slice(0, 16)}…`
      : `Rupture : ${v.rupture.raison}${v.rupture.fichier ? ` (${v.rupture.fichier}, ligne ${v.rupture.ligne})` : ''}.`);
    remplir($('#liste-journal'), j.entrees.map(ligneJournal));
    $('#journal-vide').hidden = j.entrees.length > 0;
  }

  // ------------------------------------------------------------------ fiches
  const section = (titre, ...contenu) => h('section', {}, h('h3', { texte: titre }), ...contenu);
  const stat = paires => h('div', { class: 'stat' }, paires.filter(Boolean).map(([l, v]) => h('div', {}, h('b', { texte: v }), h('span', { texte: l }))));
  function ouvrirFiche(titre) {
    remplir($('#fiche-titre'), titre);
    const d = $('#fiche');
    if (!d.open) d.showModal();
    return vider($('#fiche-corps'));
  }

  // Courbe des 24 dernières heures (deux zones), dessinée en SVG.
  function courbe(points) {
    const L = 600, H = 120, m = 4;
    const svg = s('svg', { class: 'courbe-24h', viewBox: `0 0 ${L} ${H}`, preserveAspectRatio: 'none', role: 'img' });
    const valeurs = points.flatMap(p => [p[1], p[3]]).filter(v => v !== null && v !== undefined);
    if (points.length < 2 || !valeurs.length) {
      svg.setAttribute('aria-label', 'Pas encore de mesures enregistrées sur 24 heures');
      svg.append(s('text', { x: L / 2, y: H / 2, 'text-anchor': 'middle' }, 'Pas encore de mesures sur 24 h'));
      return svg;
    }
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    let min = Math.min(...valeurs), max = Math.max(...valeurs);
    if (max - min < 100) { min -= 50; max += 50; }
    const x = t => m + (L - 2 * m) * (t - t0) / Math.max(1, t1 - t0);
    const y = v => H - m - (H - 2 * m) * (v - min) / (max - min);
    for (const [i, cls] of [[1, 'z1'], [3, 'z2']]) {
      const pts = points.filter(p => p[i] !== null && p[i] !== undefined).map(p => `${x(p[0]).toFixed(1)},${y(p[i]).toFixed(1)}`);
      if (pts.length > 1) svg.append(s('polyline', { class: cls, points: pts.join(' ') }));
    }
    svg.setAttribute('aria-label', `Températures sur 24 heures, de ${degres(min / 100)} à ${degres(max / 100)}`);
    return svg;
  }

  async function ficheSocle(id, ouvrir = true) {
    const x = await admin('GET', `/api/admin/socles/${id}`);
    const hist = await admin('GET', `/api/admin/socles/${id}/historique?pas=300`).catch(() => null);
    etat.fiche = { type: 'socle', id };
    if (!ouvrir && !$('#fiche').open) return;
    const corps = ouvrirFiche(id);
    const sa = x.sante || {};
    corps.append(
      badgesSocle(x),
      stat([
        ['vu', depuis(x.vu)],
        ['firmware', sa.version || '—'],
        ['protocole', sa.proto ? String(sa.proto) : '—'],
        ['en marche depuis', duree(sa.uptime)],
        ['signal Wi-Fi', sa.rssi !== undefined ? `${sa.rssi} dBm` : '—'],
        ['mémoire libre (mini)', sa.heap ? `${Math.round(sa.heap / 1024)} Ko (${Math.round((sa.heapMin || 0) / 1024)})` : '—'],
        ['dernier redémarrage', sa.reset || '—'],
        ['adresse locale', sa.ip || '—'],
        sa.webProtege !== undefined ? ['page locale', sa.webProtege ? 'protégée' : 'sans mot de passe'] : null,
        sa.signatureOta !== undefined ? ['mises à jour', sa.signatureOta ? 'signées exigées' : 'signature non exigée'] : null
      ]),
      section('Zones', x.etatsZones.length ? h('ul', { class: 'liste-actions' }, x.etatsZones.map(z => h('li', {},
        h('span', {}, h('b', { texte: z.nom || `Zone ${z.zone}` }), ` — ${degres(z.temp)} pour ${degres(z.consigne)}`,
          h('span', { class: 'discret', texte: `demande ${z.demande !== undefined ? z.demande + ' %' : '—'} · ${z.chauffe === '1' || z.chauffe === 1 ? 'chauffe' : 'au repos'}` })),
        z.defaut && z.defaut !== '0' && z.defaut !== 0 ? badge(z.defaut_libelle || 'défaut', 'ko') : badge('normal', 'ok')))) : h('p', { class: 'aide', texte: 'Aucun état de zone reçu depuis le démarrage du serveur.' })),
      section('Dernières 24 heures', courbe(hist ? hist.points : []), h('p', { class: 'legende-courbe' }, h('span', { texte: 'zone 1' }), h('span', { texte: 'zone 2' }))),
      section('Propriétaires',
        x.proprietairesDetail.length ? h('ul', { class: 'liste-actions' }, x.proprietairesDetail.map(p => h('li', {},
          h('span', {}, lienCompte(p.login), h('span', { class: 'discret', texte: p.type === 'email' ? 'compte par e-mail' : 'compte à mot de passe' })),
          h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'detacher', 'data-socle': id, 'data-login': p.login, texte: 'Détacher' }))))
          : h('p', { class: 'aide', texte: 'Aucun : le socle n\'est rattaché à aucun compte.' }),
        h('form', { class: 'ligne-ajout', 'data-form': 'rattacher', 'data-socle': id, novalidate: true },
          h('label', { class: 'sr-only', for: 'rattacher-login', texte: 'Compte à rattacher' }),
          h('input', { id: 'rattacher-login', placeholder: 'identifiant ou e-mail du compte', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
          h('button', { type: 'submit', class: 'btn btn-secondaire btn-petit', texte: 'Rattacher' }))),
      section('Compte d\'appareil (MQTT)', x.appareil
        ? h('div', {}, h('p', { class: 'aide', texte: `Créé le ${date(x.appareil.cree)}${x.appareil.renouvele ? `, mot de passe changé le ${date(x.appareil.renouvele)}` : ''}.` }),
          h('div', { class: 'boutons' },
            h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'renouveler-appareil', 'data-id': id, texte: 'Changer le mot de passe' }),
            h('button', { type: 'button', class: 'btn btn-danger btn-petit', 'data-action': 'retirer-appareil', 'data-id': id, texte: 'Retirer' })))
        : h('div', {}, h('p', { class: 'aide', texte: 'Aucun : ce socle se connecte ailleurs (broker amont) ou n\'a pas encore été monté.' }),
          h('div', { class: 'boutons' }, h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'creer-appareil', 'data-id': id, texte: 'Créer le compte d\'appareil' })))),
      h('p', { class: 'aide', texte: 'Diagnostics et réglages à distance : ils demandent l\'accès support, ouvert par le propriétaire depuis son application.' }),
      x.sante ? h('details', {}, h('summary', { texte: 'Santé publiée par le socle (JSON)' }), h('pre', { class: 'bloc-texte json-sante', texte: JSON.stringify(x.sante, null, 1) })) : null,
      section('Journal', x.journal.length ? h('ol', { class: 'journal-console' }, x.journal.map(ligneJournal)) : h('p', { class: 'aide', texte: 'Rien au journal pour ce socle.' })));
  }

  async function ficheCompte(login, ouvrir = true) {
    const x = await admin('GET', `/api/admin/utilisateurs/${encodeURIComponent(login)}`);
    etat.fiche = { type: 'compte', id: x.login };
    if (!ouvrir && !$('#fiche').open) return;
    const moiMeme = etat.session && etat.session.type === 'compte' && etat.session.qui.toLowerCase() === x.login.toLowerCase();
    const corps = ouvrirFiche(pii(x.login));
    corps.append(
      h('span', { class: 'badges' }, badge(x.type === 'email' ? 'compte par e-mail' : 'compte à mot de passe', 'neutre'), x.admin ? badge('administrateur', 'warn') : null, moiMeme ? badge('vous', 'ok') : null),
      stat([['créé', date(x.cree)], ['dernière connexion', depuis(x.derniereConnexion)], ['sessions ouvertes', nombre(x.sessions)],
        ['clés d\'accès', nombre(x.cles)], ['téléphones notifiés', nombre(x.notificationsPush.length)], ['référence au journal', x.reference]]),
      section('Socles',
        x.soclesDetail.length ? h('ul', { class: 'liste-actions' }, x.soclesDetail.map(sx => h('li', {},
          h('span', {}, lienSocle(sx.id), ' ', badgesSocle(sx)),
          h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'detacher', 'data-socle': sx.id, 'data-login': x.login, texte: 'Détacher' }))))
          : h('p', { class: 'aide', texte: 'Aucun socle rattaché.' }),
        h('form', { class: 'ligne-ajout', 'data-form': 'rattacher-socle', 'data-login': x.login, novalidate: true },
          h('label', { class: 'sr-only', for: 'rattacher-socle', texte: 'Socle à rattacher' }),
          h('input', { id: 'rattacher-socle', placeholder: 'terraA1B2C3', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '11' }),
          h('button', { type: 'submit', class: 'btn btn-secondaire btn-petit', texte: 'Rattacher' }))),
      section('Clés d\'accès', x.clesAcces.length ? h('ul', { class: 'liste-actions' }, x.clesAcces.map(c => h('li', {},
        h('span', {}, c.nom, h('span', { class: 'discret', texte: `créée ${depuis(c.cree)} · utilisée ${depuis(c.vu)}${c.synchronisee ? ' · synchronisée' : ''}` })),
        h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'retirer-cle', 'data-login': x.login, 'data-cle': c.id, 'data-nom': c.nom, texte: 'Retirer' }))))
        : h('p', { class: 'aide', texte: 'Aucune clé d\'accès.' })),
      section('Sessions', x.sessionsOuvertes.length ? h('ul', { class: 'liste-actions' }, x.sessionsOuvertes.map(se => h('li', {},
        h('span', {}, se.appareil || 'appareil inconnu', h('span', { class: 'discret', texte: `ouverte ${depuis(se.ouverte)} · expire le ${date(se.expire)}` })))))
        : h('p', { class: 'aide', texte: 'Aucune session ouverte.' }),
      x.sessionsOuvertes.length ? h('div', { class: 'boutons' }, h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'fermer-sessions', 'data-login': x.login, texte: moiMeme ? 'Fermer toutes mes sessions (dont celle-ci)' : 'Déconnecter partout' })) : null),
      section('Actions', h('div', { class: 'boutons' },
        moiMeme && x.admin ? null : h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'basculer-admin', 'data-login': x.login, 'data-admin': x.admin ? '0' : '1',
          texte: x.admin ? 'Retirer les droits d\'administration' : 'Donner les droits d\'administration' }),
        x.type === 'motdepasse' ? h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'reinitialiser', 'data-login': x.login, texte: 'Réinitialiser le mot de passe' }) : null,
        h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'exporter-compte', 'data-login': x.login, texte: 'Exporter ses données (RGPD)' }),
        moiMeme ? null : h('button', { type: 'button', class: 'btn btn-danger btn-petit', 'data-action': 'supprimer-compte', 'data-login': x.login, texte: 'Effacer le compte' }))),
      section('Journal', x.journal.length ? h('ol', { class: 'journal-console' }, x.journal.map(ligneJournal)) : h('p', { class: 'aide', texte: 'Rien au journal pour ce compte.' })));
  }

  // ------------------------------------------------------------------ confirmation, secret
  // Une confirmation, avec ou sans référence à taper.
  function confirmer({ titre, texte, reference = null, bouton }) {
    return new Promise(resoudre => {
      const d = $('#confirmer'), saisie = $('#confirmer-saisie'), ok = $('#confirmer-ok');
      remplir($('#confirmer-titre'), titre);
      remplir($('#confirmer-texte'), texte);
      remplir(ok, bouton);
      saisie.value = '';
      $('#confirmer-label').hidden = saisie.hidden = !reference;
      remplir($('#confirmer-label'), reference ? `Pour confirmer, taper « ${reference} »` : '');
      const juste = () => !reference || saisie.value.trim().toLowerCase() === reference.toLowerCase();
      ok.disabled = !juste();
      const surSaisie = () => { ok.disabled = !juste(); };
      const fin = r => { saisie.removeEventListener('input', surSaisie); d.removeEventListener('close', surFermeture); $('#form-confirmer').onsubmit = null; $('[data-action="annuler-confirmation"]').onclick = null; if (d.open) d.close(); resoudre(r); };
      const surFermeture = () => fin(false);
      saisie.addEventListener('input', surSaisie);
      d.addEventListener('close', surFermeture);
      $('#form-confirmer').onsubmit = e => { e.preventDefault(); if (juste()) fin(true); };
      $('[data-action="annuler-confirmation"]').onclick = () => fin(false);
      d.showModal();
      (reference ? saisie : ok).focus();
    });
  }

  function montrerSecret({ titre, aide, valeur }) {
    return new Promise(resoudre => {
      const d = $('#secret');
      remplir($('#secret-titre'), titre);
      remplir($('#secret-aide'), aide);
      remplir($('#secret-valeur'), valeur);
      const fin = () => { d.removeEventListener('close', fin); vider($('#secret-valeur')); resoudre(undefined); };
      d.addEventListener('close', fin);
      d.showModal();
    });
  }

  function commandeAppareil(r) {
    const tcp = etat.infos && etat.infos.mqtt ? etat.infos.mqtt.tcp : 1883;
    return `mqtt ${location.hostname} ${tcp || 1883} ${r.id} ${r.motDePasse}`;
  }

  // ------------------------------------------------------------------ actions
  async function actualiser() {
    await charger(etat.onglet);
    if (etat.fiche && $('#fiche').open) await (etat.fiche.type === 'socle' ? ficheSocle : ficheCompte)(etat.fiche.id, false);
  }

  const actions = {
    async 'renouveler-appareil'(el) {
      const id = el.dataset.id;
      if (!await confirmer({ titre: `Changer le mot de passe de ${id} ?`, texte: 'L\'ancien cesse aussitôt de valoir : le socle se déconnecte jusqu\'à ce qu\'il reçoive le nouveau par sa console série (USB).', bouton: 'Changer' })) return;
      const r = await admin('POST', `/api/admin/appareils/${id}/renouveler`);
      await montrerSecret({ titre: `Nouveau mot de passe de ${id}`, aide: 'À donner au socle par sa console série. Il ne sera plus affiché.', valeur: `${r.motDePasse}\n\nSur la console du socle :\n${commandeAppareil(r)}` });
      await actualiser();
    },
    async 'retirer-appareil'(el) {
      const id = el.dataset.id;
      if (!await confirmer({ titre: `Retirer le compte d'appareil de ${id} ?`, texte: 'Le socle ne pourra plus se connecter à ce serveur, et il est détaché de tous ses propriétaires.', reference: id, bouton: 'Retirer' })) return;
      await admin('DELETE', `/api/admin/appareils/${id}`, { confirmation: id });
      message(`Compte d'appareil ${id} retiré.`);
      await actualiser();
    },
    async 'creer-appareil'(el) { await creerAppareil(el.dataset.id); },
    async 'detacher'(el) {
      const id = el.dataset.socle, login = el.dataset.login;
      if (!await confirmer({ titre: `Détacher ${id} ?`, texte: `Le compte ${pii(login)} ne verra plus ce socle.`, bouton: 'Détacher' })) return;
      await admin('DELETE', `/api/admin/socles/${id}/proprietaires/${encodeURIComponent(login)}`);
      message(`${id} détaché.`);
      await actualiser();
    },
    async 'retirer-cle'(el) {
      if (!await confirmer({ titre: 'Retirer cette clé d\'accès ?', texte: `« ${el.dataset.nom} » ne permettra plus de se connecter (téléphone perdu, par exemple).`, bouton: 'Retirer' })) return;
      await admin('DELETE', `/api/admin/utilisateurs/${encodeURIComponent(el.dataset.login)}/cles/${el.dataset.cle}`);
      message('Clé d\'accès retirée.');
      await actualiser();
    },
    async 'fermer-sessions'(el) {
      const login = el.dataset.login;
      if (!await confirmer({ titre: 'Fermer toutes les sessions ?', texte: 'Le compte devra se reconnecter sur chacun de ses appareils.', bouton: 'Fermer les sessions' })) return;
      const r = await admin('POST', `/api/admin/utilisateurs/${encodeURIComponent(login)}/sessions/fermer`);
      message(`${r.fermees} session(s) fermée(s).`);
      if (etat.session && etat.session.type === 'compte' && etat.session.qui.toLowerCase() === login.toLowerCase()) { sortir('Vos sessions ont été fermées.'); return; }
      await actualiser();
    },
    async 'basculer-admin'(el) {
      const donner = el.dataset.admin === '1', login = el.dataset.login;
      if (!await confirmer({ titre: donner ? 'Donner les droits d\'administration ?' : 'Retirer les droits d\'administration ?',
        texte: donner ? `${pii(login)} pourra ouvrir cette console et tout y faire.` : `${pii(login)} n'aura plus accès à cette console.`, bouton: donner ? 'Donner les droits' : 'Retirer les droits' })) return;
      await admin('POST', `/api/admin/utilisateurs/${encodeURIComponent(login)}/admin`, { admin: donner });
      message(donner ? 'Droits donnés.' : 'Droits retirés.');
      await actualiser();
    },
    async 'reinitialiser'(el) {
      const login = el.dataset.login;
      if (!await confirmer({ titre: 'Réinitialiser le mot de passe ?', texte: 'Un nouveau mot de passe est tiré ; l\'ancien et toutes les sessions tombent.', bouton: 'Réinitialiser' })) return;
      const r = await admin('POST', `/api/admin/utilisateurs/${encodeURIComponent(login)}/mot-de-passe`);
      await montrerSecret({ titre: 'Nouveau mot de passe', aide: `Pour ${pii(login)}. À lui transmettre par un canal sûr ; il ne sera plus affiché.`, valeur: r.motDePasse });
      await actualiser();
    },
    async 'exporter-compte'(el) {
      const d = await admin('GET', `/api/admin/utilisateurs/${encodeURIComponent(el.dataset.login)}/export`);
      telecharger('terrariums-compte.json', JSON.stringify(d, null, 2), 'application/json');
      message('Export téléchargé (noté au journal).');
    },
    async 'supprimer-compte'(el) {
      const login = el.dataset.login;
      if (!await confirmer({ titre: 'Effacer ce compte ?', texte: 'Le compte, ses sessions, ses clés d\'accès et ses notifications disparaissent, ainsi que l\'historique des socles qui n\'ont plus aucun propriétaire. C\'est définitif.', reference: login, bouton: 'Effacer définitivement' })) return;
      const r = await admin('DELETE', `/api/admin/utilisateurs/${encodeURIComponent(login)}`, { confirmation: login });
      $('#fiche').close();
      message(`Compte effacé${r.historiquesEffaces ? ` (${r.historiquesEffaces} historique(s) de socle effacé(s))` : ''}.`);
      await charger(etat.onglet);
    },
    async 'lire-rapport'(el) {
      const nom = el.dataset.nom;
      const r = await admin('GET', `/api/admin/rapports/${encodeURIComponent(nom)}`, undefined, { brut: true });
      const texte = await r.text();
      etat.lecture = { nom, texte };
      const x = etat.rapports.find(y => y.nom === nom);
      remplir($('#lecture-titre'), `Rapport du ${x ? date(x.date) : nom}`);
      remplir($('#lecture-texte'), texte);
      $('#lecture').showModal();
    },
    async 'telecharger-lecture'() { if (etat.lecture) telecharger(etat.lecture.nom, etat.lecture.texte, 'text/plain'); },
    async 'supprimer-lecture'() {
      const l = etat.lecture;
      if (!l) return;
      if (!await confirmer({ titre: 'Supprimer ce rapport ?', texte: 'Il disparaît du serveur.', bouton: 'Supprimer' })) return;
      await admin('DELETE', `/api/admin/rapports/${encodeURIComponent(l.nom)}`);
      $('#lecture').close();
      message('Rapport supprimé.');
      await charger('rapports');
    },
    async 'fermer-lecture'() { $('#lecture').close(); },
    async 'fermer-fiche'() { $('#fiche').close(); },
    async 'exporter-journal'() {
      const p = paramsJournal();
      const r = await admin('GET', `/api/admin/audit/export${p ? '?' + p : ''}`, undefined, { brut: true });
      telecharger('terrariums-audit.ndjson', await r.text(), 'application/x-ndjson');
      message('Journal exporté.');
      await chargerJournal();
    },
    async 'copier-secret'() {
      try { await navigator.clipboard.writeText($('#secret-valeur').textContent.split('\n')[0]); message('Copié.'); }
      catch (e) { message('Copie refusée par le navigateur : sélectionner le texte.', true); }
    },
    async 'fermer-secret'() { $('#secret').close(); },
    async 'nouveau-compte'() { basculerFormulaire('#form-nouveau-compte', '[data-action="nouveau-compte"]', '#n-login'); },
    async 'nouvel-appareil'() { basculerFormulaire('#form-nouvel-appareil', '[data-action="nouvel-appareil"]', '#n-appareil'); },
    async 'annuler-code'() { $('#form-code').hidden = true; $('#form-compte').hidden = false; erreurConnexion(''); $('#c-login').focus(); }
  };

  function basculerFormulaire(sel, boutons, champ) {
    const f = $(sel);
    f.hidden = !f.hidden;
    for (const b of $$(boutons)) if (b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', String(!f.hidden));
    if (!f.hidden) $(champ).focus();
  }

  async function creerAppareil(id) {
    const r = await admin('POST', '/api/admin/appareils', { id });
    await montrerSecret({ titre: `Compte d'appareil ${r.id}`, aide: 'Le mot de passe MQTT du socle, à lui donner par sa console série (USB). Il ne sera plus affiché.', valeur: `${r.motDePasse}\n\nSur la console du socle :\n${commandeAppareil(r)}` });
    await actualiser();
  }

  // ------------------------------------------------------------------ événements
  document.addEventListener('click', e => {
    const el = /** @type {HTMLButtonElement} */ (/** @type {HTMLElement} */ (e.target).closest('button, [data-aller]'));
    if (!el) return;
    if (el.dataset.mode) { mode(el.dataset.mode); return; }
    if (el.dataset.onglet) { onglet(el.dataset.onglet); return; }
    if (el.dataset.aller) {
      const [o, f] = el.dataset.aller.split(':');
      if (f) { etat.filtres[o] = f; for (const b of $$(`[data-filtres="${o}"] [data-filtre]`)) b.setAttribute('aria-pressed', String(b.dataset.filtre === f)); }
      onglet(o);
      return;
    }
    if (el.dataset.filtre) {
      const groupe = /** @type {HTMLElement} */ (el.closest('[data-filtres]')).dataset.filtres;
      etat.filtres[groupe] = el.dataset.filtre;
      for (const b of el.parentElement.querySelectorAll('[data-filtre]')) b.setAttribute('aria-pressed', String(b === el));
      (groupe === 'socles' ? vueSocles : vueComptes)();
      return;
    }
    if (el.dataset.socle && el.classList.contains('lien')) { ficheSocle(el.dataset.socle).catch(echec); return; }
    if (el.dataset.compte) { ficheCompte(el.dataset.compte).catch(echec); return; }
    const a = el.dataset.action && actions[el.dataset.action];
    if (a) {
      el.disabled = true;
      Promise.resolve(a(el)).catch(echec).finally(() => { if (el.isConnected) el.disabled = false; });
    }
  });

  document.addEventListener('submit', e => {
    const f = /** @type {HTMLFormElement} */ (e.target);
    if (f.id === 'form-confirmer') return;          // géré par confirmer()
    e.preventDefault();
    if (f.id === 'form-compte') connexionCompte();
    else if (f.id === 'form-code') connexionCode();
    else if (f.id === 'form-jeton') connexionJeton();
    else if (f.id === 'form-nouveau-compte') {
      const login = $('#n-login').value.trim(), mdp = $('#n-mdp').value, adm = $('#n-admin').checked;
      admin('POST', '/api/admin/utilisateurs', { login, motDePasse: mdp || undefined, admin: adm }).then(async r => {
        $('#n-login').value = ''; $('#n-mdp').value = ''; $('#n-admin').checked = false;
        basculerFormulaire('#form-nouveau-compte', '[data-action="nouveau-compte"]', '#n-login');
        if (r.motDePasse) await montrerSecret({ titre: `Compte ${pii(r.login)} créé`, aide: 'Mot de passe tiré au hasard, à transmettre par un canal sûr. Il ne sera plus affiché.', valeur: r.motDePasse });
        else message(`Compte ${pii(r.login)} créé.`);
        await charger('comptes');
      }).catch(echec);
    } else if (f.id === 'form-nouvel-appareil') {
      const id = $('#n-appareil').value.trim();
      if (!/^terra[0-9A-Za-z]{6}$/.test(id)) { message('Identifiant attendu : terra suivi de 6 caractères (terraA1B2C3).', true); return; }
      creerAppareil(id).then(() => { $('#n-appareil').value = ''; basculerFormulaire('#form-nouvel-appareil', '[data-action="nouvel-appareil"]', '#n-appareil'); }).catch(echec);
    } else if (f.dataset.form === 'rattacher') {
      const login = f.querySelector('input').value.trim();
      if (!login) return;
      admin('POST', `/api/admin/socles/${f.dataset.socle}/proprietaires`, { login }).then(() => { message('Socle rattaché.'); return actualiser(); }).catch(echec);
    } else if (f.dataset.form === 'rattacher-socle') {
      const id = f.querySelector('input').value.trim();
      if (!/^terra[0-9A-Za-z]{6}$/.test(id)) { message('Identifiant attendu : terraA1B2C3.', true); return; }
      admin('POST', `/api/admin/utilisateurs/${encodeURIComponent(f.dataset.login)}/socles`, { id }).then(() => { message('Socle rattaché.'); return actualiser(); }).catch(echec);
    }
  });

  let minuteurRecherche = null;
  document.addEventListener('input', e => {
    const id = /** @type {HTMLElement} */ (e.target).id;
    if (id === 'f-socles') vueSocles();
    else if (id === 'f-comptes') vueComptes();
    else if (id === 'f-journal') { clearTimeout(minuteurRecherche); minuteurRecherche = setTimeout(() => chargerJournal().catch(echec), 300); }
  });

  $('#btn-sortir').addEventListener('click', () => sortir());
  $('#btn-donnees').addEventListener('click', () => {
    etat.donneesVisibles = !etat.donneesVisibles;
    $('#btn-donnees').setAttribute('aria-pressed', String(etat.donneesVisibles));
    remplir($('#btn-donnees'), etat.donneesVisibles ? 'Masquer les données personnelles' : 'Afficher les données personnelles');
    rerendre();
  });
  $('#fiche').addEventListener('close', () => { etat.fiche = null; });
  $('#lecture').addEventListener('close', () => { etat.lecture = null; vider($('#lecture-texte')); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && etat.session) charger(etat.onglet).catch(() => {}); });

  // ------------------------------------------------------------------ démarrage
  (async function demarrer() {
    if (typeof window.PublicKeyCredential === 'function' && navigator.credentials) $('#btn-cle').hidden = false;
    $('#btn-cle').addEventListener('click', connexionCle);
    try { etat.infos = await requete('GET', '/api/infos'); } catch (e) { /* le serveur répondra peut-être à la connexion */ }
    if (etat.infos && etat.infos.comptes && !etat.infos.comptes.email) remplir($('#c-mdp-aide'), 'Ce serveur n\'envoie pas d\'e-mail : identifiant et mot de passe, clé d\'accès ou jeton.');
    let s_;
    try { s_ = JSON.parse(sessionStorage.getItem(CLE) || 'null'); } catch (e) { s_ = null; }
    if (s_ && s_.jeton) {
      try { await ouvrirAvec(s_.jeton, s_.type); return; } catch (e) { try { sessionStorage.removeItem(CLE); } catch (err) { /* rien */ } }
    }
    mode('compte');
  }());

  // Pour les tests de bout en bout.
  /** @type {any} */ (window).ConsoleAdmin = { etat, actualiser, rerendre };
}());
