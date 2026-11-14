'use strict';
/* Événements d'un socle vus par le serveur : en ligne, hors ligne,
   redémarrage, défaut, trop chaud, dérive, rétabli, étape de mise à jour.
   Une ligne JSON par événement, un fichier par socle et par mois
   (donnees/evenements/<id>/AAAA-MM.ndjson), gardés aussi longtemps que
   l'historique des températures. C'est la matière de la frise du support et
   des alertes proactives de la console. */

const fs = require('fs');
const path = require('path');

const ID = /^terra[0-9A-Za-z]{6}$/;
const FICHIER = /^\d{4}-\d{2}\.ndjson$/;

class Evenements {
  constructor(dossier, { retentionJours = 400, maintenant = () => Date.now() } = {}) {
    this.dossier = path.join(dossier, 'evenements');
    this.retentionJours = retentionJours;
    this.maintenant = maintenant;
  }

  noter(id, type, details = {}) {
    if (!ID.test(id)) return null;
    const t = new Date(this.maintenant()).toISOString();
    const e = { t, type, ...details };
    const d = path.join(this.dossier, id);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, `${t.slice(0, 7)}.ndjson`), JSON.stringify(e) + '\n');
    return e;
  }

  // Du plus récent au plus ancien ; `depuis` (ISO) borne le passé.
  lire(id, { depuis = null, limite = 200 } = {}) {
    if (!ID.test(id)) return [];
    const d = path.join(this.dossier, id);
    let fichiers;
    try { fichiers = fs.readdirSync(d).filter(f => FICHIER.test(f)).sort().reverse(); } catch (e) { return []; }
    const sortie = [];
    for (const f of fichiers) {
      if (depuis && f.slice(0, 7) < depuis.slice(0, 7)) break;
      const lignes = fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).reverse();
      for (const l of lignes) {
        let e;
        try { e = JSON.parse(l); } catch (err) { continue; }
        if (depuis && e.t < depuis) return sortie;
        sortie.push(e);
        if (sortie.length >= limite) return sortie;
      }
    }
    return sortie;
  }

  supprimer(id) {
    if (!ID.test(id)) return;
    fs.rmSync(path.join(this.dossier, id), { recursive: true, force: true });
  }

  purger() {
    const borne = new Date(this.maintenant() - this.retentionJours * 86400000).toISOString().slice(0, 7);
    let n = 0, socles;
    try { socles = fs.readdirSync(this.dossier).filter(x => ID.test(x)); } catch (e) { return 0; }
    for (const id of socles) {
      for (const f of fs.readdirSync(path.join(this.dossier, id)).filter(x => FICHIER.test(x))) {
        if (f.slice(0, 7) < borne) { fs.unlinkSync(path.join(this.dossier, id, f)); n++; }
      }
    }
    return n;
  }
}

module.exports = { Evenements };
