'use strict';
/* Journal d'audit chaîné : qui a fait quoi, quand, sur quel socle ou quel
   compte. Une ligne JSON par événement, un fichier par mois
   (donnees/audit/AAAA-MM.ndjson), conservé 12 mois.

   Chaque ligne porte l'empreinte (SHA-256) de la précédente et la sienne :
   une ligne modifiée, retirée ou insérée se voit à la vérification, qui
   repart de la plus ancienne ligne conservée (son « ancre »). Une fin de
   journal coupée pendant que le serveur tourne se voit aussi (la tête de
   chaîne est gardée en mémoire). Contre quelqu'un qui réécrirait tout le
   disque, noter la tête de chaîne ailleurs de temps en temps : elle est
   affichée par la console.

   Ce qui n'entre jamais ici : un mot de passe, un jeton, un code. Un compte
   apparaît sous une référence pseudonyme (« no…@exemple.fr #3f9a0c21b4 ») :
   l'adresse effacée avec le compte ne reste pas dans le journal, et une
   demande d'accès (RGPD) se retrouve en recalculant la référence. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ZERO = '0'.repeat(64);
const FICHIER = /^\d{4}-\d{2}\.ndjson$/;
const empreinte = e => crypto.createHash('sha256')
  .update(JSON.stringify([e.n, e.t, e.qui, e.action, e.cible, e.details, e.prec])).digest('hex');

// Dans le journal comme à l'écran : « no…@exemple.fr », jamais l'adresse entière.
const masquerEmail = e => String(e).replace(/^(.{0,2})[^@]*/, '$1…');
const empreinteCompte = login => crypto.createHash('sha256').update('compte:' + String(login).toLowerCase()).digest('hex').slice(0, 10);
const refCompte = login => `${masquerEmail(String(login).toLowerCase())} #${empreinteCompte(login)}`;

class Audit {
  constructor(dossier, { retentionMois = 12, maintenant = () => Date.now() } = {}) {
    this.dossier = path.join(dossier, 'audit');
    this.retentionMois = retentionMois;
    this.maintenant = maintenant;
    fs.mkdirSync(this.dossier, { recursive: true, mode: 0o700 });
    const d = this.derniere();
    this.n = d ? d.n : 0;
    this.tete = d ? d.h : ZERO;
  }

  fichiers() { return fs.readdirSync(this.dossier).filter(f => FICHIER.test(f)).sort(); }
  lignes(f) { return fs.readFileSync(path.join(this.dossier, f), 'utf8').split('\n').filter(Boolean); }

  derniere() {
    const liste = this.fichiers();
    for (let i = liste.length - 1; i >= 0; i--) {
      const l = this.lignes(liste[i]);
      if (!l.length) continue;
      try { return JSON.parse(l[l.length - 1]); } catch (e) { return null; }
    }
    return null;
  }

  // details : valeurs utiles à la relecture (avant/après, nombre, version…),
  // jamais un secret. Renvoie la ligne écrite.
  noter({ qui, action, cible = null, details = null }) {
    this.synchroniser();
    return this.ecrire({ qui, action, cible, details });
  }

  ecrire({ qui, action, cible, details }) {
    const t = new Date(this.maintenant());
    const e = { n: this.n + 1, t: t.toISOString(), qui: String(qui), action: String(action),
      cible: cible === null || cible === undefined ? null : String(cible), details: details || null, prec: this.tete };
    e.h = empreinte(e);
    fs.appendFileSync(path.join(this.dossier, `${e.t.slice(0, 7)}.ndjson`), JSON.stringify(e) + '\n', { mode: 0o600 });
    this.n = e.n;
    this.tete = e.h;
    return e;
  }

  // La ligne de commande (« utilisateur admin … ») écrit aussi au journal,
  // serveur en marche : avant d'écrire, repartir de la vraie dernière ligne.
  // Si la tête connue n'est plus dans le journal, sa fin a été coupée : une
  // ligne le dit, puis la chaîne reprend.
  synchroniser() {
    const d = this.derniere();
    if (!d) return;                       // vide (ou tout purgé) : on repart de la tête connue
    if (d.h === this.tete) return;
    const attendue = this.tete;
    const connue = attendue === ZERO || this.lire({ limite: Infinity, filtre: e => e.h === attendue }).length > 0;
    this.n = d.n;
    this.tete = d.h;
    if (!connue) this.ecrire({ qui: 'serveur', action: 'audit.rupture', cible: null, details: { raison: 'fin du journal coupée', teteAttendue: attendue } });
  }

  // Du plus récent au plus ancien, filtré, au plus `limite` lignes.
  lire({ limite = 200, filtre = null } = {}) {
    const sortie = [];
    const liste = this.fichiers();
    for (let i = liste.length - 1; i >= 0 && sortie.length < limite; i--) {
      const l = this.lignes(liste[i]);
      for (let j = l.length - 1; j >= 0 && sortie.length < limite; j--) {
        let e;
        try { e = JSON.parse(l[j]); } catch (err) { continue; }
        if (!filtre || filtre(e)) sortie.push(e);
      }
    }
    return sortie;
  }

  // Tout le journal conservé, ligne à ligne, dans l'ordre.
  verifier() {
    let prec = null, n = 0, ancre = null, premier = null, dernier = null, numero = null, teteVue = this.tete === ZERO;
    for (const f of this.fichiers()) {
      const l = this.lignes(f);
      for (let j = 0; j < l.length; j++) {
        const ou = { fichier: f, ligne: j + 1 };
        let e;
        try { e = JSON.parse(l[j]); } catch (err) { return { ok: false, n, rupture: { ...ou, raison: 'ligne illisible' } }; }
        if (prec === null) { ancre = e.prec; premier = e.t; }
        else if (e.prec !== prec || e.n !== numero + 1) return { ok: false, n, rupture: { ...ou, raison: 'chaînage rompu : une ligne a été retirée ou insérée' } };
        if (empreinte(e) !== e.h) return { ok: false, n, rupture: { ...ou, raison: 'ligne modifiée' } };
        if (e.h === this.tete || e.prec === this.tete) teteVue = true;
        prec = e.h; numero = e.n; n++; dernier = e.t;
      }
    }
    // Tête gardée en mémoire : une fin coupée (ou un journal vidé) pendant que
    // le serveur tourne se voit. Après une purge complète, le vide est normal.
    if (n ? !teteVue : (this.tete !== ZERO && !this.toutPurge)) {
      return { ok: false, n, rupture: { fichier: null, ligne: null, raison: n ? 'fin du journal coupée' : 'journal vidé' } };
    }
    return { ok: true, n, ancre, premier, dernier, tete: prec || this.tete, depuisOrigine: ancre === null || ancre === ZERO };
  }

  // Les mois au-delà de la conservation partent en entier.
  purger() {
    const borne = new Date(this.maintenant());
    borne.setUTCDate(1);
    borne.setUTCMonth(borne.getUTCMonth() - this.retentionMois);
    const mois = borne.toISOString().slice(0, 7);
    let n = 0;
    for (const f of this.fichiers()) if (f.slice(0, 7) < mois) { fs.unlinkSync(path.join(this.dossier, f)); n++; }
    if (n && !this.fichiers().length) this.toutPurge = true;
    return n;
  }
}

module.exports = { Audit, refCompte, empreinteCompte, masquerEmail, ZERO };
