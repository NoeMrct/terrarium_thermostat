'use strict';
/* Historique continu des mesures : un fichier NDJSON par socle et par jour
   (donnees/historique/<id>/<AAAA-MM-JJ>.ndjson), un point par minute et par
   socle au plus, même format que le socle (epoch, t1, consigne1, t2, consigne2
   en centièmes de degré). Pas de base de données : des fichiers texte que l'on
   peut lire, sauvegarder et purger avec les outils du système. */

const fs = require('fs');
const path = require('path');

const NB_ZONES = 2;

class Historique {
  constructor(dossier, options = {}) {
    this.dossier = path.join(dossier, 'historique');
    this.pasMs = options.pasMs || 60000;
    this.retentionJours = options.retentionJours || 400;
    this.courant = {};          // id -> { zones: [ {t, c} ], depuis }
    this.derniere = {};         // id -> epoch du dernier point écrit
  }

  // Un état de zone reçu : agrégé, puis écrit quand le pas est écoulé.
  noterZone(id, zone, etat) {
    if (!/^terra[0-9A-Za-z]{6}$/.test(id) || !(zone >= 0 && zone < NB_ZONES)) return;
    const c = this.courant[id] || (this.courant[id] = { zones: [], depuis: Date.now() });
    const t = Number(etat.temp), cons = Number(etat.consigne);
    c.zones[zone] = { t: isFinite(t) ? Math.round(t * 100) : null, c: isFinite(cons) ? Math.round(cons * 100) : null };
    const maintenant = Date.now();
    if (maintenant - (this.derniere[id] || 0) >= this.pasMs) this.ecrire(id, Math.floor(maintenant / 1000));
  }

  ecrire(id, epoch) {
    const c = this.courant[id];
    if (!c || !c.zones.some(z => z)) return;
    const point = [epoch];
    for (let z = 0; z < NB_ZONES; z++) point.push(c.zones[z] ? c.zones[z].t : null, c.zones[z] ? c.zones[z].c : null);
    const jour = new Date(epoch * 1000).toISOString().slice(0, 10);
    const d = path.join(this.dossier, id);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, jour + '.ndjson'), JSON.stringify(point) + '\n');
    this.derniere[id] = epoch * 1000;
  }

  // Points entre deux instants, au pas demandé (secondes), au plus `maxi`.
  lire(id, depuis, jusqua, pas = 60, maxi = 5000) {
    if (!/^terra[0-9A-Za-z]{6}$/.test(id)) return [];
    const d = path.join(this.dossier, id);
    if (!fs.existsSync(d)) return [];
    const points = [];
    const premier = new Date(depuis * 1000).toISOString().slice(0, 10), dernier = new Date(jusqua * 1000).toISOString().slice(0, 10);
    const fichiers = fs.readdirSync(d).filter(f => f.endsWith('.ndjson')).sort().filter(f => f.slice(0, 10) >= premier && f.slice(0, 10) <= dernier);
    let dernierEpoch = -Infinity;
    for (const f of fichiers) {
      const lignes = fs.readFileSync(path.join(d, f), 'utf8').split('\n');
      for (const l of lignes) {
        if (!l) continue;
        let p; try { p = JSON.parse(l); } catch (e) { continue; }
        if (!Array.isArray(p) || p[0] < depuis || p[0] > jusqua) continue;
        if (p[0] - dernierEpoch < pas) continue;
        dernierEpoch = p[0];
        points.push(p);
        if (points.length >= maxi) return points;
      }
    }
    return points;
  }

  // Dernier point connu d'un socle (pour l'état de la flotte).
  dernierPoint(id) {
    const d = path.join(this.dossier, id);
    if (!fs.existsSync(d)) return null;
    const fichiers = fs.readdirSync(d).filter(f => f.endsWith('.ndjson')).sort();
    if (!fichiers.length) return null;
    const lignes = fs.readFileSync(path.join(d, fichiers[fichiers.length - 1]), 'utf8').trim().split('\n');
    try { return JSON.parse(lignes[lignes.length - 1]); } catch (e) { return null; }
  }

  socles() {
    if (!fs.existsSync(this.dossier)) return [];
    return fs.readdirSync(this.dossier).filter(f => /^terra[0-9A-Za-z]{6}$/.test(f));
  }

  // Supprime les fichiers plus vieux que la rétention. Renvoie le nombre effacé.
  purger(maintenant = Date.now()) {
    let n = 0;
    const limite = new Date(maintenant - this.retentionJours * 86400000).toISOString().slice(0, 10);
    for (const id of this.socles()) {
      const d = path.join(this.dossier, id);
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.ndjson') && f.slice(0, 10) < limite) { fs.unlinkSync(path.join(d, f)); n++; }
      }
    }
    return n;
  }
}

module.exports = { Historique };
