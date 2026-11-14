/* =============================================================================
   service.js — l'onglet Service : ce que seule la page locale savait faire,
   à distance (protocole 4, firmware 3.5).
   -----------------------------------------------------------------------------
   Module importé à la demande, la première fois qu'on ouvre l'onglet : qui ne
   s'en sert jamais ne le télécharge pas. Il apporte ses textes (français et
   anglais) et ne touche au DOM que par les outils que l'application lui passe
   (peindre, esc…), donc sous la même politique de sécurité qu'elle.

   Sondes (inventaire, liaison, identification), essai de chauffe, calibration,
   rapport du jour, journal, résumés journaliers, alertes et surveillance,
   sauvegarde du socle. Rien de secret ne revient du socle : une adresse
   d'alerte s'écrit, seul son serveur s'affiche ; le Wi-Fi reste sur la page
   locale.
   ============================================================================= */

const TEXTES = {
  fr: {
    protoAncien: 'Ces outils demandent le firmware 3.5 (protocole 4). Mets le socle à jour depuis l\'onglet Appareil.',
    horsLigne: 'Le socle est hors ligne : ces outils reviennent avec lui.',
    chargement: 'Chargement…',
    sondes: 'Sondes', aideSondes: 'Chaque zone suit l\'adresse de sa sonde. Après avoir branché une sonde, relis le bus.',
    relire: 'Relire le bus', aucuneSonde: 'Aucune sonde sur le bus.', libre: 'libre', zone: 'Zone {n}',
    lier: 'Lier', lierA: 'Lier {r} à', absente: 'absente du bus', parasite: 'Alimentation parasite détectée : préfère trois fils.',
    sansSonde: 'Zone {n} : aucune sonde liée', lieeA: 'Zone {n} : {r}',
    identifier: 'Identifier la zone {n}',
    identEnCours: 'Zone {z} : serre sa sonde dans la main — encore {s} s. La chauffe est suspendue.',
    annuler: 'Annuler', resultat: 'Dernier résultat : {r}',
    essai: 'Essai de chauffe',
    aideEssai: 'Une zone chauffe seule, à pleine puissance, jusqu\'à ce que sa sonde gagne 0,5 °C (10 min au plus). Reste à côté.',
    essaiZone: 'Essai zone {n}', essaiEnCours: 'Zone {z} en essai — encore {s} s.', arreter: 'Arrêter',
    confirmEssai: 'La zone {n} va chauffer seule à pleine puissance, 10 minutes au plus. Le tapis est-il bien en place ?',
    calibration: 'Calibration',
    aideCalib: 'Pose les deux sondes côte à côte quelques minutes : la zone 2 est alors alignée sur la zone 1.',
    calibrer: 'Aligner la zone 2 sur la zone 1',
    confirmCalib: 'Les deux sondes sont-elles côte à côte, au même endroit, depuis au moins 5 minutes ?',
    rapport: 'Rapport du jour', aideRapport: 'Le résumé que le socle envoie chaque jour avec les alertes, si le rapport est activé.',
    lire: 'Lire', envoyer: 'Envoyer maintenant',
    journal: 'Journal', aideJournal: 'Les derniers événements du socle (redémarrages, défauts, réglages modifiés).',
    afficher: 'Afficher', copier: 'Copier', copie: 'Journal copié.',
    jours: 'Résumés journaliers', aideJours: 'Les derniers jours, du plus récent au plus ancien.',
    chargerJours: 'Afficher les derniers jours',
    colJour: 'Jour', colZone: 'Zone', colMin: 'Min', colMax: 'Max', colMoy: 'Moy.', colChauffe: 'Chauffe', colKwh: 'kWh', colEuros: '€',
    aucunJour: 'Aucun résumé pour l\'instant : le premier s\'écrit à minuit.',
    surveillance: 'Alertes et surveillance',
    aideSurv: 'Le socle envoie ses alertes à cette adresse (ntfy, webhook). Elle n\'est jamais relue : seul son serveur s\'affiche ici.',
    alertesVers: 'Alertes envoyées à {h}', aucuneAlerte: 'Aucune adresse d\'alerte : le socle ne prévient personne.',
    heartbeatVers: 'Heartbeat vers {h}, toutes les {m} min', aucunHeartbeat: 'Pas de heartbeat.',
    nouvelleAlerte: 'Nouvelle adresse des alertes', nouveauHeartbeat: 'Nouvelle adresse du heartbeat',
    intervalle: 'Heartbeat toutes les (min)', format: 'Format des alertes',
    formatJson: 'JSON (serveur, Home Assistant)', formatTexte: 'Texte (ntfy)',
    videInchange: 'Vide : inchangée', effacerAdresses: 'Couper les alertes',
    confirmCouper: 'Le socle n\'enverra plus aucune alerte ni heartbeat. Continuer ?',
    wifi: 'Wi-Fi : {s}{s2}. Il se règle sur la page locale du socle, jamais à distance.', secours: ' (secours : {s})',
    enregistrer: 'Enregistrer', enregistre: 'Enregistré.',
    sauvegarde: 'Sauvegarde du socle',
    aideSauv: 'Zones, réglages et sondes, pour remplacer une carte en une minute. Ni mot de passe, ni adresse d\'alerte.',
    telecharger: 'Télécharger', restaurer: 'Restaurer…',
    confirmRestaurer: 'Remplacer les réglages du socle par ceux de « {f} » ? Tout ou rien : un seul réglage refusé et rien ne change.',
    fichierInvalide: 'Ce fichier n\'est pas une sauvegarde de socle.',
    oui: 'Continuer'
  },
  en: {
    protoAncien: 'These tools need firmware 3.5 (protocol 4). Update the base from the Device tab.',
    horsLigne: 'The base is offline: these tools come back with it.',
    chargement: 'Loading…',
    sondes: 'Probes', aideSondes: 'Each zone follows its probe\'s address. After plugging a probe in, rescan the bus.',
    relire: 'Rescan the bus', aucuneSonde: 'No probe on the bus.', libre: 'free', zone: 'Zone {n}',
    lier: 'Link', lierA: 'Link {r} to', absente: 'missing from the bus', parasite: 'Parasite power detected: prefer three wires.',
    sansSonde: 'Zone {n}: no probe linked', lieeA: 'Zone {n}: {r}',
    identifier: 'Identify zone {n}',
    identEnCours: 'Zone {z}: hold its probe in your hand — {s} s left. Heating is paused.',
    annuler: 'Cancel', resultat: 'Last result: {r}',
    essai: 'Heating test',
    aideEssai: 'One zone heats alone at full power until its probe gains 0.5 °C (10 min at most). Stay nearby.',
    essaiZone: 'Test zone {n}', essaiEnCours: 'Zone {z} under test — {s} s left.', arreter: 'Stop',
    confirmEssai: 'Zone {n} will heat alone at full power, 10 minutes at most. Is the mat in place?',
    calibration: 'Calibration',
    aideCalib: 'Put both probes side by side for a few minutes: zone 2 is then aligned with zone 1.',
    calibrer: 'Align zone 2 with zone 1',
    confirmCalib: 'Have both probes been side by side, in the same spot, for at least 5 minutes?',
    rapport: 'Daily report', aideRapport: 'The summary the base sends every day with its alerts, when the report is on.',
    lire: 'Read', envoyer: 'Send now',
    journal: 'Log', aideJournal: 'The base\'s latest events (restarts, faults, changed settings).',
    afficher: 'Show', copier: 'Copy', copie: 'Log copied.',
    jours: 'Daily summaries', aideJours: 'The latest days, most recent first.',
    chargerJours: 'Show the latest days',
    colJour: 'Day', colZone: 'Zone', colMin: 'Min', colMax: 'Max', colMoy: 'Avg', colChauffe: 'Heating', colKwh: 'kWh', colEuros: '€',
    aucunJour: 'No summary yet: the first one is written at midnight.',
    surveillance: 'Alerts and monitoring',
    aideSurv: 'The base sends its alerts to this address (ntfy, webhook). It is never read back: only its server shows here.',
    alertesVers: 'Alerts sent to {h}', aucuneAlerte: 'No alert address: the base warns nobody.',
    heartbeatVers: 'Heartbeat to {h}, every {m} min', aucunHeartbeat: 'No heartbeat.',
    nouvelleAlerte: 'New alert address', nouveauHeartbeat: 'New heartbeat address',
    intervalle: 'Heartbeat every (min)', format: 'Alert format',
    formatJson: 'JSON (server, Home Assistant)', formatTexte: 'Text (ntfy)',
    videInchange: 'Empty: unchanged', effacerAdresses: 'Turn alerts off',
    confirmCouper: 'The base will send no alert and no heartbeat anymore. Continue?',
    wifi: 'Wi-Fi: {s}{s2}. It is set on the base\'s local page, never remotely.', secours: ' (backup: {s})',
    enregistrer: 'Save', enregistre: 'Saved.',
    sauvegarde: 'Base backup',
    aideSauv: 'Zones, settings and probes, to replace a board in a minute. No password, no alert address.',
    telecharger: 'Download', restaurer: 'Restore…',
    confirmRestaurer: 'Replace the base\'s settings with those of “{f}”? All or nothing: a single refused setting and nothing changes.',
    fichierInvalide: 'This file is not a base backup.',
    oui: 'Continue'
  }
};

