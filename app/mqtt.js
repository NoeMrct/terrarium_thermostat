/* =============================================================================
   Client MQTT 3.1.1 sur WebSocket — minimal, écrit pour cette application.
   -----------------------------------------------------------------------------
   Il remplace MQTT.js (369 Ko) par quelques kilo-octets : l'application n'a
   besoin que de connect, subscribe, unsubscribe, publish en QoS 0 ou 1, du
   keepalive et de la reconnexion. L'interface imite celle de MQTT.js pour ce
   sous-ensemble :

     const client = mqtt.connect('wss://hote:8884/mqtt', { username, password,
                                  clientId, keepalive, reconnectPeriod, connectTimeout });
     client.on('connect' | 'reconnect' | 'close' | 'offline' | 'error' | 'message', cb);
     client.subscribe(['a/b', 'c/+/d']);   client.unsubscribe([...]);
     client.publish('a/b', 'texte');       client.publish('a/b', 'texte', { qos: 1 }, cb);
     client.end();                          client.connected   // booléen

   Les messages arrivent sous forme (sujet, charge) où charge.toString()
   renvoie le texte UTF-8 — comme le Buffer de MQTT.js.

   En QoS 1, un message non acquitté par le broker est réémis (drapeau DUP) à
   chaque reconnexion, jusqu'au PUBACK : c'est ce qui fait passer une commande
   sur une liaison mobile hachée. Volontairement absent : la publication en
   QoS 2, les sessions persistantes, MQTT 5. La réception en QoS 1 et 2 est
   acquittée correctement si un broker en envoie malgré tout.
   ============================================================================= */

