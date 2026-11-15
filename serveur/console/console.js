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
    filtres: { socles: 'tous', comptes: 'tous', demandes: 'ouvertes' },
    tableau: null, socles: [], comptes: [], appareils: [], rapports: [], journal: null,
    demandes: [], accesOuverts: [], equipe: null, sortie: {},
    reponses: [], variables: {}, // réponses types, et ce que la demande ouverte permet d'y remplir
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
    constructor(message, statut, donnees = null) { super(message); this.statut = statut; this.donnees = donnees; }
  }

  /** @param {string} methode @param {string} chemin @param {any} [corps] @param {{ jeton?: string, brut?: boolean }} [options] */
  async function requete(methode, chemin, corps, options = {}) {
    const { jeton, brut } = options;
    /** @type {Record<string, string>} */
    const entetes = {};
    if (corps !== undefined) entetes['Content-Type'] = 'application/json';
    if (jeton) entetes.Authorization = `Bearer ${jeton}`;
    let r;
    try { r = await fetch(chemin, { method: methode, headers: entetes, body: corps === undefined ? undefined : JSON.stringify(corps), cache: 'no-store' }); }
    catch (e) { throw new ErreurApi('serveur injoignable', 0); }
    if (brut && r.ok) return r;
    let d = null;
    try { d = await r.json(); } catch (e) { /* corps vide ou texte */ }
    if (!r.ok) throw new ErreurApi((d && d.erreur) || `erreur ${r.status}`, r.status, d);
    return d;
  }

  // Appel administrateur : une session refusée ramène à la connexion.
  async function admin(methode, chemin, corps, options = {}) {
    if (!etat.session) throw new ErreurApi('session requise', 401);
    try { return await requete(methode, chemin, corps, { ...options, jeton: etat.session.jeton }); }
    catch (e) {
      // Un refus de rôle (« réservé aux administrateurs ») n'est pas une session perdue.
      if (e.statut === 401 || (e.statut === 403 && !(e.donnees && e.donnees.droits))) {
        sortir(e.statut === 403 ? 'Accès refusé : session expirée ou droits retirés.' : 'Session expirée.');
      }
      throw e;
    }
  }
  const echec = e => { if (e && (e.statut !== 401 && (e.statut !== 403 || (e.donnees && e.donnees.droits)))) message(e.message || String(e), true); };

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

  // Le serveur dit si le compte a accès (administrateur ou support) ; sinon la
  // session ouverte pour l'essai est refermée aussitôt.
  async function sessionCompte(r) {
    try { await ouvrirAvec(r.jeton, 'compte'); }
    catch (e) {
      await requete('DELETE', '/api/session', undefined, { jeton: r.jeton }).catch(() => {});
      if (e.statut === 403) throw new ErreurApi('ce compte n\'a pas accès à la console (ni administrateur, ni support)', 403);
      throw e;
    }
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

  const ONGLETS_ADMIN = ['comptes', 'appareils'];
  const estSupport = () => !!(etat.moi && etat.moi.role === 'support');
  function entrer() {
    // Rôle « support » : ni comptes, ni comptes d'appareil.
    document.body.dataset.role = estSupport() ? 'support' : 'admin';
    for (const b of $$('.rubriques-console [data-onglet]')) b.hidden = estSupport() && ONGLETS_ADMIN.includes(b.dataset.onglet);
    if (estSupport() && ONGLETS_ADMIN.includes(etat.onglet)) etat.onglet = 'support';
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
    etat.demandes = []; etat.accesOuverts = []; etat.equipe = null; etat.sortie = {};
    vider($('#corps-demandes')); vider($('#acces-ouverts'));
    for (const b of $$('.rubriques-console [data-onglet]')) b.hidden = false;
    delete document.body.dataset.role;
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
    else if (nom === 'support') { await chargerSupport(); }
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
          if (['tableau', 'socles', 'support'].includes(etat.onglet)) await charger(etat.onglet);
          if (etat.fiche && etat.fiche.type === 'socle' && $('#fiche').open && !ficheOccupee()) await ficheSocle(etat.fiche.id, false);
        } catch (e) { /* une coupure passagère : on réessaie au tour suivant */ }
      }
      if (etat.session) planifier();
    }, RAFRAICHIR_MS);
  }

  // Une fiche où l'on écrit ne se repeint pas toute seule : rien de tapé ne se perd.
  function ficheOccupee() {
    const f = $('#fiche');
    const actif = document.activeElement;
    if (actif && f.contains(actif) && /^(INPUT|TEXTAREA|SELECT)$/.test(actif.tagName)) return true;
    return [...f.querySelectorAll('input, textarea')].some(x => /** @type {HTMLInputElement} */ (x).value.trim() !== '');
  }

  function rerendre() {
    if (etat.onglet === 'support') vueSupport();
    if (etat.onglet === 'tableau' && etat.tableau) vueTableau();
    else if (etat.onglet === 'socles') vueSocles();
    else if (etat.onglet === 'comptes') vueComptes();
    else if (etat.onglet === 'appareils') vueAppareils();
    else if (etat.onglet === 'rapports') vueRapports();
    else if (etat.onglet === 'journal' && etat.journal) vueJournal();
    if (etat.fiche && $('#fiche').open) rouvrirFiche().catch(echec);
    if (etat.session) remplir($('#etat-serveur'), etat.session.type === 'jeton' ? 'Jeton d\'administration' : pii(etat.session.qui));
  }
  const rouvrirFiche = () => ({ socle: ficheSocle, compte: ficheCompte, demande: ficheDemande })[etat.fiche.type](etat.fiche.id, false);

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
    const sup = t.support || { ouvertes: 0, nouvelles: 0, acces: 0 };
    remplir($('#tuiles'),
      tuile(`${nombre(t.socles.enLigne)} / ${nombre(t.socles.total)}`, 'socles en ligne', 'socles:enligne'),
      tuile(nombre(t.socles.horsLigne), 'hors ligne', 'socles:horsligne', t.socles.horsLigne ? 'warn' : null),
      tuile(nombre(t.socles.enDefaut), 'en défaut', 'socles:defaut', t.socles.enDefaut ? 'ko' : null),
      tuile(nombre(sup.ouvertes), `demandes ouvertes (${nombre(sup.nouvelles)} nouvelle${sup.nouvelles > 1 ? 's' : ''})`, 'support:ouvertes', sup.nouvelles ? 'warn' : null),
      tuile(nombre(sup.acces), 'accès support ouverts', 'support:ouvertes'),
      sup.relancesDues ? tuile(nombre(sup.relancesDues), `relance${sup.relancesDues > 1 ? 's' : ''} à faire`, 'support:toutes', 'warn') : null,
      tuile(nombre(t.socles.sansProprietaire), 'sans propriétaire', 'socles:orphelin'),
      estSupport() ? null : tuile(nombre(t.comptes.total), `comptes (${nombre(t.comptes.email)} par e-mail)`, 'comptes:tous'),
      tuile(nombre(t.rapports.semaine), 'rapports sur 7 jours', 'rapports'),
      tuile(t.audit.ok ? nombre(t.audit.n) : 'rupture', t.audit.ok ? 'lignes au journal, chaîne intègre' : 'journal d\'audit', 'journal', t.audit.ok ? null : 'ko'));

    // À regarder : les alertes proactives du serveur, de la plus grave à la plus douce,
    // chacune avec sa demande au support (ou de quoi en ouvrir une).
    const items = (t.alertes || []).map(a => h('li', { class: 'alerte-proactive' },
      h('span', {}, badge(a.gravite, a.gravite === 'urgente' ? 'ko' : a.gravite === 'normale' ? 'warn' : 'neutre'), ' ', lienSocle(a.socle), ` — ${a.texte}`),
      h('span', {}, a.depuis ? depuis(a.depuis) + ' ' : '',
        a.demande ? h('button', { type: 'button', class: 'lien', 'data-demande': a.demande, texte: `demande n°${a.demande}` })
          : a.proprietaires ? h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'ouvrir-demande', 'data-socle': a.socle, 'data-gravite': a.gravite, 'data-texte': a.texte, texte: 'Ouvrir une demande' }) : null)));
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
      h('td', {}, x.admin ? badge('administrateur', 'warn') : x.support ? badge('support', 'warn') : h('span', { class: 'discret', texte: 'propriétaire' })),
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

  // ------------------------------------------------------------------ support
  const tonGravite = g => g === 'urgente' ? 'ko' : g === 'normale' ? 'warn' : 'neutre';
  const tonStatut = st => st === 'nouvelle' ? 'warn' : st === 'résolue' ? 'ok' : 'neutre';
  async function chargerSupport() {
    const f = etat.filtres.demandes;
    const [d, acc] = await Promise.all([
      admin('GET', `/api/admin/support/demandes${f === 'toutes' ? '' : `?statut=${encodeURIComponent(f)}`}`),
      admin('GET', '/api/admin/support/acces')]);
    etat.demandes = d.demandes;
    etat.accesOuverts = acc.acces;
    vueSupport();
  }
  async function chargerReponses() {
    const r = await admin('GET', '/api/admin/support/reponses');
    etat.reponses = r.reponses;
    remplir($('#rt-variables'), r.variables.map((v, i) => [i ? ', ' : '', h('code', { texte: `{${v}}` })]));
    remplir($('#liste-reponses'), etat.reponses.length ? [...etat.reponses].sort((x, y) => (y.usages || 0) - (x.usages || 0)).map(x => h('li', {},
      h('span', {}, h('b', { texte: x.titre }), h('span', { class: 'discret', texte: ` · utilisée ${x.usages || 0} fois` }),
        h('span', { class: 'texte-message extrait-reponse', texte: x.texte })),
      h('span', { class: 'boutons' },
        h('button', { type: 'button', class: 'btn btn-fantome btn-petit', 'data-action': 'reponse-editer', 'data-id': x.id, texte: 'Modifier' }),
        h('button', { type: 'button', class: 'btn btn-fantome btn-petit', 'data-action': 'reponse-supprimer', 'data-id': x.id, texte: 'Supprimer' }))))
      : h('li', {}, h('span', { class: 'aide', texte: 'Aucune réponse type.' })));
  }
  function viderFormReponse() {
    /** @type {HTMLInputElement} */ ($('#rt-id')).value = '';
    /** @type {HTMLInputElement} */ ($('#rt-titre')).value = '';
    /** @type {HTMLTextAreaElement} */ ($('#rt-texte')).value = '';
    remplir($('#rt-titre-form'), 'Nouvelle réponse type');
  }

  function vueSupport() {
    remplir($('#acces-ouverts'), etat.accesOuverts.length ? [
      h('h3', { texte: `Accès ouverts par les propriétaires (${etat.accesOuverts.length})` }),
      h('ul', { class: 'liste-actions' }, etat.accesOuverts.map(x => h('li', {},
        h('span', {}, lienSocle(x.id), ' ', x.enLigne ? badge('en ligne', 'ok') : badge('hors ligne', 'warn'),
          h('span', { class: 'discret', texte: `jusqu'au ${date(x.jusqua)}${x.prolonge ? ' (prolongé)' : ''} · ${x.proprietaires.map(pii).join(', ') || 'sans propriétaire'}` })),
        (() => { const dm = etat.demandes.find(y => y.socle === x.id && y.statut !== 'résolue'); return dm
          ? h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-demande': dm.n, texte: `Demande n°${dm.n}` })
          : h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'ouvrir-demande', 'data-socle': x.id, 'data-gravite': 'normale', 'data-texte': '', texte: 'Ouvrir une demande' }); })())))] : []);
    remplir($('#corps-demandes'), etat.demandes.map(d => h('tr', {},
      h('th', { scope: 'row' }, h('button', { type: 'button', class: 'lien', 'data-demande': d.n, texte: `n°${d.n}` })),
      h('td', {}, badge(d.gravite, tonGravite(d.gravite))),
      h('td', {}, badge(d.statut, tonStatut(d.statut)), d.demandeAcces ? [' ', badge('accès demandé', 'neutre')] : null, d.acces && d.acces.actif ? [' ', badge('accès ouvert', 'ok')] : null,
        d.relance ? [' ', d.relance.due ? badge('relance à faire', 'warn') : badge(`relance ${date(d.relance.quand)}`, 'neutre')] : null),
      h('td', {}, d.socle ? lienSocle(d.socle) : '—'),
      h('td', {}, d.compte ? pii(d.compte) : '—'),
      h('td', {}, d.responsable ? pii(d.responsable) : h('span', { class: 'discret', texte: 'personne' })),
      h('td', { class: 'num' }, depuis(d.cree)),
      h('td', { class: 'extrait' }, d.dernier ? [h('span', { class: 'discret', texte: d.dernier.de === 'client' ? 'client : ' : 'support : ' }), d.dernier.extrait] : '—'))));
    $('#demandes-vide').hidden = etat.demandes.length > 0;
  }

  // La frise d'un socle : socle, client, support, serveur, du plus récent au plus ancien.
  function frise(elements) {
    if (!elements.length) return h('p', { class: 'aide', texte: 'Rien encore sur la frise de ce socle.' });
    const ton = { socle: 'neutre', client: 'ok', support: 'warn', serveur: 'neutre' };
    return h('ol', { class: 'journal-console frise' }, elements.map(e => h('li', { 'data-source': e.source },
      h('time', { datetime: e.t, texte: date(e.t) }),
      h('span', {}, badge(e.source, ton[e.source] || 'neutre'), ' ',
        h('span', { class: 'quoi', texte: e.source === 'socle' || e.type === 'message' ? (EVENEMENTS[e.type] || e.type) : (ACTIONS[e.type] || e.type) }),
        e.qui && e.source === 'support' ? h('span', { class: 'discret', texte: ` · ${quiAffiche(e.qui)}` }) : null),
      e.details ? h('span', { class: 'detail', texte: e.type === 'message' ? `demande n°${e.details.demande} : ${e.details.extrait}`
        : texteDetails(Object.fromEntries(Object.entries(e.details).filter(([k]) => !['t', 'type'].includes(k)))) }) : null)));
  }

  // ------------------------------------------------------------------ journal
  const ACTIONS = {
    'compte.creer': 'Compte créé', 'compte.ouvrir': 'Compte ouvert par e-mail', 'compte.supprimer': 'Compte effacé',
    'compte.admin': 'Droits d\'administration', 'compte.sessions.fermer': 'Sessions fermées', 'compte.motdepasse': 'Mot de passe réinitialisé',
    'compte.export': 'Données du compte exportées', 'compte.cle.ajouter': 'Clé d\'accès ajoutée', 'compte.cle.retirer': 'Clé d\'accès retirée',
    'socle.rattacher': 'Socle rattaché à un compte', 'socle.detacher': 'Socle détaché d\'un compte',
    'appareil.creer': 'Compte d\'appareil créé', 'appareil.renouveler': 'Mot de passe d\'appareil changé', 'appareil.retirer': 'Compte d\'appareil retiré',
    'rapport.envoyer': 'Rapport de diagnostic envoyé', 'rapport.lire': 'Rapport lu', 'rapport.supprimer': 'Rapport supprimé',
    'audit.export': 'Journal exporté', 'audit.rupture': 'Fin du journal coupée (rupture notée)',
    'compte.support': 'Rôle support', 'compte.carnet': 'Carnet par e-mail',
    'socle.partage.inviter': 'Invitation à partager un socle', 'socle.partage.accepter': 'Partage accepté', 'socle.partage.retirer': 'Partage retiré',
    'support.acces.ouvrir': 'Accès support ouvert par le propriétaire', 'support.acces.prolonger': 'Accès support prolongé',
    'support.acces.fermer': 'Accès support fermé', 'support.acces.echu': 'Accès support échu', 'support.acces.demander': 'Accès demandé au propriétaire',
    'support.acces.refuser': 'Accès refusé par le propriétaire', 'support.commande': 'Commande du support', 'support.copie': 'Copie des réglages',
    'support.remettre': 'Réglages remis comme à l\'ouverture', 'support.transfert': 'Réglages transférés depuis un autre socle',
    'support.demande.creer': 'Demande ouverte', 'support.demande.maj': 'Demande mise à jour', 'support.demande.message': 'Message', 'support.demande.note': 'Note interne',
    'support.reponse.creer': 'Réponse type créée', 'support.reponse.modifier': 'Réponse type modifiée', 'support.reponse.supprimer': 'Réponse type supprimée',
    'support.relance.programmer': 'Relance programmée', 'support.relance.annuler': 'Relance annulée', 'support.relance.envoyee': 'Relance envoyée au client',
    'support.relance.abandonnee': 'Relance abandonnée'
  };
  // Ce que le serveur a vu du socle lui-même (frise).
  const EVENEMENTS = { 'en ligne': 'Revenu en ligne', 'hors ligne': 'Hors ligne', redemarrage: 'Redémarrage', defaut: 'Défaut',
    trop_chaud: 'Trop chaud', derive: 'Dérive', retabli: 'Retour à la normale', maj: 'Mise à jour', message: 'Message' };
  const LIBELLES_DETAILS = { compte: 'compte', admin: 'administrateur', sessions: 'sessions', socles: 'socles', historiquesEffaces: 'historiques effacés',
    motDePasse: 'mot de passe', proprietairesDetaches: 'propriétaires détachés', nom: 'nom', fichier: 'fichier', lignes: 'lignes', raison: 'raison', teteAttendue: 'tête attendue',
    support: 'support', jusqua: 'jusqu\'au', heures: 'heures', action: 'action', valeurs: 'valeurs', ok: 'réussie', erreur: 'erreur', demande: 'demande n°',
    gravite: 'gravité', statut: 'statut', responsable: 'responsable', de: 'de', longueur: 'caractères', copie: 'copie du', par: 'par', proprietaires: 'propriétaires',
    modele: 'réponse type n°', titre: 'titre', quand: 'pour le', message: 'message au client' };
  const valeurDetail = (k, v) => typeof v === 'boolean' ? (v ? 'oui' : 'non')
    : (v && typeof v === 'object') ? JSON.stringify(v) : (k === 'jusqua' || k === 'copie' || k === 'quand') && /^\d{4}-/.test(String(v)) ? date(v) : v;
  function texteDetails(d) {
    if (!d) return '';
    return Object.entries(d).map(([k, v]) => `${LIBELLES_DETAILS[k] || k} : ${valeurDetail(k, v)}`).join(' · ');
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

  // Pourquoi un socle n'installe pas (encore) la dernière version (sante.majAuto.attente).
  const ATTENTES_MAJ = {
    'a-jour': 'à jour', 'a-verifier': 'pas encore vérifié', prete: 'installation en cours', refusee: 'version revenue en arrière ici',
    desactivee: 'installation manuelle', 'non-signee': 'images non signées : installation manuelle', echecs: 'trois échecs',
    heure: 'heure inconnue', reportee: 'reportée par le propriétaire', pause: 'déploiement suspendu', deploiement: 'pas encore son tour',
    tentee: 'tentée cette nuit', plage: 'prévue la nuit', 'hors-ligne': 'hors ligne', demarrage: 'vient de démarrer',
    validation: 'image en validation', defaut: 'zone en défaut', autotune: 'autotune', essai: 'essai', entretien: 'entretien', support: 'accès support ouvert'
  };

  // Schéma du câblage annoté de ce que le socle publie (santé, état des zones) :
  // bloc 12 V, convertisseur 5 V, ESP32, bilames, tapis, MOSFET D16/D17,
  // sondes sur le bus 1-Wire (D4). Ce qui est en cause passe en rouge ; la
  // liste dessous dit la même chose en texte, pour les lecteurs d'écran.
  // Défaut du firmware → organes à vérifier d'abord (une sonde muette ou figée ;
  // un MOSFET resté passant ou une sonde mal placée ; un bilame ouvert, un
  // tapis coupé ou un MOSFET mort). Libellé inconnu : la sonde et le tapis.
  const CAUSES_DEFAUT = {
    'SONDE': ['sonde'], 'SONDE FIGEE': ['sonde'], 'SURCHAUFFE': ['mosfet', 'sonde'],
    'CHAUFFE SANS EFFET': ['bilame', 'tapis', 'mosfet']
  };
  function schemaCablage(x) {
    const sa = x.sante || {};
    const zones = [0, 1].map(i => x.etatsZones.find(z => z.zone === i + 1) || null);
    const vrai = v => v === true || v === 1 || v === '1';
    const enDefaut = z => !!z && z.defaut !== undefined && z.defaut !== null && z.defaut !== '0' && z.defaut !== 0 && z.defaut !== false;
    const causes = zones.map(z => (enDefaut(z) ? (CAUSES_DEFAUT[String(z.defaut_libelle || '').toUpperCase()] || ['sonde', 'tapis']) : []));
    const anomalieCourant = sa.anomalieCourant ? String(sa.anomalieCourant) : '';
    const horsLigne = !x.enLigne;
    const textes = [];
    const boite = (xx, y, l, ht, titre, sous, etatCss) => s('g', { class: `sch-element ${etatCss || ''}` },
      s('rect', { x: xx, y, width: l, height: ht, rx: 8 }),
      s('text', { x: xx + l / 2, y: y + (sous ? ht / 2 - 3 : ht / 2 + 4), 'text-anchor': 'middle', class: 'sch-titre' }, titre),
      sous ? s('text', { x: xx + l / 2, y: y + ht / 2 + 13, 'text-anchor': 'middle', class: 'sch-valeur' }, sous) : null);
    const fil = (d, css) => s('path', { d, class: `sch-fil ${css || ''}` });
    const g = s('svg', { viewBox: '0 0 680 330', class: `schema-cablage${horsLigne ? ' sch-hors-ligne' : ''}`, 'aria-hidden': 'true', focusable: 'false' });

    // Alimentation, rail 12 V, convertisseur, ESP32.
    const courant = typeof sa.courantA === 'number' ? `${sa.courantA.toFixed(2).replace('.', ',')} A${typeof sa.tensionV === 'number' ? ` · ${sa.tensionV.toFixed(1).replace('.', ',')} V` : ''}` : '';
    g.append(boite(16, 20, 120, 52, 'Bloc 12 V', courant || null, anomalieCourant ? 'sch-ko' : ''),
      fil('M136 46 H585', 'sch-12v'), fil('M76 72 V112'),
      boite(16, 112, 120, 46, 'LM2596', '5 V', ''), fil('M136 135 H176'),
      boite(176, 104, 150, 70, 'ESP32', sa.rssi !== undefined ? `Wi-Fi ${sa.rssi} dBm` : (horsLigne ? 'hors ligne' : null), horsLigne ? 'sch-ko' : ''));
    textes.push(`Alimentation 12 V${courant ? ` : ${courant}` : ''}${anomalieCourant ? `, anomalie : ${anomalieCourant}` : ''}.`);
    textes.push(`ESP32 : ${horsLigne ? `hors ligne${x.vu ? ` depuis ${depuis(x.vu)}` : ''}` : `en ligne${sa.rssi !== undefined ? `, signal ${sa.rssi} dBm` : ''}`}.`);

    // Une branche par tapis : 12 V → bilame → tapis → MOSFET → masse ; grille sur D16/D17.
    zones.forEach((z, i) => {
      const x0 = 380 + i * 150, nom = (z && z.nom) || `Zone ${i + 1}`, c = causes[i];
      const chauffe = !!z && vrai(z.chauffe);
      const css = el => (c.includes(el) ? 'sch-ko' : '');
      g.append(fil(`M${x0 + 55} 46 V76`, 'sch-12v'),
        boite(x0, 76, 110, 34, 'Bilame 70 °C', null, css('bilame')), fil(`M${x0 + 55} 110 V128`, 'sch-12v'),
        boite(x0, 128, 110, 48, `Tapis ${i + 1}`, chauffe ? 'chauffe' : 'au repos', `${chauffe ? 'sch-chauffe' : ''} ${css('tapis')}`),
        fil(`M${x0 + 55} 176 V196`),
        boite(x0, 196, 110, 40, 'MOSFET', `D${16 + i}`, css('mosfet')), fil(`M${x0 + 55} 236 V252`),
        s('path', { d: `M${x0 + 43} 252 H${x0 + 67} M${x0 + 47} 257 H${x0 + 63} M${x0 + 51} 262 H${x0 + 59}`, class: 'sch-fil' }),
        // Les deux commandes de grille, sans se croiser ni traverser une branche.
        fil(i === 0 ? 'M326 150 H360 V216 H380' : 'M326 164 H350 V270 H515 V216 H530', `sch-commande${chauffe ? ' sch-actif' : ''}`));
      textes.push(`Tapis ${i + 1} (${nom}) : ${chauffe ? 'chauffe' : 'au repos'}${z && z.demande !== undefined ? `, demande ${z.demande} %` : ''}${c.length ? ` — en cause : ${c.join(', ')} (${z.defaut_libelle || 'défaut'})` : ''}.`);
    });

    // Bus 1-Wire (D4) et les deux sondes.
    g.append(fil('M251 174 V292 H560', 'sch-bus'),
      s('text', { x: 258, y: 286, class: 'sch-petit' }, '1-Wire D4 · 4,7 kΩ'));
    zones.forEach((z, i) => {
      const x0 = 330 + i * 130, c = causes[i];
      const temp = z && typeof z.temp === 'number' && z.temp > -100 ? `${degres(z.temp)}` : '—';
      g.append(fil(`M${x0 + 55} 292 V300`, 'sch-bus'),
        boite(x0, 300 - 2, 110, 28, `Sonde ${i + 1} · ${temp}`, null, c.includes('sonde') ? 'sch-ko' : ''));
      textes.push(`Sonde de la zone ${i + 1} : ${temp}${z && typeof z.consigne === 'number' ? ` pour ${degres(z.consigne)}` : ''}${c.includes('sonde') ? ` — en cause (${z.defaut_libelle})` : ''}.`);
    });
    return h('div', { class: 'schema' }, g, h('ul', { class: 'legende-schema' }, textes.map(t => h('li', { texte: t }))));
  }

  async function ficheSocle(id, ouvrir = true) {
    const [x, hist, fr] = await Promise.all([admin('GET', `/api/admin/socles/${id}`),
      admin('GET', `/api/admin/socles/${id}/historique?pas=300`).catch(() => null),
      admin('GET', `/api/admin/socles/${id}/frise`).catch(() => null)]);
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
        sa.signatureOta !== undefined ? ['mises à jour', sa.signatureOta ? 'signées exigées' : 'signature non exigée'] : null,
        sa.majAuto ? ['mises à jour automatiques', `${sa.majAuto.actif ? 'activées' : 'coupées'} · ${ATTENTES_MAJ[sa.majAuto.attente] || sa.majAuto.attente}${sa.majAuto.disponible ? ` · ${sa.majAuto.disponible} disponible` : ''}`] : null
      ]),
      section('Zones', x.etatsZones.length ? h('ul', { class: 'liste-actions' }, x.etatsZones.map(z => h('li', {},
        h('span', {}, h('b', { texte: z.nom || `Zone ${z.zone}` }), ` — ${degres(z.temp)} pour ${degres(z.consigne)}`,
          h('span', { class: 'discret', texte: `demande ${z.demande !== undefined ? z.demande + ' %' : '—'} · ${z.chauffe === '1' || z.chauffe === 1 ? 'chauffe' : 'au repos'}` })),
        z.defaut && z.defaut !== '0' && z.defaut !== 0 ? badge(z.defaut_libelle || 'défaut', 'ko') : badge('normal', 'ok')))) : h('p', { class: 'aide', texte: 'Aucun état de zone reçu depuis le démarrage du serveur.' })),
      section('Câblage, en direct', schemaCablage(x)),
      section('Dernières 24 heures', courbe(hist ? hist.points : []), h('p', { class: 'legende-courbe' }, h('span', { texte: 'zone 1' }), h('span', { texte: 'zone 2' }))),
      section('Accès support', x.acces && x.acces.actif
        ? h('div', {}, h('p', { class: 'aide', texte: `Ouvert par le propriétaire jusqu'au ${date(x.acces.jusqua)}${x.acces.prolonge ? ' (prolongé)' : ''}.` }),
          h('div', { class: 'boutons' }, x.demandes.find(d => d.statut !== 'résolue')
            ? h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-demande': x.demandes.find(d => d.statut !== 'résolue').n, texte: 'Ouvrir la demande et les diagnostics' })
            : h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'ouvrir-demande', 'data-socle': id, 'data-gravite': 'normale', 'data-texte': '', texte: 'Ouvrir une demande' })))
        : h('p', { class: 'aide', texte: 'Fermé. Diagnostics et réglages à distance demandent l\'accès support, ouvert par le propriétaire depuis son application (« Demander l\'accès » depuis une demande).' }),
        x.demandes.length ? h('p', { class: 'aide' }, 'Demandes : ', x.demandes.map((d, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'lien', 'data-demande': d.n, texte: `n°${d.n} (${d.statut})` })])) : null),
      section('Propriétaires',
        x.proprietairesDetail.length ? h('ul', { class: 'liste-actions' }, x.proprietairesDetail.map(p => h('li', {},
          h('span', {}, estSupport() ? pii(p.login) : lienCompte(p.login), h('span', { class: 'discret', texte: p.type === 'email' ? 'compte par e-mail' : 'compte à mot de passe' })),
          estSupport() ? null : h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'detacher', 'data-socle': id, 'data-login': p.login, texte: 'Détacher' }))))
          : h('p', { class: 'aide', texte: 'Aucun : le socle n\'est rattaché à aucun compte.' }),
        estSupport() ? null : h('form', { class: 'ligne-ajout', 'data-form': 'rattacher', 'data-socle': id, novalidate: true },
          h('label', { class: 'sr-only', for: 'rattacher-login', texte: 'Compte à rattacher' }),
          h('input', { id: 'rattacher-login', placeholder: 'identifiant ou e-mail du compte', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }),
          h('button', { type: 'submit', class: 'btn btn-secondaire btn-petit', texte: 'Rattacher' }))),
      estSupport() ? null : section('Compte d\'appareil (MQTT)', x.appareil
        ? h('div', {}, h('p', { class: 'aide', texte: `Créé le ${date(x.appareil.cree)}${x.appareil.renouvele ? `, mot de passe changé le ${date(x.appareil.renouvele)}` : ''}.` }),
          h('div', { class: 'boutons' },
            h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'renouveler-appareil', 'data-id': id, texte: 'Changer le mot de passe' }),
            h('button', { type: 'button', class: 'btn btn-danger btn-petit', 'data-action': 'retirer-appareil', 'data-id': id, texte: 'Retirer' })))
        : h('div', {}, h('p', { class: 'aide', texte: 'Aucun : ce socle se connecte ailleurs (broker amont) ou n\'a pas encore été monté.' }),
          h('div', { class: 'boutons' }, h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'creer-appareil', 'data-id': id, texte: 'Créer le compte d\'appareil' })))),
      x.sante ? h('details', {}, h('summary', { texte: 'Santé publiée par le socle (JSON)' }), h('pre', { class: 'bloc-texte json-sante', texte: JSON.stringify(x.sante, null, 1) })) : null,
      section('Frise', fr ? frise(fr.frise) : h('p', { class: 'aide', texte: 'Frise indisponible.' })));
  }

  // ------------------------------------------------------------------ fiche d'une demande
  // Diagnostics proposés pendant un accès ouvert : action, libellé, paramètres,
  // et la question à poser avant (les gestes qui chauffent ou coupent).
  /** @type {Array<Array<any>>} */
  const DIAGNOSTICS = [
    ['sondes', 'Relire le bus', { relire: true }],
    ['etat', 'État complet', {}],
    ['journal', 'Journal du socle', {}],
    ['rapport', 'Rapport du jour', {}],
    ['jours', 'Résumés journaliers', { n: 14 }],
    ['essai', 'Essai de chauffe zone 1', { z: 0 }, 'La zone 1 va chauffer seule à pleine puissance, 10 minutes au plus (la coupure à 40 °C reste active). Le client est-il prévenu ?'],
    ['essai', 'Essai de chauffe zone 2', { z: 1 }, 'La zone 2 va chauffer seule à pleine puissance, 10 minutes au plus (la coupure à 40 °C reste active). Le client est-il prévenu ?'],
    ['reset', 'Lever les défauts', {}, 'Lever les défauts verrouillés ? La chauffe reprend si la cause a disparu.'],
    ['redemarrer', 'Redémarrer le socle', {}, 'Redémarrer le socle ? Il revient en une minute environ, régulation comprise.']
  ];
  function texteSortie(r) {
    if (!r) return '';
    if (typeof r.texte === 'string') return r.texte;
    if (r.message) return r.message;
    const reste = { ...r };
    delete reste.req;
    delete reste.ok;
    return JSON.stringify(reste, null, 1);
  }

  async function ficheDemande(n, ouvrir = true) {
    const d = await admin('GET', `/api/admin/support/demandes/${n}`);
    const [acc, fr, eq, rep, vars] = await Promise.all([
      d.socle ? admin('GET', `/api/admin/support/acces/${d.socle}`).catch(() => null) : null,
      d.socle ? admin('GET', `/api/admin/socles/${d.socle}/frise`).catch(() => null) : null,
      etat.equipe ? etat.equipe : admin('GET', '/api/admin/support/equipe').then(r => r.equipe).catch(() => []),
      admin('GET', '/api/admin/support/reponses').catch(() => ({ reponses: [] })),
      admin('GET', `/api/admin/support/demandes/${n}/variables`).catch(() => ({ variables: {} }))]);
    etat.equipe = eq;
    etat.reponses = rep.reponses;
    etat.variables = vars.variables;
    etat.fiche = { type: 'demande', id: d.n };
    if (!ouvrir && !$('#fiche').open) return;
    const corps = ouvrirFiche(`Demande n°${d.n}${d.socle ? ` — ${d.socle}` : ''}`);
    const choix = (id, libelle, valeurs, actuelle, nomChamp) => h('div', {},
      h('label', { for: id, texte: libelle }),
      h('select', { id, 'data-champ': nomChamp, 'data-n': d.n }, valeurs.map(([v, t]) => h('option', { value: v, selected: v === actuelle, texte: t }))));
    const sortie = etat.sortie[d.socle];
    corps.append(
      h('div', { class: 'champs-demande' },
        choix('dm-statut', 'Statut', [['nouvelle', 'nouvelle'], ['en cours', 'en cours'], ['attente client', 'attente client'], ['résolue', 'résolue']], d.statut, 'statut'),
        choix('dm-gravite', 'Gravité', [['urgente', 'urgente'], ['normale', 'normale'], ['faible', 'faible']], d.gravite, 'gravite'),
        choix('dm-responsable', 'Responsable', [['', 'personne']].concat(eq.map(m => [m.login, pii(m.login)])), d.responsable || '', 'responsable')),
      h('p', { class: 'aide' }, `Client : ${d.compte ? pii(d.compte) : '—'} · ouverte ${depuis(d.cree)} (${date(d.cree)})`,
        d.socle ? [' · socle ', lienSocle(d.socle), ' ', d.socleEtat ? badgesSocle({ ...d.socleEtat, jamaisVu: false }) : badge('jamais vu', 'neutre')] : null,
        ' ', h('button', { type: 'button', class: 'btn btn-fantome btn-petit', 'data-action': 'actualiser-fiche', texte: 'Actualiser' })),
      section('Échanges avec le client',
        d.messages.length ? h('ol', { class: 'fil' }, d.messages.map(m => h('li', { 'data-de': m.de },
          h('span', { class: 'discret' }, m.de === 'client' ? 'Client' : `Support${m.qui ? ` (${quiAffiche(m.qui)})` : ''}`, ' · ', h('time', { datetime: m.t, texte: date(m.t) })),
          h('p', { class: 'texte-message', texte: m.texte })))) : h('p', { class: 'aide', texte: 'Aucun message.' }),
        h('form', { class: 'ligne-message', 'data-form': 'repondre', 'data-n': d.n, novalidate: true },
          etat.reponses.length ? h('div', { class: 'ligne-modele' },
            h('label', { for: 'dm-modele', texte: 'Réponse type' }),
            h('select', { id: 'dm-modele' }, h('option', { value: '', texte: 'Insérer une réponse type…' }),
              [...etat.reponses].sort((x, y) => (y.usages || 0) - (x.usages || 0)).map(r => h('option', { value: String(r.id), texte: r.titre })))) : null,
          h('label', { for: 'dm-reponse', texte: 'Répondre au client' }),
          h('textarea', { id: 'dm-reponse', rows: '3', 'aria-describedby': 'dm-reponse-aide' }),
          h('p', { class: 'aide', id: 'dm-reponse-aide', texte: 'Une variable restée entre accolades est inconnue du serveur : à compléter avant l\'envoi.' }),
          h('div', { class: 'boutons' }, h('button', { type: 'submit', class: 'btn btn-petit', texte: 'Envoyer au client' })))),
      section('Notes internes',
        d.notes.length ? h('ul', { class: 'liste-actions' }, d.notes.map(no => h('li', {},
          h('span', {}, h('span', { class: 'texte-message', texte: no.texte }), h('span', { class: 'discret', texte: `${quiAffiche(no.qui)} · ${date(no.t)}` }))))) : null,
        h('form', { class: 'ligne-message', 'data-form': 'note', 'data-n': d.n, novalidate: true },
          h('label', { for: 'dm-note', texte: 'Ajouter une note (jamais montrée au client)' }),
          h('textarea', { id: 'dm-note', rows: '2' }),
          h('div', { class: 'boutons' }, h('button', { type: 'submit', class: 'btn btn-secondaire btn-petit', texte: 'Ajouter la note' })))),
      section('Relance',
        d.relance ? h('div', { class: 'relance-actuelle' },
          h('p', {}, d.relance.due ? badge('à faire', 'warn') : badge('prévue', 'neutre'), ` ${date(d.relance.quand)} — `,
            d.relance.message ? 'message au client s\'il n\'a pas répondu d\'ici là' : 'rappel pour l\'équipe',
            d.relance.repondu ? ` (le client a répondu le ${date(d.relance.repondu)} : rien ne lui sera envoyé)` : '',
            h('span', { class: 'discret', texte: ` · ${quiAffiche(d.relance.qui)}` })),
          d.relance.texte ? h('p', { class: 'texte-message', texte: d.relance.texte }) : null,
          h('div', { class: 'boutons' }, h('button', { type: 'button', class: 'btn btn-fantome btn-petit', 'data-action': 'annuler-relance', 'data-n': d.n, texte: d.relance.due ? 'C\'est fait, retirer' : 'Annuler la relance' }))) : null,
        h('form', { class: 'ligne-message', 'data-form': 'relance', 'data-n': d.n, novalidate: true },
          h('label', { for: 'dm-rel-quand', texte: d.relance ? 'Remplacer par une relance le' : 'Relancer le' }),
          h('div', { class: 'ligne-relance' },
            h('input', { id: 'dm-rel-quand', type: 'datetime-local' }),
            [['Dans 2 h', 'h2'], ['Demain 10:00', 'demain'], ['Dans 48 h', 'h48']].map(([libelle, k]) =>
              h('button', { type: 'button', class: 'btn btn-fantome btn-petit', 'data-action': 'relance-raccourci', 'data-quand': k, texte: libelle }))),
          h('label', { for: 'dm-rel-texte', texte: 'Texte : rappel pour l\'équipe, ou message au client' }),
          h('textarea', { id: 'dm-rel-texte', rows: '2' }),
          h('label', { class: 'case' }, h('input', { type: 'checkbox', id: 'dm-rel-message', disabled: !d.compte }),
            ' Envoyer ce texte au client à l\'échéance, s\'il n\'a pas répondu d\'ici là'),
          h('div', { class: 'boutons' }, h('button', { type: 'submit', class: 'btn btn-secondaire btn-petit', texte: 'Programmer la relance' })))),
      d.socle ? section('Accès au socle', acc && acc.actif
        ? h('div', { class: 'panneau-acces' },
          h('p', { class: 'aide', texte: `Ouvert par le propriétaire jusqu'au ${date(acc.jusqua)}${acc.prolonge ? ' (prolongé)' : ''}. Chaque geste est signé avec la clé de session et noté au journal ; la coupure à 40 °C du socle reste active.` }),
          h('h4', { texte: 'Diagnostics' }),
          h('div', { class: 'boutons' }, DIAGNOSTICS.map(([, libelle], i) => h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'acces-cmd', 'data-socle': d.socle, 'data-i': i, texte: libelle }))),
          h('h4', { texte: 'Réglages' }),
          h('p', { class: 'aide', texte: acc.copie ? `Copie des réglages du ${date(acc.copie)}.` : 'Pas encore de copie des réglages.' }),
          h('div', { class: 'boutons' },
            h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'copie', 'data-socle': d.socle, texte: 'Copier les réglages maintenant' }),
            h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'remettre', 'data-socle': d.socle, disabled: !acc.copie, texte: 'Tout remettre comme à la copie' })),
          h('form', { class: 'ligne-ajout', 'data-form': 'transferer', 'data-socle': d.socle, novalidate: true },
            h('label', { class: 'sr-only', for: 'dm-vers', texte: 'Socle de remplacement' }),
            h('input', { id: 'dm-vers', placeholder: 'socle de remplacement (terra…)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '11' }),
            h('button', { type: 'submit', class: 'btn btn-secondaire btn-petit', texte: 'Transférer les réglages' })),
          h('h4', { texte: 'Accès' }),
          h('div', { class: 'boutons' },
            h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'prolonger', 'data-socle': d.socle, texte: 'Prolonger de 24 h' }),
            h('button', { type: 'button', class: 'btn btn-danger btn-petit', 'data-action': 'fermer-acces', 'data-socle': d.socle, texte: 'Fermer l\'accès' })),
          sortie ? h('div', {}, h('h4', { texte: `Dernier résultat : ${sortie.libelle} (${date(sortie.t)})` }),
            h('pre', { class: 'bloc-texte sortie-support', tabindex: '0', texte: sortie.texte })) : null)
        : h('div', {},
          h('p', { class: 'aide', texte: d.demandeAcces ? `Accès demandé au propriétaire le ${date(d.demandeAcces)} : il l'accorde (24 h) ou le refuse depuis son application.` : 'Fermé. Le propriétaire l\'ouvre depuis son application ; on peut le lui demander (il reçoit une notification).' }),
          h('div', { class: 'boutons' }, h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'demander-acces', 'data-n': d.n, texte: d.demandeAcces ? 'Redemander l\'accès' : 'Demander l\'accès au propriétaire' })))) : null,
      d.socle ? section('Frise du socle', fr ? frise(fr.frise) : h('p', { class: 'aide', texte: 'Frise indisponible.' })) : null);
  }

  async function ficheCompte(login, ouvrir = true) {
    const x = await admin('GET', `/api/admin/utilisateurs/${encodeURIComponent(login)}`);
    etat.fiche = { type: 'compte', id: x.login };
    if (!ouvrir && !$('#fiche').open) return;
    const moiMeme = etat.session && etat.session.type === 'compte' && etat.session.qui.toLowerCase() === x.login.toLowerCase();
    const corps = ouvrirFiche(pii(x.login));
    corps.append(
      h('span', { class: 'badges' }, badge(x.type === 'email' ? 'compte par e-mail' : 'compte à mot de passe', 'neutre'), x.admin ? badge('administrateur', 'warn') : null,
        x.support ? badge('support', 'warn') : null, moiMeme ? badge('vous', 'ok') : null),
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
        x.admin ? null : h('button', { type: 'button', class: 'btn btn-secondaire btn-petit', 'data-action': 'basculer-support', 'data-login': x.login, 'data-support': x.support ? '0' : '1',
          texte: x.support ? 'Retirer le rôle support' : 'Donner le rôle support' }),
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
    if (etat.fiche && $('#fiche').open) await rouvrirFiche();
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
    async 'actualiser-fiche'() { if (etat.fiche) await rouvrirFiche(); },
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
    async 'nouvelle-demande'() { basculerFormulaire('#form-nouvelle-demande', '[data-action="nouvelle-demande"]', '#nd-socle'); },
    // Depuis une alerte : le formulaire de la demande, prérempli, à relire avant l'envoi.
    async 'ouvrir-demande'(el) {
      if ($('#fiche').open) $('#fiche').close();
      onglet('support', false);
      const f = $('#form-nouvelle-demande');
      if (f.hidden) basculerFormulaire('#form-nouvelle-demande', '[data-action="nouvelle-demande"]', '#nd-socle');
      /** @type {HTMLInputElement} */ ($('#nd-socle')).value = el.dataset.socle || '';
      /** @type {HTMLSelectElement} */ ($('#nd-gravite')).value = el.dataset.gravite || 'normale';
      /** @type {HTMLTextAreaElement} */ ($('#nd-texte')).value = el.dataset.texte
        ? `Bonjour,\n\nVotre socle ${el.dataset.socle} nous signale : ${el.dataset.texte}. Nous aimerions vérifier cela avec vous : pouvez-vous nous ouvrir l'accès depuis l'application (rubrique Service, « Autoriser le support ») ?\n\nL'équipe Terrariums`
        : '';
      $('#nd-texte').focus();
    },
    async 'reponses-types'(el) {
      const p = $('#panneau-reponses');
      p.hidden = !p.hidden;
      el.setAttribute('aria-expanded', String(!p.hidden));
      if (!p.hidden) { await chargerReponses(); $('#rt-titre').focus(); }
    },
    'reponse-editer'(el) {
      const r = etat.reponses.find(x => String(x.id) === el.dataset.id);
      if (!r) return;
      /** @type {HTMLInputElement} */ ($('#rt-id')).value = String(r.id);
      /** @type {HTMLInputElement} */ ($('#rt-titre')).value = r.titre;
      /** @type {HTMLTextAreaElement} */ ($('#rt-texte')).value = r.texte;
      remplir($('#rt-titre-form'), `Modifier « ${r.titre} »`);
      $('#rt-titre').focus();
    },
    'reponse-vider'() { viderFormReponse(); },
    async 'reponse-supprimer'(el) {
      const r = etat.reponses.find(x => String(x.id) === el.dataset.id);
      if (!r || !await confirmer({ titre: `Supprimer « ${r.titre} » ?`, texte: 'La réponse type disparaît pour toute l\'équipe.', bouton: 'Supprimer' })) return;
      await admin('DELETE', `/api/admin/support/reponses/${r.id}`);
      message('Réponse type supprimée.');
      await chargerReponses();
    },
    'relance-raccourci'(el) {
      const d = new Date();
      if (el.dataset.quand === 'h2') d.setHours(d.getHours() + 2);
      else if (el.dataset.quand === 'h48') d.setHours(d.getHours() + 48);
      else { d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); }
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      /** @type {HTMLInputElement} */ ($('#dm-rel-quand')).value = local;
    },
    async 'annuler-relance'(el) {
      await admin('DELETE', `/api/admin/support/demandes/${el.dataset.n}/relance`);
      message('Relance retirée.');
      await actualiser();
    },
    async 'demander-acces'(el) {
      await admin('POST', `/api/admin/support/demandes/${el.dataset.n}/demander-acces`);
      message('Demande d\'accès envoyée au propriétaire.');
      await actualiser();
    },
    async 'acces-cmd'(el) {
      const [action, libelle, params, question] = /** @type {[string, string, Record<string, any>, string?]} */ (DIAGNOSTICS[+el.dataset.i]);
      const id = el.dataset.socle;
      if (question && !await confirmer({ titre: libelle, texte: question, bouton: 'Lancer' })) return;
      const r = await admin('POST', `/api/admin/support/acces/${id}/commande`, { action, ...params });
      etat.sortie[id] = { libelle, t: new Date().toISOString(), texte: (r.ok ? '' : 'REFUS : ') + (r.ok ? texteSortie(r) : (r.erreur || 'refusé')) };
      message(r.ok ? `${libelle} : fait.` : `${libelle} : ${r.erreur || 'refusé'}`, !r.ok);
      await actualiser();
    },
    async 'copie'(el) {
      const r = await admin('POST', `/api/admin/support/acces/${el.dataset.socle}/copie`);
      message(`Réglages copiés (${date(r.copie)}).`);
      await actualiser();
    },
    async 'remettre'(el) {
      const id = el.dataset.socle;
      if (!await confirmer({ titre: 'Tout remettre comme à la copie ?', texte: 'Les réglages du socle (zones, réglages généraux, sondes) redeviennent ceux de la copie. Tout ou rien.', reference: id, bouton: 'Tout remettre' })) return;
      const r = await admin('POST', `/api/admin/support/acces/${id}/remettre`, { confirmation: id });
      etat.sortie[id] = { libelle: 'Tout remettre', t: new Date().toISOString(), texte: r.message || 'Réglages remis.' };
      message('Réglages remis comme à la copie.');
      await actualiser();
    },
    async 'prolonger'(el) {
      const r = await admin('POST', `/api/admin/support/acces/${el.dataset.socle}/prolonger`, { heures: 24 });
      message(`Accès prolongé jusqu'au ${date(r.jusqua)} ; le propriétaire est prévenu.`);
      await actualiser();
    },
    async 'fermer-acces'(el) {
      if (!await confirmer({ titre: 'Fermer l\'accès au socle ?', texte: 'La clé de session est effacée ; il faudra que le propriétaire rouvre l\'accès pour toute autre intervention.', bouton: 'Fermer l\'accès' })) return;
      await admin('POST', `/api/admin/support/acces/${el.dataset.socle}/fermer`);
      message('Accès fermé ; le propriétaire est prévenu.');
      await actualiser();
    },
    async 'basculer-support'(el) {
      const donner = el.dataset.support === '1', login = el.dataset.login;
      await admin('POST', `/api/admin/utilisateurs/${encodeURIComponent(login)}/support`, { support: donner });
      message(donner ? 'Rôle support donné.' : 'Rôle support retiré.');
      etat.equipe = null;
      await actualiser();
    },
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
      const groupe = o === 'support' ? 'demandes' : o;
      if (f) { etat.filtres[groupe] = f; for (const b of $$(`[data-filtres="${groupe}"] [data-filtre]`)) b.setAttribute('aria-pressed', String(b.dataset.filtre === f)); }
      onglet(o);
      return;
    }
    if (el.dataset.filtre) {
      const groupe = /** @type {HTMLElement} */ (el.closest('[data-filtres]')).dataset.filtres;
      etat.filtres[groupe] = el.dataset.filtre;
      for (const b of el.parentElement.querySelectorAll('[data-filtre]')) b.setAttribute('aria-pressed', String(b === el));
      if (groupe === 'demandes') chargerSupport().catch(echec);
      else (groupe === 'socles' ? vueSocles : vueComptes)();
      return;
    }
    if (el.dataset.demande && !el.dataset.action) { ficheDemande(el.dataset.demande).catch(echec); return; }
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
    } else if (f.id === 'form-nouvelle-demande') {
      const socle = /** @type {HTMLInputElement} */ ($('#nd-socle')).value.trim();
      const texte = /** @type {HTMLTextAreaElement} */ ($('#nd-texte')).value.trim();
      if (!/^terra[0-9A-Za-z]{6}$/.test(socle)) { message('Identifiant attendu : terraA1B2C3.', true); return; }
      if (!texte) { message('Écrire le message au client.', true); return; }
      admin('POST', '/api/admin/support/demandes', { socle, texte, gravite: /** @type {HTMLSelectElement} */ ($('#nd-gravite')).value }).then(async d => {
        /** @type {HTMLInputElement} */ ($('#nd-socle')).value = ''; /** @type {HTMLTextAreaElement} */ ($('#nd-texte')).value = '';
        basculerFormulaire('#form-nouvelle-demande', '[data-action="nouvelle-demande"]', '#nd-socle');
        message(`Demande n°${d.n} ouverte ; le client est prévenu.`);
        await chargerSupport();
      }).catch(echec);
    } else if (f.dataset.form === 'repondre' || f.dataset.form === 'note') {
      const champ = /** @type {HTMLTextAreaElement} */ (f.querySelector('textarea'));
      const texte = champ.value.trim();
      if (!texte) return;
      const route = f.dataset.form === 'repondre' ? 'messages' : 'notes';
      const modele = route === 'messages' && f.dataset.modele ? +f.dataset.modele : undefined;
      admin('POST', `/api/admin/support/demandes/${f.dataset.n}/${route}`, { texte, modele }).then(async () => {
        champ.value = '';
        delete f.dataset.modele;
        message(route === 'messages' ? 'Réponse envoyée ; le client est prévenu.' : 'Note ajoutée.');
        await actualiser();
      }).catch(echec);
    } else if (f.id === 'form-reponse') {
      const id = /** @type {HTMLInputElement} */ ($('#rt-id')).value;
      const titre = /** @type {HTMLInputElement} */ ($('#rt-titre')).value.trim();
      const texte = /** @type {HTMLTextAreaElement} */ ($('#rt-texte')).value.trim();
      if (!titre || !texte) { message('Un titre et un texte.', true); return; }
      admin('POST', `/api/admin/support/reponses${id ? `/${id}` : ''}`, { titre, texte }).then(async () => {
        message(id ? 'Réponse type modifiée.' : 'Réponse type ajoutée.');
        viderFormReponse();
        await chargerReponses();
      }).catch(echec);
    } else if (f.dataset.form === 'relance') {
      const quand = /** @type {HTMLInputElement} */ ($('#dm-rel-quand')).value;
      const texte = /** @type {HTMLTextAreaElement} */ ($('#dm-rel-texte')).value.trim();
      const auClient = /** @type {HTMLInputElement} */ ($('#dm-rel-message')).checked;
      if (!quand) { message('Choisir la date et l\'heure de la relance.', true); return; }
      if (auClient && !texte) { message('Écrire le message à envoyer au client.', true); return; }
      admin('POST', `/api/admin/support/demandes/${f.dataset.n}/relance`, { quand: new Date(quand).toISOString(), texte, message: auClient }).then(async () => {
        message(auClient ? 'Relance programmée : le message partira à l\'échéance si le client n\'a pas répondu.' : 'Relance programmée.');
        await actualiser();
      }).catch(echec);
    } else if (f.dataset.form === 'transferer') {
      const de = f.dataset.socle, vers = /** @type {HTMLInputElement} */ (f.querySelector('input')).value.trim();
      if (!/^terra[0-9A-Za-z]{6}$/.test(vers) || vers === de) { message('Identifiant du socle de remplacement attendu (terra…).', true); return; }
      confirmer({ titre: `Transférer les réglages de ${de} vers ${vers} ?`, texte: `Les réglages de ${de} remplacent ceux de ${vers}, dont l'accès doit être ouvert ; les propriétaires de ${de} sont rattachés à ${vers}.`, reference: vers, bouton: 'Transférer' })
        .then(ok => ok && admin('POST', '/api/admin/support/transferer', { de, vers, confirmation: vers }).then(async r => {
          /** @type {HTMLInputElement} */ (f.querySelector('input')).value = '';
          etat.sortie[de] = { libelle: `Transfert vers ${vers}`, t: new Date().toISOString(), texte: r.message || 'Réglages transférés.' };
          message(`Réglages transférés vers ${vers}.`);
          await actualiser();
        })).catch(echec);
    } else if (f.dataset.form === 'rattacher-socle') {
      const id = f.querySelector('input').value.trim();
      if (!/^terra[0-9A-Za-z]{6}$/.test(id)) { message('Identifiant attendu : terraA1B2C3.', true); return; }
      admin('POST', `/api/admin/utilisateurs/${encodeURIComponent(f.dataset.login)}/socles`, { id }).then(() => { message('Socle rattaché.'); return actualiser(); }).catch(echec);
    }
  });

  // Statut, gravité, responsable d'une demande : enregistrés dès qu'ils changent.
  document.addEventListener('change', e => {
    const el = /** @type {HTMLSelectElement} */ (e.target);
    if (el.id === 'dm-modele') {
      const r = (etat.reponses || []).find(x => String(x.id) === el.value);
      const f = /** @type {HTMLFormElement} */ (el.form);
      if (!r || !f) return;
      const champ = /** @type {HTMLTextAreaElement} */ (f.querySelector('textarea'));
      const v = etat.variables || {};
      const rempli = r.texte.replace(/\{([^{}]{1,30})\}/g, (tout, nom) => (v[nom] !== undefined && v[nom] !== '' ? v[nom] : tout));
      champ.value = champ.value.trim() ? `${champ.value.trim()}\n\n${rempli}` : rempli;
      f.dataset.modele = String(r.id);
      el.value = '';
      champ.focus();
      return;
    }
    if (!el.dataset || !el.dataset.champ) return;
    admin('POST', `/api/admin/support/demandes/${el.dataset.n}`, { [el.dataset.champ]: el.value || null })
      .then(() => { message('Demande mise à jour.'); return chargerSupport(); }).catch(err => { echec(err); actualiser().catch(() => {}); });
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
