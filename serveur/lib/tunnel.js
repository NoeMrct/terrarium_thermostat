'use strict';
/* =============================================================================
   MQTT par HTTPS ordinaire : le tunnel des navigateurs privés de WebSocket.
   -----------------------------------------------------------------------------
   La liste EasyPrivacy, qu'uBlock Origin, Brave et AdGuard appliquent d'office,
   coupe tout WebSocket tiers vers duckdns.org (une règle contre le minage de
   cryptomonnaie). L'application servie par Netlify ne joignait alors plus le
   broker de ce serveur, alors que ses requêtes HTTPS passaient. Ici, les mêmes
   octets MQTT passent par des requêtes HTTP banales :

     POST   /mqtt/tunnel        ouvre une liaison                → 201 { id }
     GET    /mqtt/tunnel/<id>   flux descendant : les octets du broker, au fil de l'eau
     POST   /mqtt/tunnel/<id>   flux montant : des paquets MQTT, corps brut
     DELETE /mqtt/tunnel/<id>   ferme ; la fin du GET ferme aussi

   Le broker y voit une connexion comme une autre : identifiants dans le
   CONNECT, droits par sujet, messages retenus, keepalive. L'identifiant
   (144 bits tirés au hasard) n'autorise rien en lui-même : il désigne la
   liaison, que seul son CONNECT authentifie. Plafonds : liaisons ouvertes au
   total et par adresse, délai pour venir lire, taille d'un envoi, mémoire tenue
   en attendant le lecteur. Rien n'est journalisé (ni identifiant ni contenu).
   ============================================================================= */

const crypto = require('crypto');
const { Duplex } = require('stream');

const CHEMIN = '/mqtt/tunnel';
const AVEC_ID = /^\/mqtt\/tunnel\/([A-Za-z0-9_-]{24})$/;

// Une liaison : flux duplex remis au broker. Ce que le broker écrit part dans
// la réponse du GET (ou attend, borné, qu'il arrive) ; ce que les POST
// apportent est poussé vers le broker.
class Liaison extends Duplex {
  constructor(id, ip, tamponMax) {
    super({ allowHalfOpen: false });
    this.id = id;
    this.ip = ip;
    this.res = null;
    this.attente = [];
    this.enAttente = 0;
    this.tamponMax = tamponMax;
    this.minuteur = null;
  }

  _read() { /* les octets arrivent par les POST */ }

  _write(morceau, codage, suite) {
    if (this.res) {
      if (this.res.destroyed || this.res.writableEnded) { suite(new Error('tunnel : lecteur parti')); return; }
      if (this.res.write(morceau)) suite();
      else this.res.once('drain', () => suite());
      return;
    }
    this.enAttente += morceau.length;
    if (this.enAttente > this.tamponMax) { suite(new Error('tunnel : personne ne lit')); return; }
    this.attente.push(morceau);
    suite();
  }

  _final(suite) { this.terminerReponse(); suite(); }

  _destroy(err, suite) {
    clearTimeout(this.minuteur);
    this.terminerReponse();
    suite(err);
  }

  terminerReponse() {
    if (this.res && !this.res.writableEnded) { try { this.res.end(); } catch (e) { /* client parti */ } }
  }
}

class Tunnels {
  /**
   * @param {{ aedes: { handle: Function } }} broker
   * @param {{ max?: number, parIp?: number, delaiLectureMs?: number, envoiMax?: number, tamponMax?: number }} [options]
   */
  constructor(broker, { max = 500, parIp = 30, delaiLectureMs = 20000, envoiMax = 256 * 1024, tamponMax = 512 * 1024 } = {}) {
    this.broker = broker;
    this.o = { max, parIp, delaiLectureMs, envoiMax, tamponMax };
    this.liaisons = new Map();
  }

  static concerne(chemin) { return chemin === CHEMIN || chemin.startsWith(CHEMIN + '/'); }

  ouvertesDepuis(ip) {
    let n = 0;
    for (const l of this.liaisons.values()) if (l.ip === ip) n++;
    return n;
  }

  // La réponse est toujours envoyée ici (le chemin est celui du tunnel).
  traiter(req, res, methode, chemin, ip) {
    if (chemin === CHEMIN) {
      if (methode === 'POST') return this.ouvrir(req, res, ip);
      return json(res, 405, { erreur: 'POST pour ouvrir une liaison' });
    }
    const m = AVEC_ID.exec(chemin);
    const l = m && this.liaisons.get(m[1]);
    if (!l || l.destroyed) return json(res, 404, { erreur: 'liaison inconnue ou fermée' });
    if (methode === 'GET') return this.suivre(req, res, l);
    if (methode === 'POST') return this.recevoir(req, res, l);
    if (methode === 'DELETE') { l.destroy(); res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return undefined; }
    return json(res, 405, { erreur: 'GET, POST ou DELETE' });
  }

  ouvrir(req, res, ip) {
    // Le corps éventuel est ignoré : qu'il ne retienne pas la connexion.
    req.resume();
    if (this.liaisons.size >= this.o.max) return json(res, 503, { erreur: 'trop de liaisons ouvertes, réessayer plus tard' });
    if (this.ouvertesDepuis(ip) >= this.o.parIp) return json(res, 429, { erreur: 'trop de liaisons ouvertes depuis cette adresse' });
    const id = crypto.randomBytes(18).toString('base64url');
    const l = new Liaison(id, ip, this.o.tamponMax);
    this.liaisons.set(id, l);
    l.on('close', () => { if (this.liaisons.get(id) === l) this.liaisons.delete(id); });
    l.on('error', () => { /* le broker ferme la liaison ; rien à signaler ici */ });
    // Une liaison que personne ne vient lire ne garde pas sa place.
    l.minuteur = setTimeout(() => { if (!l.res) l.destroy(); }, this.o.delaiLectureMs);
    if (l.minuteur.unref) l.minuteur.unref();
    this.broker.aedes.handle(l, req);
    return json(res, 201, { id });
  }

  suivre(req, res, l) {
    if (l.res) return json(res, 409, { erreur: 'cette liaison a déjà son lecteur' });
    clearTimeout(l.minuteur);
    // Ni mise en cache ni transformation ; un proxy de type nginx ne doit pas
    // retenir le flux (Traefik le relaie dès qu'il arrive).
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    l.res = res;
    for (const m of l.attente.splice(0)) res.write(m);
    l.enAttente = 0;
    res.on('error', () => { /* lecteur parti : la fermeture suit */ });
    res.on('close', () => l.destroy());
    return undefined;
  }

  recevoir(req, res, l) {
    const morceaux = [];
    let taille = 0, trop = false;
    req.on('data', m => {
      if (trop) return;
      taille += m.length;
      if (taille > this.o.envoiMax) { trop = true; json(res, 413, { erreur: 'envoi trop grand' }); req.destroy(); return; }
      morceaux.push(m);
    });
    req.on('end', () => {
      if (trop) return;
      if (l.destroyed) { json(res, 404, { erreur: 'liaison fermée' }); return; }
      if (taille) l.push(Buffer.concat(morceaux, taille));
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
    req.on('error', () => { /* client parti en cours d'envoi */ });
    return undefined;
  }

  arreter() {
    for (const l of [...this.liaisons.values()]) l.destroy();
    this.liaisons.clear();
  }
}

function json(res, code, donnees) {
  if (res.headersSent) { try { res.end(); } catch (e) { /* déjà fermé */ } return undefined; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(donnees));
  return undefined;
}

module.exports = { Tunnels };
