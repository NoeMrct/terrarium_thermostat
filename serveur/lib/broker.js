'use strict';
/* Broker MQTT avec comptes et droits par socle.
   - Un socle se connecte avec son identifiant (terraXXXXXX) et le mot de passe
     de son compte d'appareil : il publie sous <prefixe>/<id>/# et lit
     <prefixe>/<id>/cmd. Rien d'autre.
   - Une application se connecte avec un identifiant d'utilisateur et son mot
     de passe (ou un jeton de session) : elle lit <prefixe>/<id>/… et écrit
     <prefixe>/<id>/cmd pour les seuls socles rattachés à son compte.
   - Un pont facultatif vers un broker amont (HiveMQ…) fait entrer les socles
     qui y restent connectés : ce qu'ils publient là-bas est republié ici, ce
     que les applications commandent ici repart là-bas.
   Tout ce qui passe alimente l'historique, l'état de la flotte et les
   notifications. */

const net = require('net');
const { Aedes } = require('aedes');
const { WebSocketServer, createWebSocketStream } = require('ws');
const mqtt = require('mqtt');
const EventEmitter = require('events');
const crypto = require('crypto');

const LECTURES = ['etat', 'stats', 'version', 'historique'];
function lectureNonSignee(charge) {
  try {
    const d = JSON.parse(String(charge));
    return !!d && typeof d === 'object' && LECTURES.includes(d.action) && d.c === undefined && d.sig === undefined && d.jeton === undefined;
  } catch (e) { return false; }
}

class Broker extends EventEmitter {
  constructor(comptes, options = {}) {
    super();
    this.comptes = comptes;
    this.prefixe = options.prefixe || 'terrarium';
    this.adminJeton = options.adminJeton || null;
    this.flotte = {};                // id -> { statut, sante, vu, zones: {}, maj }
    this.attentes = {};              // req -> { resoudre, minuteur }
    this.amont = null;
    this.optionsAmont = options.amont || null;
    this.journal = options.journal || (() => {});
  }

  async demarrer({ portTcp = 1883, serveurHttp = null, cheminWs = '/mqtt' } = {}) {
    this.aedes = await Aedes.createBroker({
      id: 'terrarium-serveur',
      authenticate: (client, username, password, cb) => this.authentifier(client, username, password, cb),
      authorizePublish: (client, packet, cb) => this.autoriserPublication(client, packet, cb),
      authorizeSubscribe: (client, sub, cb) => this.autoriserAbonnement(client, sub, cb)
    });
    this.aedes.on('publish', (packet, client) => this.surPublication(packet, client));
    this.aedes.on('clientDisconnect', client => this.emit('deconnexion', client.id));
    if (portTcp !== null && portTcp !== undefined && portTcp >= 0) {     // 0 : port éphémère (tests)
      this.tcp = net.createServer(this.aedes.handle);
      await new Promise((res, rej) => this.tcp.listen(portTcp, err => (err ? rej(err) : res())));
    }
    if (serveurHttp) {
      // Le navigateur demande le sous-protocole « mqtt » et ferme sans lui.
      this.wss = new WebSocketServer({ noServer: true, handleProtocols: p => (p.has('mqtt') ? 'mqtt' : false) });
      this.wss.on('connection', ws => this.aedes.handle(createWebSocketStream(ws)));
      serveurHttp.on('upgrade', (req, socket, head) => {
        if ((req.url || '').split('?')[0] !== cheminWs) { socket.destroy(); return; }
        this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
      });
    }
    if (this.optionsAmont && this.optionsAmont.url) this.connecterAmont();
  }

  async arreter() {
    if (this.amont) { this.amont.end(true); this.amont = null; }
    if (this.tcp) await new Promise(r => this.tcp.close(r));
    if (this.wss) this.wss.close();
    if (this.aedes) await new Promise(r => this.aedes.close(r));
  }

  // --- authentification et droits ------------------------------------------------
  authentifier(client, username, password, cb) {
    const u = username ? String(username) : '', p = password ? password.toString() : '';
    if (this.adminJeton && u === 'admin' && crypto.timingSafeEqual(crypto.createHash('sha256').update(p).digest(), crypto.createHash('sha256').update(this.adminJeton).digest())) {
      client.role = 'admin';
      return cb(null, true);
    }
    if (/^terra[0-9A-Za-z]{6}$/.test(u)) {
      if (this.comptes.authentifierAppareil(u, p)) { client.role = 'appareil'; client.socle = u; return cb(null, true); }
    } else if (u) {
      const util = this.comptes.authentifierUtilisateur(u, p);
      if (util) { client.role = 'utilisateur'; client.login = util.login; return cb(null, true); }
    }
    const e = new Error('identifiants refusés');
    e.returnCode = 4;                 // bad user name or password
    cb(e, false);
  }

  // <prefixe>/<id>/<reste> -> { id, reste } ou null
  decomposer(sujet) {
    const parts = String(sujet).split('/');
    if (parts.length < 3 || parts[0] !== this.prefixe || !/^terra[0-9A-Za-z]{6}$/.test(parts[1])) return null;
    return { id: parts[1], reste: parts.slice(2).join('/') };
  }

