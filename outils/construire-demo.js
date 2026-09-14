#!/usr/bin/env node
/* =============================================================================
   Construit app/demo.html : un fichier unique, ouvrable d'un double-clic, qui
   fait tourner la VRAIE application avec un socle simulé embarqué.
   -----------------------------------------------------------------------------
   Le fichier est GÉNÉRÉ à partir de index.html, style.css et app.js : il ne peut
   donc pas diverger de l'application réelle. Seule la bibliothèque MQTT est
   remplacée par une imitation qui répond dans la page, ce qui évite d'avoir
   besoin d'un broker, d'un réseau, ou d'un serveur web.

     node construire-demo.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const lire = f => fs.readFileSync(path.join(APP, f), 'utf8');

// -------------------------------------------------------- le socle de démonstration
const FAUX_MQTT = `
/* =============================================================================
   Socle simulé, embarqué dans la page.
   Il imite un broker MQTT et un socle : mêmes sujets, mêmes messages, mêmes
   règles de validation que le firmware. L'application au-dessus n'est pas
   modifiée d'une ligne — elle ne sait pas qu'elle parle à une imitation.
   ============================================================================= */
(function () {
  const socles = {
    terraDEMO001: {
      nom: 'Terrarium du salon',
      enLigne: true,
      entretienFin: 0,
      alim: 3, saison: { active: false, delta: 5, descente: 21, plateau: 60, remontee: 21 },
      historique: [],
      zones: [
        { nom: 'Point chaud', consigneJour: 32, consigneNuit: 26, bande: 2, tempMax: 40,
          debutJour: 480, debutNuit: 1200, offset: 0, rampe: 45,
          temp: 30.6, defaut: null, demande: 0, chauffe: false, autotune: false },
        { nom: 'Zone fraîche', consigneJour: 28, consigneNuit: 24, bande: 2, tempMax: 40,
          debutJour: 480, debutNuit: 1200, offset: 0, rampe: 45,
          temp: 26.4, defaut: null, demande: 0, chauffe: false, autotune: false }
      ]
    },
    terraDEMO002: {
      nom: 'Terrarium du bureau',
      enLigne: true,
      entretienFin: 0,
      alim: 5, saison: { active: false, delta: 5, descente: 21, plateau: 60, remontee: 21 },
      historique: [],
      zones: [
        { nom: 'Point chaud', consigneJour: 34, consigneNuit: 27, bande: 2, tempMax: 42,
          debutJour: 420, debutNuit: 1260, offset: 0, rampe: 45,
          temp: 24.1, defaut: null, demande: 0, chauffe: false, autotune: true },
        { nom: 'Zone fraîche', consigneJour: 26, consigneNuit: 22, bande: 2, tempMax: 40,
          debutJour: 420, debutNuit: 1260, offset: 0, rampe: 45,
          temp: 25.8, defaut: 'SONDE', demande: 0, chauffe: false, autotune: false }
      ]
    }
  };

  const abonnements = [];
  const retenus = {};
  const ecouteurs = { message: [], connect: [], close: [], error: [], reconnect: [] };

  const correspond = (filtre, sujet) => {
    const f = filtre.split('/'), s = sujet.split('/');
    if (f.length !== s.length) return false;
    return f.every((p, i) => p === '+' || p === s[i]);
  };

  function publier(sujet, charge, retenir) {
    if (retenir) retenus[sujet] = charge;
    abonnements.forEach(f => {
      if (correspond(f, sujet))
        ecouteurs.message.forEach(cb => setTimeout(() => cb(sujet, Buffer_(charge)), 0));
    });
  }
  // L'application appelle charge.toString() : un objet minimal suffit.
  const Buffer_ = s => ({ toString: () => s });

  const zonesSimultanees = s => Math.max(1, Math.min(2, Math.floor((s.alim * 0.8) / (20 / 12))));

  function consigne(z) {
    const m = new Date().getHours() * 60 + new Date().getMinutes();
    const depuisJour = (m - z.debutJour + 1440) % 1440;
    const jour = depuisJour < ((z.debutNuit - z.debutJour + 1440) % 1440);
    return jour ? z.consigneJour : z.consigneNuit;
  }

  // Les mêmes bornes que reglagesValides() dans le firmware.
  function valider(z) {
    const e = m => { throw new Error(m); };
    if (!(z.consigneJour >= 10 && z.consigneJour <= 45)) e('Consigne de jour hors 10-45 C');
    if (!(z.consigneNuit >= 10 && z.consigneNuit <= 45)) e('Consigne de nuit hors 10-45 C');
    if (z.tempMax <= z.consigneJour || z.tempMax <= z.consigneNuit)
      e('Le seuil max doit rester au-dessus des consignes');
  }

  function pas(id) {
    const s = socles[id];
    if (!s.enLigne) return;
    const entretien = s.entretienFin > Date.now();
    const actives = s.zones
      .map((z, i) => ({ z, i }))
      .filter(({ z }) => !z.defaut && !entretien && z.demande > 0.01)
      .sort((a, b) => b.z.demande - a.z.demande)
      .slice(0, zonesSimultanees(s));
    s.zones.forEach(z => { z.chauffe = false; });
    actives.forEach(({ z }) => { z.chauffe = true; });
    s.zones.forEach(z => {
      const c = consigne(z);
      z.demande = (z.defaut || entretien) ? 0 : Math.max(0, Math.min(1, (c - z.temp) / z.bande));
      z.temp += ((z.chauffe ? 0.09 : 0) - 0.004 * (z.temp - 21)) + (Math.random() - 0.5) * 0.02;
    });
  }

  // Douze heures d'historique déjà là : une démonstration qui montre un
  // graphique vide n'en est pas une.
  function amorcerHistorique(id) {
    const s = socles[id];
    const maintenant = Math.floor(Date.now() / 1000);
    for (let i = 720; i >= 0; i--) {
      const t = maintenant - i * 60;
      const heure = new Date(t * 1000).getHours() + new Date(t * 1000).getMinutes() / 60;
      s.historique.push([t, ...s.zones.flatMap(z => {
        const c = consigne(z);
        const ecart = Math.sin(heure / 3.8 + z.debutJour) * 0.7 + (Math.random() - 0.5) * 0.25;
        return [Math.round((c + ecart) * 100), Math.round(c * 100)];
      })]);
    }
  }

  function enregistrerPoint(id) {
    const s = socles[id];
    s.historique.push([Math.floor(Date.now() / 1000),
      ...s.zones.flatMap(z => [Math.round(z.temp * 100), Math.round(consigne(z) * 100)])]);
    if (s.historique.length > 2000) s.historique.shift();
  }

  function publierEtat(id) {
    const s = socles[id];
    s.zones.forEach((z, i) => {
      publier(\`terrarium/\${id}/zone\${i + 1}/etat\`, JSON.stringify({
        temp: +z.temp.toFixed(2), consigne: +consigne(z).toFixed(2),
        demande: Math.round(z.demande * 100), charge: Math.round(z.demande * 100),
        chauffe: z.chauffe ? '1' : '0', defaut: z.defaut ? '1' : '0',
        defaut_libelle: z.defaut || 'OK',
        jour: z.consigneJour, nuit: z.consigneNuit
      }), true);
    });
  }

  function traiter(id, texte) {
    const s = socles[id];
    let d; try { d = JSON.parse(texte); } catch (e) { return; }
    const rep = (ok, corps) =>
      publier(\`terrarium/\${id}/reponse\`, JSON.stringify({ req: d.req, ok, ...corps }), false);

    if (!s.enLigne) return;                       // un socle éteint ne répond pas
    const lecture = ['etat', 'version', 'stats', 'historique'].includes(d.action);
    if (!lecture && d.jeton !== 'DEMONSTRATION0000000001') return rep(false, { erreur: 'jeton invalide' });

    switch (d.action) {
      case 'version': return rep(true, { version: '3.2.0-demo', compile: 'demonstration' });
      case 'etat': return rep(true, {
        zones: s.zones.map(z => ({
          nom: z.nom, temp: +z.temp.toFixed(2), consigne: +consigne(z).toFixed(2),
          demande: Math.round(z.demande * 100), charge: Math.round(z.demande * 100),
          chauffe: z.chauffe, autotune: z.autotune, derive: false, defaut: z.defaut,
          jour: z.consigneJour, nuit: z.consigneNuit, bande: z.bande, max: z.tempMax,
          offset: z.offset, rampe: z.rampe, debutJour: z.debutJour, debutNuit: z.debutNuit
        })),
        uptime: 128400,
        entretienS: Math.max(0, Math.floor((s.entretienFin - Date.now()) / 1000)),
        zonesSimultanees: zonesSimultanees(s), saison: 0, alertesEnAttente: 0
      });
      case 'stats': return rep(true, {
        version: '3.2.0-demo', compile: 'demonstration',
        zonesSimultanees: zonesSimultanees(s), saison: 0, maintenanceRestanteS: 0,
        zones: s.zones.map(z => ({
          nom: z.nom, min: +(z.temp - 1.4).toFixed(2), max: +(z.temp + 1.1).toFixed(2),
          moyenne: +z.temp.toFixed(2), horsPlagePct: 6, points: s.historique.length,
          heuresChauffe: 41.2, kWh: 0.82,
          defauts: { sonde: z.defaut === 'SONDE' ? 1 : 0, surchauffe: 0, figee: 0 }
        }))
      });
      case 'historique': {
        const heures = (d.heures >= 1 && d.heures <= 400) ? d.heures : 24;
        const maxi   = (d.max >= 1 && d.max <= 200) ? d.max : 120;
        const depuis = Math.floor(Date.now() / 1000) - heures * 3600;
        const dans   = s.historique.filter(p => p[0] >= depuis);
        const pasEch = dans.length > maxi ? Math.ceil(dans.length / maxi) : 1;
        return rep(true, {
          format: ['epoch', 't1', 'consigne1', 't2', 'consigne2'],
          unite: 'centiemes de degre', pas: pasEch, heures,
          points: dans.filter((_, i) => i % pasEch === 0).slice(0, maxi)
        });
      }
      case 'globaux': {
        if (d.amperes !== undefined) {
          if (!(d.amperes >= 0.5 && d.amperes <= 40)) return rep(false, { erreur: 'amperage hors 0.5-40 A' });
          s.alim = d.amperes;
        }
        if (d.saisonDelta !== undefined) {
          if (!(d.saisonDelta >= 0 && d.saisonDelta <= 15))
            return rep(false, { erreur: 'Abaissement saisonnier hors 0-15 C' });
          s.saison.delta = d.saisonDelta;
        }
        if (d.saisonDescenteJ !== undefined) s.saison.descente = d.saisonDescenteJ;
        if (d.saisonPlateauJ  !== undefined) s.saison.plateau  = d.saisonPlateauJ;
        if (d.saisonRemonteeJ !== undefined) s.saison.remontee = d.saisonRemonteeJ;
        if (d.saisonActive    !== undefined) s.saison.active   = !!d.saisonActive;
        return rep(true, {
          amperes: s.alim, watts: 20, volts: 12, zonesSimultanees: zonesSimultanees(s),
          entretienMin: 10, ecranVeilleMin: 10,
          saisonActive: s.saison.active, saisonDelta: s.saison.delta,
          saisonDescenteJ: s.saison.descente, saisonPlateauJ: s.saison.plateau,
          saisonRemonteeJ: s.saison.remontee,
          decalageActuel: s.saison.active ? -s.saison.delta : 0
        });
      }
      case 'stop-autotune':
        if (!s.zones[d.z]) return rep(false, { erreur: 'zone invalide' });
        s.zones[d.z].autotune = false;
        return rep(true, {});
      case 'effacer-historique':
        s.historique.length = 0;
        return rep(true, {});
      case 'redemarrer':
        return rep(true, {});
      case 'zone': {
        const z = s.zones[d.z];
        if (!z) return rep(false, { erreur: 'zone invalide' });
        const copie = { ...z };
        if (d.nom !== undefined) copie.nom = d.nom;
        if (d.jour !== undefined) copie.consigneJour = d.jour;
        if (d.nuit !== undefined) copie.consigneNuit = d.nuit;
        try { valider(copie); } catch (e) { return rep(false, { erreur: e.message }); }
        Object.assign(z, copie);
        publierEtat(id);
        return rep(true, {});
      }
      case 'reset':
        s.zones.forEach(z => { z.defaut = null; });
        publierEtat(id);
        return rep(true, {});
      case 'entretien': {
        const min = d.minutes === undefined ? 10 : d.minutes;
        if (min < 0 || min > 240) return rep(false, { erreur: 'duree hors 0-240 min' });
        s.entretienFin = min ? Date.now() + min * 60000 : 0;
        if (min) s.zones.forEach(z => { z.chauffe = false; z.demande = 0; });
        publierEtat(id);
        return rep(true, {});
      }
      case 'autotune':
        if (!s.zones[d.z]) return rep(false, { erreur: 'zone invalide' });
        s.zones[d.z].autotune = true;
        return rep(true, {});
      case 'alim': {
        if (!(d.amperes >= 0.5 && d.amperes <= 40)) return rep(false, { erreur: 'amperage hors 0.5-40 A' });
        s.alim = d.amperes;
        return rep(true, { zonesSimultanees: zonesSimultanees(s) });
      }
      default: return rep(false, { erreur: 'action inconnue' });
    }
  }

  // ------------------------------------------------- imitation de la bibliothèque
  window.mqtt = {
    connect() {
      const client = {
        connected: false,
        on(ev, cb) { (ecouteurs[ev] || (ecouteurs[ev] = [])).push(cb); return client; },
        subscribe(filtres) {
          (Array.isArray(filtres) ? filtres : [filtres]).forEach(f => {
            abonnements.push(f);
            Object.keys(retenus).forEach(sujet => {
              if (correspond(f, sujet))
                ecouteurs.message.forEach(cb => setTimeout(() => cb(sujet, Buffer_(retenus[sujet])), 0));
            });
          });
          return client;
        },
        publish(sujet, charge) {
          const m = /^terrarium\\/([^/]+)\\/cmd$/.exec(sujet);
          if (m && socles[m[1]]) setTimeout(() => traiter(m[1], charge), 250);
          return client;
        },
        end() { client.connected = false; return client; }
      };
      setTimeout(() => {
        client.connected = true;
        Object.keys(socles).forEach(id => {
          publier(\`terrarium/\${id}/statut\`, socles[id].enLigne ? 'en ligne' : 'hors ligne', true);
          publierEtat(id);
        });
        ecouteurs.connect.forEach(cb => cb());
      }, 400);
      return client;
    }
  };

  Object.keys(socles).forEach(amorcerHistorique);
  setInterval(() => Object.keys(socles).forEach(id => {
    pas(id); enregistrerPoint(id); publierEtat(id);
  }), 2000);

  // Bandeau de démonstration, et configuration pré-remplie pour ouvrir
  // directement sur la liste plutôt que sur l'écran de connexion.
  localStorage.setItem('terrarium.config.v1', JSON.stringify({
    broker: { url: 'wss://demonstration', user: '', pass: '', prefixe: 'terrarium' },
    socles: [
      { id: 'terraDEMO001', jeton: 'DEMONSTRATION0000000001', nom: 'Terrarium du salon' },
      { id: 'terraDEMO002', jeton: 'DEMONSTRATION0000000001', nom: 'Terrarium du bureau' }
    ]
  }));
})();
`;

const BANDEAU = `
<div id="bandeau-demo">
  Démonstration — socle simulé dans la page, aucun matériel ni broker.
  Les températures évoluent, les commandes fonctionnent.
</div>
<style>
#bandeau-demo{
  background:#2a2a1a; color:#eda; border:1px solid #554; border-radius:11px;
  padding:10px 13px; margin-bottom:12px; font-size:12.5px; line-height:1.45;
}
</style>
`;

// ------------------------------------------------------------------ assemblage
let html = lire('index.html');

// Tout est mis en ligne dans le fichier : ouvert en file://, aucune requête ne
// pourrait aboutir de toute façon.
html = html
  .replace('<link rel="stylesheet" href="style.css">', `<style>\n${lire('style.css')}\n</style>`)
  .replace('<link rel="manifest" href="manifest.json">', '')
  .replace('<link rel="icon" href="icone.svg">', '')
  .replace(/<!--[\s\S]*?-->\s*/, '')                       // commentaire sur la bibliotheque embarquee
  .replace('<script src="vendor/mqtt.min.js"></script>', `<script>${FAUX_MQTT}</script>`)
  .replace('<script src="app.js"></script>', `<script>\n${lire('app.js')}\n</script>`)
  .replace('<header id="entete">', `${BANDEAU}\n<header id="entete">`)
  .replace('<title>Terrariums</title>', '<title>Terrariums — démonstration</title>');

fs.writeFileSync(path.join(APP, 'demo.html'), html);
console.log(`app/demo.html écrit (${(html.length / 1024).toFixed(1)} Ko)`);