/** @type {any} */ (window).mqtt = (() => {
  'use strict';

  // ------------------------------------------------------------------ octets
  const encodeur = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const decodeur = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  const utf8 = s => encodeur ? encodeur.encode(s)
    : Uint8Array.from(unescape(encodeURIComponent(s)), c => c.charCodeAt(0));
  const texte = o => decodeur ? decodeur.decode(o)
    : decodeURIComponent(escape(String.fromCharCode.apply(null, o)));

  // La charge d'un message : des octets qui savent se lire comme du texte.
  class Charge extends Uint8Array {
    toString() { return texte(this); }
  }

  // Chaîne préfixée de sa longueur sur deux octets, comme partout dans MQTT.
  const chaine = s => { const b = utf8(s); return [b.length >> 8, b.length & 255, ...b]; };

  // Longueur restante en 1 à 4 octets, 7 bits utiles par octet.
  function longueur(n) {
    const o = [];
    do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 128; o.push(x); } while (n);
    return o;
  }

  const paquet = (type, drapeaux, corps) =>
    Uint8Array.from([(type << 4) | drapeaux, ...longueur(corps.length), ...corps]);

  const REFUS = ['', 'version de protocole refusée', 'identifiant refusé',
                 'serveur indisponible', 'identifiants incorrects', 'non autorisé'];

  // ------------------------------------------------------------------ client
  class Client {
    constructor(url, opts) {
      this.url = url;
      this.opts = Object.assign({
        keepalive: 60, reconnectPeriod: 4000, connectTimeout: 8000, clean: true,
        clientId: 'mini-' + Math.random().toString(16).slice(2, 10)
      }, opts || {});
      this.connected = false;
      this._fini = false;
      this._ecouteurs = {};
      this._rappels = {};
      this._tampon = new Uint8Array(0);
      this._id = 0;
      this._enVol = new Map();               // id -> publication QoS 1 en attente de PUBACK
      this._attente = this.opts.reconnectPeriod;
      this._ouvrir();
    }

    on(ev, cb) { (this._ecouteurs[ev] || (this._ecouteurs[ev] = [])).push(cb); return this; }
    _emettre(ev, ...args) {
      (this._ecouteurs[ev] || []).forEach(cb => { try { cb(...args); } catch (e) { console.error(e); } });
    }
    _erreur(message) {
      this._erreurSignalee = true;
      this._emettre('error', new Error(message));
    }

    // ---- connexion ---------------------------------------------------------
    _ouvrir() {
      if (this._fini) return;
      this._erreurSignalee = false;
      this._tampon = new Uint8Array(0);
      let ws;
      try { ws = new WebSocket(this.url, ['mqtt']); }
      catch (e) { this._erreur(e.message || 'adresse invalide'); this._reprogrammer(); return; }
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      this._minuteurConnexion = setTimeout(() => {
        this._erreur('délai de connexion dépassé');
        this._fermer();
      }, this.opts.connectTimeout);

      ws.onopen = () => {
        const o = this.opts;
        let drapeaux = o.clean === false ? 0 : 0x02;
        const identifiants = [];
        if (o.username !== undefined && o.username !== null) { drapeaux |= 0x80; identifiants.push(...chaine(o.username)); }
        if (o.password !== undefined && o.password !== null) { drapeaux |= 0x40; identifiants.push(...chaine(o.password)); }
        ws.send(paquet(1, 0, [...chaine('MQTT'), 4, drapeaux, o.keepalive >> 8, o.keepalive & 255,
                              ...chaine(o.clientId), ...identifiants]));
      };
      ws.onmessage = e => this._recevoir(new Uint8Array(e.data));
      ws.onerror = () => { /* le close qui suit porte l'information utile */ };
      ws.onclose = () => {
        clearTimeout(this._minuteurConnexion);
        clearInterval(this._minuteurPing);
        const etait = this.connected;
        this.connected = false;
        this._ws = null;
        if (etait) { this._emettre('close'); this._emettre('offline'); }
        else if (!this._fini && !this._erreurSignalee) this._erreur('broker injoignable');
        this._reprogrammer();
      };
    }

    // Recul progressif : inutile de marteler un broker qui refuse ou qui est tombé.
    _reprogrammer() {
      if (this._fini || this._minuteurReconnexion) return;
      this._minuteurReconnexion = setTimeout(() => {
        this._minuteurReconnexion = null;
        this._emettre('reconnect');
        this._ouvrir();
      }, this._attente);
      this._attente = Math.min(this._attente * 2, 30000);
    }

    _fermer() {
      if (this._ws) { try { this._ws.close(); } catch (e) { /* déjà fermé */ } }
    }

    // ---- keepalive ---------------------------------------------------------
    _demarrerPing() {
      clearInterval(this._minuteurPing);
      this._pingSansReponse = false;
      this._minuteurPing = setInterval(() => {
        if (this._pingSansReponse) {          // le broker n'a pas répondu au précédent
          this._erreur('le broker ne répond plus');
          this._fermer();
          return;
        }
        this._pingSansReponse = true;
        this._envoyer(paquet(12, 0, []));
      }, Math.max(1000, this.opts.keepalive * 1000 * 0.75));
    }

    _envoyer(octets) {
      if (this._ws && this._ws.readyState === 1) this._ws.send(octets);
    }

    _prochainId() { this._id = (this._id % 65535) + 1; return this._id; }

    // ---- réception ---------------------------------------------------------
    _recevoir(octets) {
      // Un cadre WebSocket peut porter plusieurs paquets, ou un paquet incomplet.
      const t = new Uint8Array(this._tampon.length + octets.length);
      t.set(this._tampon); t.set(octets, this._tampon.length);
      this._tampon = t;
      for (;;) {
        const b = this._tampon;
        if (b.length < 2) return;
        let n = 0, mult = 1, i = 1;
        for (;;) {
          if (i >= b.length) return;                    // longueur incomplète
          n += (b[i] & 127) * mult; mult *= 128;
          if (!(b[i] & 128)) break;
          if (++i > 4) { this._fermer(); return; }      // paquet malformé
        }
        const debut = i + 1, fin = debut + n;
        if (b.length < fin) return;                     // corps incomplet
        this._traiter(b[0] >> 4, b[0] & 15, b.subarray(debut, fin));
        this._tampon = b.slice(fin);
      }
    }

    _traiter(type, drapeaux, c) {
      switch (type) {
        case 2:                                         // CONNACK
          clearTimeout(this._minuteurConnexion);
          if (c[1] !== 0) {
            this._erreur('connexion refusée : ' + (REFUS[c[1]] || 'code ' + c[1]));
            this._fermer();
            return;
          }
          this.connected = true;
          this._attente = this.opts.reconnectPeriod;
          this._demarrerPing();
          // Ce qui attendait encore un acquittement repart, marqué DUP.
          this._enVol.forEach(p => this._envoyer(this._paquetPublish(p, true)));
          this._emettre('connect');
          break;
        case 4: {                                       // PUBACK
          const id = (c[0] << 8) | c[1];
          const p = this._enVol.get(id);
          if (p) { this._enVol.delete(id); if (p.cb) p.cb(null); }
          break;
        }
        case 3: {                                       // PUBLISH
          const qos = (drapeaux >> 1) & 3;
          const l = (c[0] << 8) | c[1];
          const sujet = texte(c.subarray(2, 2 + l));
          let p = 2 + l, id = 0;
          if (qos) { id = (c[p] << 8) | c[p + 1]; p += 2; }
          const charge = new Charge(c.subarray(p));
          if (qos === 1) this._envoyer(paquet(4, 0, [id >> 8, id & 255]));
          if (qos === 2) this._envoyer(paquet(5, 0, [id >> 8, id & 255]));
          this._emettre('message', sujet, charge, { topic: sujet, qos, retain: !!(drapeaux & 1) });
          break;
        }
        case 6:                                         // PUBREL -> PUBCOMP
          this._envoyer(paquet(7, 0, [c[0], c[1]]));
          break;
        case 9: {                                       // SUBACK
          const id = (c[0] << 8) | c[1];
          const cb = this._rappels[id];
          if (cb) { delete this._rappels[id]; cb(null, Array.from(c.subarray(2))); }
          break;
        }
        case 13:                                        // PINGRESP
          this._pingSansReponse = false;
          break;
        default: break;                                 // UNSUBACK… rien à faire
      }
    }

    // ---- API ---------------------------------------------------------------
    subscribe(filtres, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const qos = (opts && opts.qos) || 0;
      const id = this._prochainId();
      const corps = [id >> 8, id & 255];
      (Array.isArray(filtres) ? filtres : [filtres]).forEach(f => corps.push(...chaine(f), qos));
      if (cb) this._rappels[id] = cb;
      this._envoyer(paquet(8, 2, corps));
      return this;
    }

    unsubscribe(filtres) {
      const id = this._prochainId();
      const corps = [id >> 8, id & 255];
      (Array.isArray(filtres) ? filtres : [filtres]).forEach(f => corps.push(...chaine(f)));
      this._envoyer(paquet(10, 2, corps));
      return this;
    }

    _paquetPublish(p, dup) {
      const drapeaux = (dup ? 8 : 0) | (p.qos << 1) | (p.retenir ? 1 : 0);
      const entete = [...chaine(p.sujet)];
      if (p.qos) entete.push(p.id >> 8, p.id & 255);
      return paquet(3, drapeaux, [...entete, ...p.octets]);
    }

    publish(sujet, charge, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const retenir = !!(opts && opts.retain);
      const qos = (opts && opts.qos === 1) ? 1 : 0;
      const octets = charge instanceof Uint8Array ? charge : utf8(String(charge == null ? '' : charge));
      const p = { sujet, octets, retenir, qos, id: 0, cb };
      if (qos) {
        if (this._enVol.size >= 64) { if (cb) cb(new Error('trop de messages en attente')); return this; }
        p.id = this._prochainId();
        this._enVol.set(p.id, p);
      }
      this._envoyer(this._paquetPublish(p, false));
      if (!qos && cb) cb(null);
      return this;
    }

    end() {
      this._fini = true;
      clearTimeout(this._minuteurReconnexion); this._minuteurReconnexion = null;
      clearTimeout(this._minuteurConnexion);
      clearInterval(this._minuteurPing);
      this._enVol.forEach(p => { if (p.cb) p.cb(new Error('connexion terminée')); });
      this._enVol.clear();
      if (this.connected) {
        this._envoyer(paquet(14, 0, []));
        this.connected = false;
        this._emettre('close');
      }
      this._fermer();
      return this;
    }
  }

  return { connect: (url, opts) => new Client(url, opts) };
})();