/**
 * @param {any} app outils de l'application : langue, esc, peindre, commander,
 *   message, confirmer, telecharger, lireFichier, icone, socleOuvert, etat
 */
export default function service(app) {
  const tx = (cle, p) => {
    const tab = TEXTES[app.langue()] || TEXTES.fr;
    let s = tab[cle] !== undefined ? tab[cle] : TEXTES.fr[cle];
    if (p) for (const [k, v] of Object.entries(p)) s = s.split('{' + k + '}').join(String(v));
    return s;
  };
  const esc = app.esc;
  /** @type {Record<string, any>} */
  const memoire = {};          // par socle : ce que le socle a rendu
  const m = id => memoire[id] || (memoire[id] = {});
  let suivi = null;            // relecture tant qu'une identification ou un essai court

  const btn = (sv, libelle, classe = 'btn btn-secondaire', extra = '') =>
    `<button type="button" class="${classe}" data-action="sv" data-sv="${sv}"${extra}>${libelle}</button>`;
  const romCourte = r => String(r || '').slice(-6);

  // Une action : la réponse est gardée, le message du socle affiché, la carte
  // repeinte. Les erreurs du socle (refus) arrivent en clair.
  async function faire(id, action, params, cle) {
    try {
      const r = await app.commander(id, action, params);
      if (cle) m(id)[cle] = r[cle] !== undefined ? r[cle] : r;
      if (r.message) app.message(r.message);
      return r;
    } catch (e) {
      app.message(e.message, true);
      return null;
    } finally {
      peindreTout();
    }
  }

  function relireEtat(id) {
    faire(id, 'sondes', {}, 'sondes');
    faire(id, 'essai', {}, 'essai');
  }

  // Tant qu'une identification ou un essai court, on relit toutes les 3 s ;
  // le suivi s'arrête de lui-même dès qu'on quitte l'onglet. Un minuteur à la
  // fois : les repeintures (à chaque message du socle) ne le repoussent pas.
  function suivre(id) {
    const d = m(id);
    const enCours = (d.sondes && d.sondes.identification) || (d.essai && d.essai.zone > 0);
    if (!enCours || app.socleOuvert() !== id || !app.ouvert()) { clearTimeout(suivi); suivi = null; return; }
    if (suivi) return;
    suivi = setTimeout(() => { suivi = null; relireEtat(id); }, 3000);
  }

  // ---------------------------------------------------------------- cartes
  function carteSondes(id, e) {
    const d = m(id).sondes;
    let h = `<h2>${tx('sondes')}</h2><p class="aide">${tx('aideSondes')}</p>`;
    if (!d) return h + `<p class="aide" aria-busy="true">${tx('chargement')}</p>`;
    const nbZones = (e.zones || []).length || 2;
    const liaisons = d.liaisons || [];
    h += '<ul class="liste-sondes">';
    for (let z = 0; z < nbZones; z++) {
      const l = liaisons[z];
      h += `<li><b>${l ? tx('lieeA', { n: z + 1, r: esc(l.rom) }) : tx('sansSonde', { n: z + 1 })}</b>${l && !l.presente ? ` <span class="badge warn">${tx('absente')}</span>` : ''}</li>`;
    }
    h += '</ul>';
    const sondes = d.sondes || [];
    if (!sondes.length) h += `<p class="aide">${tx('aucuneSonde')}</p>`;
    sondes.forEach((s, i) => {
      const options = [`<option value="">${tx('libre')}</option>`]
        .concat(Array.from({ length: nbZones }, (_, z) =>
          `<option value="${z}"${s.zone === z ? ' selected' : ''}>${tx('zone', { n: z + 1 })}</option>`)).join('');
      h += `<div class="rangee sonde">
        <div><label for="sv-z${i}">${tx('lierA', { r: '…' + esc(romCourte(s.rom)) })}
          <small class="discret">${s.temp === null || s.temp === undefined ? '—' : Number(s.temp).toFixed(1) + ' °C'}</small></label>
          <select id="sv-z${i}" data-rom="${esc(s.rom)}">${options}</select></div>
        <div class="bas">${btn('lier', tx('lier'), 'btn btn-secondaire', ` data-i="${i}"`)}</div>
      </div>`;
    });
    if (d.parasite) h += `<p class="aide">${tx('parasite')}</p>`;
    const id_ = d.identification;
    if (id_) {
      h += `<p class="aide" role="status">${tx('identEnCours', { z: id_.zone, s: id_.restantS })}</p>
        <div class="boutons">${btn('stop-identifier', tx('annuler'), 'btn btn-danger')}</div>`;
    } else {
      h += `<div class="boutons">${btn('relire', app.icone('i-reglages') + tx('relire'))}${Array.from({ length: nbZones }, (_, z) =>
        btn('identifier', tx('identifier', { n: z + 1 }), 'btn btn-secondaire', ` data-z="${z}"`)).join('')}</div>`;
    }
    if (d.resultat) h += `<p class="aide">${tx('resultat', { r: esc(d.resultat) })}</p>`;
    return h;
  }

  function carteEssai(id, e) {
    const d = m(id).essai;
    const nbZones = (e.zones || []).length || 2;
    let h = `<h2>${tx('essai')}</h2><p class="aide">${tx('aideEssai')}</p>`;
    if (d && d.zone > 0) {
      h += `<p class="aide" role="status">${tx('essaiEnCours', { z: d.zone, s: d.restantS })}</p>
        <div class="boutons">${btn('stop-essai', tx('arreter'), 'btn btn-danger')}</div>`;
    } else {
      h += `<div class="boutons">${Array.from({ length: nbZones }, (_, z) =>
        btn('essai', tx('essaiZone', { n: z + 1 }), 'btn btn-secondaire', ` data-z="${z}"`)).join('')}</div>`;
    }
    if (d && d.resultat) h += `<p class="aide">${tx('resultat', { r: esc(d.resultat) })}</p>`;
    h += `<h3 class="mt">${tx('calibration')}</h3><p class="aide">${tx('aideCalib')}</p>
      <div class="boutons">${btn('calibrer', tx('calibrer'))}</div>`;
    return h;
  }

  function carteRapport(id) {
    const d = m(id);
    return `<h2>${tx('rapport')}</h2><p class="aide">${tx('aideRapport')}</p>
      ${d.texte ? `<pre class="bloc-texte" tabindex="0">${esc(d.texte)}</pre>` : ''}
      <div class="boutons">${btn('rapport', tx('lire'))}${btn('envoyerRapport', tx('envoyer'))}</div>`;
  }

  function carteJournal(id) {
    const d = m(id);
    return `<h2>${tx('journal')}</h2><p class="aide">${tx('aideJournal')}</p>
      ${d.journal ? `<pre class="bloc-texte journal" tabindex="0">${esc(d.journal)}</pre>` : ''}
      <div class="boutons">${btn('journal', tx('afficher'))}${d.journal ? btn('copierJournal', tx('copier')) : ''}</div>`;
  }

  function carteJours(id) {
    const d = m(id).jours;
    let h = `<h2>${tx('jours')}</h2><p class="aide">${tx('aideJours')}</p>`;
    if (d) {
      const jours = d.jours || [];
      if (!jours.length) h += `<p class="aide">${tx('aucunJour')}</p>`;
      else {
        const n1 = v => (v === null || v === undefined) ? '—' : Number(v).toFixed(1);
        const n2 = v => (v === null || v === undefined) ? '—' : Number(v).toFixed(2);
        h += `<div class="tableau-defile" tabindex="0"><table class="tableau"><thead><tr>
          <th scope="col">${tx('colJour')}</th><th scope="col">${tx('colZone')}</th><th scope="col">${tx('colMin')}</th>
          <th scope="col">${tx('colMax')}</th><th scope="col">${tx('colMoy')}</th><th scope="col">${tx('colChauffe')}</th>
          <th scope="col">${tx('colKwh')}</th>${d.prixKwh ? `<th scope="col">${tx('colEuros')}</th>` : ''}</tr></thead><tbody>`;
        jours.forEach(j => (j.zones || []).forEach((z, i) => {
          h += `<tr${z.defauts ? ' class="avec-defaut"' : ''}>${i === 0 ? `<th scope="row" rowspan="${j.zones.length}">${esc(j.date)}</th>` : ''}
            <td>${i + 1}</td><td>${n1(z.min)}</td><td>${n1(z.max)}</td><td>${n1(z.moyenne)}</td>
            <td>${z.heures === null || z.heures === undefined ? '—' : n1(z.heures) + ' h'}</td><td>${n2(z.kWh)}</td>${d.prixKwh ? `<td>${n2(z.euros)}</td>` : ''}</tr>`;
        }));
        h += '</tbody></table></div>';
      }
    }
    return h + `<div class="boutons">${btn('jours', tx('chargerJours'))}</div>`;
  }

  function carteSurveillance(id) {
    const r = m(id).reseau;
    let h = `<h2>${tx('surveillance')}</h2><p class="aide">${tx('aideSurv')}</p>`;
    if (!r) return h + `<p class="aide" aria-busy="true">${tx('chargement')}</p>`;
    h += `<p><b>${r.alertes ? tx('alertesVers', { h: esc(r.alertes) }) : tx('aucuneAlerte')}</b></p>
      <p class="aide">${r.heartbeat ? tx('heartbeatVers', { h: esc(r.heartbeat), m: r.heartbeatMinutes }) : tx('aucunHeartbeat')}</p>
      <form class="pile" data-form="sv-surveillance">
        <div><label for="sv-ua">${tx('nouvelleAlerte')}</label>
          <input id="sv-ua" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="160" placeholder="${tx('videInchange')}"></div>
        <div><label for="sv-uh">${tx('nouveauHeartbeat')}</label>
          <input id="sv-uh" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="160" placeholder="${tx('videInchange')}"></div>
        <div class="rangee">
          <div><label for="sv-hm">${tx('intervalle')}</label><input id="sv-hm" inputmode="numeric" value="${esc(r.heartbeatMinutes)}"></div>
          <div><label for="sv-fa">${tx('format')}</label><select id="sv-fa">
            <option value="0"${r.formatAlertes === 0 ? ' selected' : ''}>${tx('formatJson')}</option>
            <option value="1"${r.formatAlertes === 1 ? ' selected' : ''}>${tx('formatTexte')}</option></select></div>
        </div>
        <div class="boutons"><button class="btn" type="submit">${tx('enregistrer')}</button>
          ${r.alertes || r.heartbeat ? btn('couperAlertes', tx('effacerAdresses'), 'btn btn-danger') : ''}</div>
      </form>
      <p class="aide">${tx('wifi', { s: esc(r.ssid || '—'), s2: r.ssid2 ? tx('secours', { s: esc(r.ssid2) }) : '' })}</p>`;
    return h;
  }

  function carteSauvegarde() {
    return `<h2>${tx('sauvegarde')}</h2><p class="aide">${tx('aideSauv')}</p>
      <div class="boutons">${btn('telechargerSauvegarde', tx('telecharger'))}${btn('restaurer', tx('restaurer'))}
        <input type="file" id="sv-fichier" accept="application/json,.json" hidden></div>`;
  }

  /** @type {Array<[string, (id: string, e: any) => string]>} */
  const CARTES = [['sondes', carteSondes], ['essai', carteEssai], ['surv', carteSurveillance],
                  ['rapport', carteRapport], ['journal', carteJournal], ['jours', carteJours], ['sauv', carteSauvegarde]];

  function peindreTout() {
    const id = app.socleOuvert();
    const racine = app.racine();
    if (!id || !racine || !app.ouvert()) return;
    const e = app.etat(id) || {};
    if (!(e.proto >= 4) || !e.enLigne) return;
    CARTES.forEach(([cle, f]) => app.peindre(racine.querySelector(`[data-sv-carte="${cle}"]`), f(id, e)));
    suivre(id);
  }

  return {
    // L'ossature de l'onglet ; les cartes se remplissent ensuite.
    structure(s, e) {
      if (!e.enLigne) return `<section class="carte"><p class="aide">${tx('horsLigne')}</p></section>`;
      if (!(e.proto >= 4)) return `<section class="carte"><p class="aide">${tx('protoAncien')}</p></section>`;
      const d = m(s.id);
      if (!d.lu) {        // première ouverture : ce qui est léger à lire
        d.lu = true;
        relireEtat(s.id);
        faire(s.id, 'reseau', {}, 'reseau');
      }
      return CARTES.map(([cle]) => `<section class="carte" data-sv-carte="${cle}"></section>`).join('');
    },

    patcher: peindreTout,

    async clic(nom, el) {
      const id = app.socleOuvert();
      if (!id) return;
      const d = m(id);
      const z = el.dataset.z !== undefined ? +el.dataset.z : undefined;
      switch (nom) {
        case 'relire': return faire(id, 'sondes', { relire: true }, 'sondes');
        case 'lier': {
          const sel = /** @type {any} */ (app.racine().querySelector(`#sv-z${el.dataset.i}`));
          if (!sel || sel.value === '') return undefined;
          await faire(id, 'lier', { z: +sel.value, rom: sel.dataset.rom });
          return faire(id, 'sondes', {}, 'sondes');
        }
        case 'identifier':
          await faire(id, 'identifier', { z });
          return faire(id, 'sondes', {}, 'sondes');
        case 'stop-identifier':
          await faire(id, 'stop-identifier', {});
          return faire(id, 'sondes', {}, 'sondes');
        case 'essai':
          if (!await app.confirmer({ titre: tx('essai'), texte: tx('confirmEssai', { n: z + 1 }), ok: tx('oui') })) return undefined;
          await faire(id, 'essai', { z });
          return faire(id, 'essai', {}, 'essai');
        case 'stop-essai':
          await faire(id, 'stop-essai', {});
          return faire(id, 'essai', {}, 'essai');
        case 'calibrer':
          if (!await app.confirmer({ titre: tx('calibration'), texte: tx('confirmCalib'), ok: tx('calibrer') })) return undefined;
          return faire(id, 'calibrer', {});
        case 'rapport': return faire(id, 'rapport', {}, 'texte');
        case 'envoyerRapport': return faire(id, 'rapport', { envoyer: true });
        case 'journal': {
          const r = await faire(id, 'journal', {});
          if (r) { d.journal = r.texte; peindreTout(); }
          return r;
        }
        case 'copierJournal':
          try { await navigator.clipboard.writeText(d.journal || ''); app.message(tx('copie')); }
          catch (e) { app.message(e.message, true); }
          return undefined;
        case 'jours': return faire(id, 'jours', { n: 31 }, 'jours');
        case 'couperAlertes': {
          if (!await app.confirmer({ titre: tx('surveillance'), texte: tx('confirmCouper'), ok: tx('effacerAdresses'), danger: true })) return undefined;
          const r = await faire(id, 'reseau', { urlAlertes: '', urlHeartbeat: '' }, 'reseau');
          if (r) app.message(tx('enregistre'));
          return r;
        }
        case 'telechargerSauvegarde': {
          const r = await faire(id, 'sauvegarde', {});
          if (r && r.sauvegarde) app.telecharger(`sauvegarde-${id}.json`, JSON.stringify(r.sauvegarde, null, 2) + '\n', 'application/json');
          return r;
        }
        case 'restaurer': {
          const f = /** @type {any} */ (app.racine().querySelector('#sv-fichier'));
          if (f) f.click();
          return undefined;
        }
      }
      return undefined;
    },

    async soumettre(form) {
      const id = app.socleOuvert();
      if (!id || form.dataset.form !== 'sv-surveillance') return;
      const racine = app.racine();
      const val = sel => String(/** @type {any} */ (racine.querySelector(sel)).value || '').trim();
      /** @type {Record<string, any>} */
      const p = { heartbeatMinutes: parseInt(val('#sv-hm'), 10), formatAlertes: +val('#sv-fa') };
      if (val('#sv-ua')) p.urlAlertes = val('#sv-ua');
      if (val('#sv-uh')) p.urlHeartbeat = val('#sv-uh');
      const r = await faire(id, 'reseau', p, 'reseau');
      if (!r) return;
      // Une adresse enregistrée ne reste pas affichée : elle ne se relit plus.
      ['#sv-ua', '#sv-uh'].forEach(sel => { const el = /** @type {any} */ (racine.querySelector(sel)); if (el) el.value = ''; });
      app.message(tx('enregistre'));
    },

    async fichier(f) {
      const id = app.socleOuvert();
      if (!id || !f) return;
      let sauvegarde;
      try { sauvegarde = JSON.parse(await app.lireFichier(f)); } catch (e) { sauvegarde = null; }
      if (!sauvegarde || sauvegarde.format !== 'terrarium-sauvegarde') { app.message(tx('fichierInvalide'), true); return; }
      if (!await app.confirmer({ titre: tx('sauvegarde'), texte: tx('confirmRestaurer', { f: f.name }), ok: tx('oui'), danger: true })) return;
      await faire(id, 'restaurer', { sauvegarde });
      relireEtat(id);
    },

    // Socle oublié ou rechargé : ce qui a été lu ne vaut plus.
    oublier(id) { delete memoire[id]; }
  };
}