  autoriserPublication(client, packet, cb) {
    if (!client) return cb(null);                                 // publication interne
    if (client.role === 'admin') return cb(null);
    const s = this.decomposer(packet.topic);
    if (client.role === 'appareil') {
      if ((s && s.id === client.socle) || /^homeassistant\//.test(packet.topic)) return cb(null);
      return cb(new Error('publication hors de son sujet'));
    }
    if (client.role === 'utilisateur') {
      const u = this.comptes.utilisateur(client.login);
      if (s && s.reste === 'cmd' && this.comptes.peutCommander(u, s.id)) return cb(null);
      // Un invité en lecture seule (F12) : les lectures non signées seulement
      // (état, statistiques, version, historique), comme le socle les accepte.
      if (s && s.reste === 'cmd' && this.comptes.possede(u, s.id) && lectureNonSignee(packet.payload)) return cb(null);
      return cb(new Error(this.comptes.possede(u, s && s.id) ? 'accès en lecture seule' : 'socle non rattaché à ce compte'));
    }
    cb(new Error('refusé'));
  }

  // Un abonnement interdit est nié (qos 128 dans le SUBACK) plutôt que
  // traité en erreur : l'application voit tout de suite quel socle ne lui est
  // pas rattaché, sans perdre sa connexion.
  autoriserAbonnement(client, sub, cb) {
    if (!client || client.role === 'admin') return cb(null, sub);
    // L'annonce du serveur (<prefixe>/serveur, retenue) est lisible par tout
    // client authentifié : c'est ce qui dit à l'application qu'elle parle à un
    // serveur Terrariums et non à un broker nu — sans sonder une API en HTTP.
    if (sub.topic === `${this.prefixe}/serveur`) return cb(null, sub);
    const s = this.decomposer(sub.topic);
    if (client.role === 'appareil') {
      if (s && s.id === client.socle && (s.reste === 'cmd' || /\/set$/.test(s.reste))) return cb(null, sub);
      return cb(null, null);
    }
    if (client.role === 'utilisateur') {
      const u = this.comptes.utilisateur(client.login);
      if (s && !/[#+]/.test(s.id) && this.comptes.possede(u, s.id)) return cb(null, sub);
      return cb(null, null);
    }
    cb(null, null);
  }

  // --- ce qui passe ------------------------------------------------------------------
  surPublication(packet, client) {
    const s = this.decomposer(packet.topic);
    if (!s) return;
    const texte = packet.payload.toString();
    const f = this.flotte[s.id] || (this.flotte[s.id] = { statut: null, sante: null, vu: 0, zones: {}, maj: null });
    f.vu = Date.now();
    if (s.reste === 'statut') {
      const avant = f.statut;
      f.statut = texte;
      if (avant === 'en ligne' && texte === 'hors ligne') this.emit('horsLigne', s.id);
      // Retour après une absence vue par ce serveur (pas le statut retenu rejoué au démarrage).
      if (avant === 'hors ligne' && texte === 'en ligne') this.emit('enLigne', s.id);
    } else if (s.reste === 'sante') {
      const uptimeAvant = f.sante ? f.sante.uptime : undefined;
      try { f.sante = JSON.parse(texte); } catch (e) { /* ignoré */ }
      // La durée de marche qui recule : le socle a redémarré.
      if (f.sante && typeof uptimeAvant === 'number' && typeof f.sante.uptime === 'number' && f.sante.uptime < uptimeAvant) {
        this.emit('redemarrage', s.id, f.sante);
      }
      if (f.sante && f.sante.maj && f.sante.maj.etape && f.sante.maj.etape !== (f.maj && f.maj.etape)) {
        f.maj = f.sante.maj;
        this.emit('maj', s.id, f.sante.maj);
      }
      // Mises à jour automatiques (F15) : une version disponible que le socle
      // n'annonçait pas encore. La première santé reçue (message retenu rejoué
      // au démarrage du serveur) sert de référence, sans prévenir à nouveau.
      const dispo = (f.sante && f.sante.majAuto && f.sante.majAuto.disponible) || null;
      if (dispo && f.majDispo !== undefined && dispo !== f.majDispo) this.emit('majDisponible', s.id, f.sante.majAuto);
      f.majDispo = dispo;
    } else if (/^zone\d+\/etat$/.test(s.reste)) {
      const zone = parseInt(s.reste.slice(4), 10) - 1;
      let etat; try { etat = JSON.parse(texte); } catch (e) { return; }
      const avant = f.zones[zone];
      f.zones[zone] = etat;
      this.emit('etat', s.id, zone, etat, avant);
    } else if (s.reste === 'reponse') {
      let r; try { r = JSON.parse(texte); } catch (e) { return; }
      const a = this.attentes[r.req];
      if (a) { clearTimeout(a.minuteur); delete this.attentes[r.req]; a.resoudre(r); }
    } else if (s.reste === 'cmd' && client && this.amont && client.role !== 'admin') {
      // Commande d'une application locale pour un socle qui vit en amont.
      this.amont.publish(packet.topic, packet.payload, { qos: 1 });
    }
  }

  // Annonce retenue du serveur : l'application qui se connecte la reçoit
  // aussitôt et sait alors qu'une API l'attend sur la même origine.
  annoncer(infos) {
    return this.publier(`${this.prefixe}/serveur`, JSON.stringify({ serveur: 'terrariums', ...infos }), true);
  }

  // Publication interne (sans client) : vue par les abonnés locaux, et par les
  // socles en amont s'il s'agit d'une commande.
  publier(sujet, charge, retain = false) {
    return new Promise(res => this.aedes.publish({ topic: sujet, payload: Buffer.from(charge), qos: 0, retain }, res));
  }

  // Commande au nom du serveur, réponse attendue : sert à vérifier un code
  // d'appairage (action protégée par le jeton, sans effet), et à porter les
  // commandes du support pendant un accès ouvert (signées avec la clé de
  // session : options.cle).
  commander(id, action, params = {}, delaiMs = 8000, options = {}) {
    return new Promise((resoudre, rejeter) => {
      const req = 'srv' + Math.random().toString(36).slice(2, 10);
      this.attentes[req] = { resoudre, minuteur: setTimeout(() => { delete this.attentes[req]; rejeter(new Error('le socle ne répond pas')); }, delaiMs) };
      // Un socle au protocole 4 reçoit la commande signée (HMAC-SHA256 du code
      // d'appairage) : le code ne part pas en clair, vers un broker amont non plus.
      const { jeton, ...reste } = params;
      const proto = ((this.flotte[id] || {}).sante || {}).proto;
      let charge;
      if (options.cle) {
        const c = JSON.stringify({ req, action, ts: Math.floor(Date.now() / 1000), ...reste });
        charge = JSON.stringify({ c, sig: crypto.createHmac('sha256', options.cle).update(c, 'utf8').digest('hex') });
      } else if (jeton && proto >= 4) {
        const c = JSON.stringify({ req, action, ts: Math.floor(Date.now() / 1000), ...reste });
        charge = JSON.stringify({ c, sig: crypto.createHmac('sha256', jeton).update(c, 'utf8').digest('hex') });
      } else charge = JSON.stringify({ req, action, ...params });
      const sujet = `${this.prefixe}/${id}/cmd`;
      this.publier(sujet, charge);
      if (this.amont) this.amont.publish(sujet, charge, { qos: 1 });
    });
  }

  // --- pont vers un broker amont ------------------------------------------------------
  connecterAmont() {
    const o = this.optionsAmont;
    this.amont = mqtt.connect(o.url, { username: o.utilisateur || undefined, password: o.motDePasse || undefined,
      clientId: 'terrarium-serveur-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 5000, keepalive: 30 });
    this.amont.on('connect', () => {
      this.journal(`pont : connecté à ${o.url}`);
      this.amont.subscribe([`${this.prefixe}/+/statut`, `${this.prefixe}/+/+/etat`, `${this.prefixe}/+/sante`, `${this.prefixe}/+/reponse`, `${this.prefixe}/+/maj`], { qos: 0 });
      this.emit('amontConnecte');
    });
    this.amont.on('error', e => this.journal(`pont : ${e.message}`));
    this.amont.on('message', (sujet, charge, paquet) => {
      // Republié localement sans client : les abonnés le reçoivent, et
      // surPublication l'enregistre comme n'importe quel message de socle.
      this.aedes.publish({ topic: sujet, payload: charge, qos: 0, retain: !!paquet.retain }, () => {});
    });
  }

  etatFlotte() {
    return Object.keys(this.flotte).map(id => this.resumeSocle(id));
  }

  // Ce que le socle a publié lui-même (statut, santé, état des zones) : le
  // serveur n'en sait pas plus, et ne peut rien lui commander sans son code.
  resumeSocle(id) {
    const f = this.flotte[id];
    if (!f) return null;
    const s = f.sante || {};
    return {
      id, statut: f.statut, enLigne: f.statut === 'en ligne' && Date.now() - f.vu < 180000, vu: f.vu ? new Date(f.vu).toISOString() : null,
      version: s.version, proto: s.proto, rssi: s.rssi, heap: s.heap, uptime: s.uptime, reset: s.reset, plantage: !!s.plantage, maj: f.maj,
      majAuto: s.majAuto || null,
      zones: Object.entries(f.zones).sort((a, b) => a[0] - b[0]).map(([, z]) => ({ temp: z.temp, consigne: z.consigne, nom: z.nom,
        defaut: z.defaut === '1' || z.defaut === 1 || (z.defaut && z.defaut !== '0') ? (z.defaut_libelle || true) : null }))
    };
  }

  detailSocle(id) {
    const f = this.flotte[id];
    if (!f) return null;
    return { ...this.resumeSocle(id), sante: f.sante || null,
      etatsZones: Object.entries(f.zones).sort((a, b) => a[0] - b[0]).map(([z, e]) => ({ zone: +z + 1, ...e })) };
  }

  clientsConnectes() { return this.aedes ? this.aedes.connectedClients : 0; }
  amontConnecte() { return !!(this.amont && this.amont.connected); }
}

module.exports = { Broker };
