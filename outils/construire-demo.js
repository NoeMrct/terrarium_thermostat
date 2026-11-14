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

  // Protocole 4 : sondes, essai, surveillance et journal du socle simulé.
  function f1(s) {
    if (!s.f1) {
      const presentes = ['28FF4C1D61160301', '28FF9A0362160417'];
      s.f1 = { presentes, liaisons: presentes.slice(), ident: null, identResultat: '',
        essai: { zone: 0, fin: 0, resultat: '' },
        reseau: { urlAlertes: 'https://ntfy.sh/exemple-demo', urlHeartbeat: '', heartbeatMinutes: 5, formatAlertes: 1 },
        journal: ['08:00:02 Demarrage (mise sous tension), firmware 3.5.0', '08:00:05 Wi-Fi connecte', '08:00:07 MQTT connecte'],
        g: { prixKwh: 0.2516, rapportActif: true, rapportMinutes: 1200, ledEteinte: false, ecranNuit: 0, soleilActif: false,
          soleilDecalageMin: 0, latitude: 0, longitude: 0, zonePrioritaire: 0 } };
    }
    return s.f1;
  }
  function noter(s, texte) {
    const j = f1(s).journal;
    j.push(new Date().toTimeString().slice(0, 8) + ' ' + texte);
    if (j.length > 60) j.shift();
  }

  // Santé du socle : ce que publie un firmware 3.5 sur <id>/sante.
  const majs = {};
  const sante = id => ({ proto: 4, version: '3.5.0-demo', uptime: 128400 + Math.floor((Date.now() - debut) / 1000),
    rssi: id === 'terraDEMO001' ? -58 : -76, heap: 171000, heapMin: 142000, blocMax: 98000,
    reset: 'mise sous tension', otaEnAttente: false, hote: id + '.local', ip: id === 'terraDEMO001' ? '192.168.1.41' : '192.168.1.42',
    ...(majs[id] ? { maj: majs[id] } : {}) });
  const debut = Date.now();

  function publierEtat(id) {
    const s = socles[id];
    publier(\`terrarium/\${id}/sante\`, JSON.stringify(sante(id)), true);
    s.zones.forEach((z, i) => {
      publier(\`terrarium/\${id}/zone\${i + 1}/etat\`, JSON.stringify({
        temp: +z.temp.toFixed(2), consigne: +consigne(z).toFixed(2),
        demande: Math.round(z.demande * 100), charge: Math.round(z.demande * 100),
        chauffe: z.chauffe ? '1' : '0', defaut: z.defaut ? '1' : '0',
        defaut_libelle: z.defaut || 'OK',
        autotune: z.autotune ? '1' : '0', derive: '0', trop_chaud: '0',
        jour: z.consigneJour, nuit: z.consigneNuit
      }), true);
    });
  }

  function traiter(id, texte) {
    const s = socles[id];
    let d; try { d = JSON.parse(texte); } catch (e) { return; }
    // Protocole 4 : commande signée {"c": "<commande>", "sig": "…"}. La
    // démonstration n'a pas de secret à défendre : elle lit la commande.
    if (typeof d.c === 'string') { try { d = JSON.parse(d.c); d.jeton = 'DEMONSTRATION0000000001'; } catch (e) { return; } }
    const rep = (ok, corps) =>
      publier(\`terrarium/\${id}/reponse\`, JSON.stringify({ req: d.req, ok, ...corps }), false);

    if (!s.enLigne) return;                       // un socle éteint ne répond pas
    const lecture = ['etat', 'version', 'stats', 'historique'].includes(d.action);
    if (!lecture && d.jeton !== 'DEMONSTRATION0000000001') return rep(false, { erreur: 'jeton invalide' });

    switch (d.action) {
      case 'version': return rep(true, { version: '3.5.0-demo', compile: 'demonstration', proto: 4 });
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
        zonesSimultanees: zonesSimultanees(s), saison: 0, alertesEnAttente: 0,
        proto: 4, sante: sante(id)
      });
      case 'stats': return rep(true, {
        version: '3.5.0-demo', compile: 'demonstration',
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
        const g = f1(s).g;
        const g2 = Object.assign({}, g);
        ['prixKwh', 'rapportActif', 'rapportMinutes', 'ledEteinte', 'ecranNuit', 'soleilActif', 'soleilDecalageMin',
         'latitude', 'longitude', 'zonePrioritaire'].forEach(k => { if (d[k] !== undefined) g2[k] = d[k]; });
        if (g2.soleilActif && !g2.latitude && !g2.longitude) return rep(false, { erreur: 'Position inconnue : renseigner latitude et longitude' });
        if (!(g2.prixKwh >= 0 && g2.prixKwh <= 5)) return rep(false, { erreur: 'Prix du kWh hors 0-5 EUR' });
        if (!(g2.ecranNuit >= 0 && g2.ecranNuit <= 2)) return rep(false, { erreur: "Mode nuit de l'ecran inconnu" });
        if (!(g2.latitude >= -65 && g2.latitude <= 65)) return rep(false, { erreur: 'Latitude hors -65..65' });
        if (!(g2.soleilDecalageMin >= -180 && g2.soleilDecalageMin <= 180)) return rep(false, { erreur: 'Decalage solaire hors -180..180 min' });
        Object.assign(g, g2);
        return rep(true, Object.assign({}, g, {
          amperes: s.alim, watts: 20, volts: 12, zonesSimultanees: zonesSimultanees(s),
          entretienMin: 10, ecranVeilleMin: 10,
          saisonActive: s.saison.active, saisonDelta: s.saison.delta,
          saisonDescenteJ: s.saison.descente, saisonPlateauJ: s.saison.plateau,
          saisonRemonteeJ: s.saison.remontee,
          decalageActuel: s.saison.active ? -s.saison.delta : 0
        }));
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
      case 'maj': {
        // Mise à jour tirée, simulée : progression puis « redémarrage » et santé.
        const cible = d.version || ((d.url || '').match(/v([0-9]+[.][0-9]+[.][0-9]+)/) || [])[1] || '?';
        if (!d.url && !d.version) return rep(false, { erreur: 'url ou version attendue' });
        if (d.version === '3.5.0' && !d.forcer) return rep(false, { erreur: 'deja en 3.5.0' });
        rep(true, { maj: 'telechargement' });
        majs[id] = { etape: 'en validation', version: cible, detail: 'telechargement en cours' };
        let pct = 0;
        const tic = setInterval(() => {
          pct += 20;
          if (pct < 100) { publier(\`terrarium/\${id}/maj\`, JSON.stringify({ etat: 'telechargement', pct, version: '3.5.0-demo' })); return; }
          clearInterval(tic);
          publier(\`terrarium/\${id}/maj\`, JSON.stringify({ etat: 'redemarrage', pct: 100, version: '3.5.0-demo' }));
          majs[id] = { etape: 'en validation', version: cible, detail: 'demarree, validation dans 90 s' };
          publierEtat(id);
          setTimeout(() => { majs[id] = { etape: 'validee', version: cible, detail: 'validee' }; publierEtat(id); }, 4000);
        }, 400);
        return;
      }
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
      // ---- protocole 4 : à distance, ce que la page locale faisait seule ----
      case 'sondes': {
        const f = f1(s);
        if (d.relire) noter(s, 'Bus 1-Wire relu');
        const reste = f.ident ? Math.max(0, 120 - Math.round((Date.now() - f.ident.debut) / 1000)) : 0;
        if (f.ident && !reste) f.ident = null;
        return rep(true, { sondes: {
          sondes: f.presentes.map(r => ({ rom: r, temp: +(s.zones[f.liaisons.indexOf(r)] || s.zones[0]).temp.toFixed(2), zone: f.liaisons.indexOf(r) })),
          parasite: false,
          liaisons: f.liaisons.map(r => (r ? { rom: r, presente: f.presentes.indexOf(r) >= 0 } : null)),
          identification: f.ident ? { zone: f.ident.zone + 1, restantS: reste } : null,
          resultat: f.identResultat
        } });
      }
      case 'lier': {
        const f = f1(s);
        if (!s.zones[d.z]) return rep(false, { erreur: 'zone invalide' });
        const rom = String(d.rom || '').toUpperCase();
        if (f.presentes.indexOf(rom) < 0) return rep(false, { erreur: 'Sonde absente du bus (scan pour relire le bus)' });
        f.liaisons = f.liaisons.map(r => (r === rom ? '' : r));
        f.liaisons[d.z] = rom;
        noter(s, 'Sonde ' + rom + ' liee a la zone ' + (d.z + 1));
        return rep(true, { message: 'Sonde ' + rom + ' liee a la zone ' + (d.z + 1) });
      }
      case 'identifier': {
        const f = f1(s);
        if (!s.zones[d.z]) return rep(false, { erreur: 'zone invalide' });
        f.ident = { zone: d.z, debut: Date.now() };
        // Démonstration : la sonde « serrée » est reconnue au bout de 6 s.
        setTimeout(() => {
          if (!f.ident || f.ident.zone !== d.z) return;
          f.ident = null;
          f.identResultat = 'Zone ' + (d.z + 1) + ' : sonde ' + f.presentes[d.z] + ' reconnue et liee';
          noter(s, f.identResultat);
        }, 6000);
        return rep(true, { message: 'Zone ' + (d.z + 1) + ' : serrez sa sonde dans la main (ou refroidissez-la) ; chauffe suspendue, 120 s maximum' });
      }
      case 'stop-identifier':
        f1(s).ident = null;
        return rep(true, { message: 'Identification annulee' });
      case 'essai': {
        const f = f1(s);
        if (d.z === undefined) {
          const reste = Math.max(0, Math.round((f.essai.fin - Date.now()) / 1000));
          return rep(true, { essai: { zone: reste ? f.essai.zone + 1 : 0, restantS: reste, resultat: f.essai.resultat } });
        }
        if (!s.zones[d.z]) return rep(false, { erreur: 'zone invalide' });
        if (f.essai.fin > Date.now()) return rep(false, { erreur: 'Essai deja en cours (zone ' + (f.essai.zone + 1) + ')' });
        f.essai = { zone: d.z, fin: Date.now() + 8000, resultat: '' };
        setTimeout(() => { if (f.essai.zone === d.z) f.essai.resultat = 'zone ' + (d.z + 1) + ' : +0.5 C en 7 s, le tapis chauffe et la sonde suit'; }, 7500);
        noter(s, 'Essai de chauffe lance sur la zone ' + (d.z + 1));
        return rep(true, { message: 'Zone ' + (d.z + 1) + ' : chauffe seule a pleine puissance, verdict des que sa sonde gagne 0.5 C (10 min au plus). Ne pas laisser sans surveillance.' });
      }
      case 'stop-essai': {
        const f = f1(s);
        if (f.essai.fin > Date.now()) f.essai.resultat = 'zone ' + (f.essai.zone + 1) + ' : essai arrete a la demande';
        f.essai.fin = 0;
        return rep(true, { message: 'Essai arrete' });
      }
      case 'calibrer': {
        const ecart = s.zones[0].temp - s.zones[1].temp;
        if (Math.abs(ecart) > 3) return rep(false, { erreur: 'Sondes trop ecartees (' + ecart.toFixed(1) + ' C) : les poser cote a cote quelques minutes' });
        return rep(true, { message: 'Zone 2 decalee de ' + ecart.toFixed(2) + ' C pour suivre la zone 1' });
      }
      case 'rapport':
        if (d.envoyer) { noter(s, 'Rapport envoye'); return rep(true, { message: 'Rapport envoye vers les alertes' }); }
        return rep(true, { texte: 'Rapport du ' + new Date().toISOString().slice(0, 10) + ' — ' + s.nom + '\\n' +
          s.zones.map(z => z.nom + ' : ' + z.temp.toFixed(1) + ' C (consigne ' + consigne(z).toFixed(1) + ' C), ' + (z.defaut ? 'defaut ' + z.defaut : 'sans defaut')).join('\\n') });
      case 'jours': {
        const n = Math.max(1, Math.min(30, d.n || 7));
        const jours = [];
        for (let i = 0; i < n; i++) {
          const date = new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 10);
          jours.push({ date, zones: s.zones.map((z, k) => {
            const h = 4.5 + ((i * 7 + k * 3) % 10) / 4;
            return { min: +(consigne(z) - 1.6).toFixed(1), max: +(consigne(z) + 0.9).toFixed(1), moyenne: +(consigne(z) - 0.3).toFixed(1),
              heures: +h.toFixed(2), kWh: +(h * 0.02).toFixed(3), euros: +(h * 0.02 * f1(s).g.prixKwh).toFixed(3), defauts: z.defaut && i === 0 ? 1 : 0 };
          }) });
        }
        return rep(true, { jours: { prixKwh: f1(s).g.prixKwh, jours } });
      }
      case 'journal':
        return rep(true, { texte: f1(s).journal.join('\\n') });
      case 'sauvegarde': {
        const f = f1(s);
        return rep(true, { sauvegarde: { format: 'terrarium-sauvegarde', version: '3.5.0-demo', appareil: id, date: new Date().toISOString(),
          zones: s.zones.map(z => ({ nom: z.nom, consigneJour: z.consigneJour, consigneNuit: z.consigneNuit, tempMax: z.tempMax })),
          globaux: Object.assign({ courantAlimA: s.alim }, f.g), sondes: f.liaisons.slice(),
          reseau: { formatAlertes: f.reseau.formatAlertes, heartbeatMinutes: f.reseau.heartbeatMinutes } } });
      }
      case 'restaurer': {
        const v = d.sauvegarde;
        if (!v || typeof v !== 'object') return rep(false, { erreur: 'sauvegarde attendue' });
        if (v.format !== 'terrarium-sauvegarde') return rep(false, { erreur: "Ce n'est pas une sauvegarde de socle" });
        (v.zones || []).forEach((z, i) => { if (s.zones[i] && z && typeof z.nom === 'string') s.zones[i].nom = z.nom; });
        if (Array.isArray(v.sondes)) f1(s).liaisons = s.zones.map((_, i) => v.sondes[i] || '');
        noter(s, 'Configuration de ' + (v.appareil || '?') + ' restauree');
        publierEtat(id);
        return rep(true, { message: 'Configuration de ' + (v.appareil || '?') + ' restauree (zones, reglages, sondes, alertes).' });
      }
      case 'reseau': {
        const f = f1(s);
        if (['ssid', 'ssid2', 'wifiPass', 'wifiPass2'].some(k => d[k] !== undefined)) return rep(false, { erreur: 'Wi-Fi : a regler sur la page locale du socle' });
        const r = Object.assign({}, f.reseau);
        let ok = true;
        ['urlAlertes', 'urlHeartbeat'].forEach(k => {
          if (typeof d[k] !== 'string') return;
          if (d[k] && !/^https?:[/][/]/.test(d[k])) ok = false; else r[k] = d[k];
        });
        if (d.heartbeatMinutes !== undefined) { if (d.heartbeatMinutes >= 1 && d.heartbeatMinutes <= 1440) r.heartbeatMinutes = d.heartbeatMinutes; else ok = false; }
        if (d.formatAlertes !== undefined) { if (d.formatAlertes === 0 || d.formatAlertes === 1) r.formatAlertes = d.formatAlertes; else ok = false; }
        if (!ok) return rep(false, { erreur: 'reseau : valeur invalide (URL http(s)://, 1-1440 min, format 0 ou 1)' });
        f.reseau = r;
        const hote = u => { if (!u) return ''; try { return new URL(u).hostname || 'definie'; } catch (e) { return 'definie'; } };
        return rep(true, { ssid: 'Maison', ssid2: '', alertes: hote(r.urlAlertes), heartbeat: hote(r.urlHeartbeat),
          heartbeatMinutes: r.heartbeatMinutes, formatAlertes: r.formatAlertes });
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
        publish(sujet, charge, opts, cb) {
          if (typeof opts === 'function') cb = opts;   // publish(sujet, charge, cb)
          const m = /^terrarium\\/([^/]+)\\/cmd$/.exec(sujet);
          if (m && socles[m[1]]) setTimeout(() => traiter(m[1], charge), 250);
          if (cb) setTimeout(() => cb(null), 0);
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

  // Test de charge de l'interface : demo.html?socles=20 crée autant de socles
  // supplémentaires, copies du premier, chacun avec sa propre évolution.
  const supplementaires = Math.min(200, parseInt((new URLSearchParams(location.search)).get('socles') || '0', 10) || 0);
  for (let i = 3; i <= supplementaires; i++) {
    const id = 'terraDEMO' + String(i).padStart(3, '0');
    socles[id] = JSON.parse(JSON.stringify(socles.terraDEMO001));
    socles[id].nom = 'Terrarium ' + i;
    socles[id].zones.forEach(z => { z.temp += (i % 7) * 0.3; });
  }

  Object.keys(socles).forEach(amorcerHistorique);
  setInterval(() => Object.keys(socles).forEach(id => {
    pas(id); enregistrerPoint(id); publierEtat(id);
  }), 2000);

  // Bandeau de démonstration, et configuration pré-remplie pour ouvrir
  // directement sur la liste plutôt que sur l'écran de connexion. La langue est
  // forcée en français : la démonstration est rédigée dans cette langue.
  localStorage.setItem('terrarium.langue', 'fr');
  localStorage.setItem('terrarium.config.v1', JSON.stringify({
    broker: { url: 'wss://demonstration', user: '', pass: '', prefixe: 'terrarium' },
    socles: Object.keys(socles).map(id => ({ id, jeton: 'DEMONSTRATION0000000001', nom: socles[id].nom }))
  }));
})();
`;

const BANDEAU = `
<div id="bandeau-demo" role="complementary" aria-label="Démonstration">
  Démonstration — socle simulé dans la page, aucun matériel ni broker.
  Les températures évoluent, les commandes fonctionnent.
</div>
`;

// ------------------------------------------------------------------ assemblage
let html = lire('index.html');

// L'anglais est un module que le site importe à la demande ; ouverte en
// file://, la démonstration ne pourrait pas l'importer : il est fourni d'avance.
const ANGLAIS = lire('textes.en.js').replace('export default {', 'window.TEXTES_EN = {');
if (!ANGLAIS.includes('window.TEXTES_EN = {')) { console.error('textes.en.js : « export default { » introuvable'); process.exit(1); }

// Même chose pour l'onglet Service, module importé à la demande par le site.
const SERVICE_SRC = lire('service.js');
if (!SERVICE_SRC.includes('export default function service(app) {')) { console.error('service.js : « export default function service(app) { » introuvable'); process.exit(1); }
const SERVICE = '(function () {\n' + SERVICE_SRC.replace('export default function service(app) {', 'window.SERVICE = function service(app) {') + '\n})();';

// Tout est mis en ligne dans le fichier : ouvert en file://, aucune requête ne
// pourrait aboutir de toute façon.
// La politique de sécurité (CSP) de la vraie page interdit les scripts en ligne,
// ce qui est précisément ce que ce fichier contient : elle est retirée ici.
html = html
  .replace('<link rel="stylesheet" href="style.css">', `<style>\n${lire('style.css')}\n</style>`)
  .replace('<link rel="manifest" href="manifest.json">', '')
  .replace('<link rel="icon" href="icone.svg">', '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\s*/, '')
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '')
  .replace('<script src="mqtt.js" defer></script>', `<script>${FAUX_MQTT}</script>`)
  .replace('<script src="app.js" defer></script>', () => `<script>\n${ANGLAIS}\n</script>\n<script>\n${SERVICE}\n</script>\n<script>\n${lire('app.js')}\n</script>`)
  .replace('<header id="entete">', `${BANDEAU}\n<header id="entete">`)
  .replace('<title>Terrariums</title>', '<title>Terrariums — démonstration</title>');

['<script src="mqtt.js"', '<script src="app.js"', 'Content-Security-Policy'].forEach(m => {
  if (html.includes(m)) { console.error(`Remplacement manqué : « ${m} » subsiste dans demo.html`); process.exit(1); }
});
fs.writeFileSync(path.join(APP, 'demo.html'), html);
console.log(`app/demo.html écrit (${(html.length / 1024).toFixed(1)} Ko)`);
