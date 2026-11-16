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

   Un WebSocket qui n'a jamais pu s'ouvrir (un bloqueur de publicité le coupe,
   un proxy le refuse) laisse aussitôt la place au tunnel HTTPS d'un serveur
   Terrariums (…/mqtt/tunnel) : mêmes paquets, par des requêtes ordinaires.
   Le chemin qui a marché reste le premier essayé ensuite.
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

  // ------------------------------------------------------------ tunnel HTTPS
  // La liste EasyPrivacy (uBlock Origin, Brave, AdGuard l'appliquent d'office)
  // coupe tout WebSocket tiers vers certains domaines, duckdns.org entier
  // compris, alors que les requêtes HTTPS y passent. Un serveur Terrariums
  // offre le même MQTT par HTTPS : POST …/mqtt/tunnel ouvre une liaison,
  // GET …/mqtt/tunnel/<id> en reçoit les octets au fil de l'eau, chaque
  // POST …/<id> y envoie des paquets. Cette classe se présente au client comme
  // un WebSocket : readyState, send, close, onopen, onmessage, onclose.
  const adresseTunnel = url => {
    if (typeof fetch !== 'function' || typeof AbortController !== 'function') return null;
    const m = /^(wss?):\/\/([^/?#]+)\/mqtt\/?$/.exec(String(url));
    return m ? `${m[1] === 'wss' ? 'https' : 'http'}://${m[2]}/mqtt/tunnel` : null;
  };

  class Tunnel {
    constructor(base) {
      this.readyState = 0;                   // 0 ouverture, 1 ouvert, 3 fermé
      this.binaryType = 'arraybuffer';
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.absent = false;                   // le serveur n'offre pas de tunnel
      this._base = base;
      this._url = '';
      this._file = [];
      this._envoi = false;
      this._arret = new AbortController();
      this._suivre().catch(() => this._clore());
    }

    async _suivre() {
      const options = { cache: /** @type {RequestCache} */ ('no-store'), signal: this._arret.signal };
      const r = await fetch(this._base, Object.assign({ method: 'POST' }, options));
      if (!r.ok) { this.absent = r.status === 404 || r.status === 405; throw new Error('tunnel ' + r.status); }
      const { id } = await r.json();
      if (typeof id !== 'string' || !/^[\w-]{16,64}$/.test(id)) { this.absent = true; throw new Error('tunnel'); }
      this._url = this._base + '/' + id;
      const flux = await fetch(this._url, options);
      if (!flux.ok || !flux.body) throw new Error('tunnel ' + flux.status);
      if (this.readyState !== 0) return;
      this.readyState = 1;
      if (this.onopen) this.onopen();
      this._vider();
      const lecteur = flux.body.getReader();
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done || this.readyState !== 1) break;
        if (value && value.length && this.onmessage) this.onmessage({ data: value });
      }
      this._clore();
    }

    send(octets) {
      if (this.readyState !== 1) return;
      this._file.push(octets);
      this._vider();
    }

    // Un envoi à la fois, dans l'ordre : ce qui s'accumule pendant ce temps
    // part en un seul POST.
    async _vider() {
      if (this._envoi || !this._file.length || this.readyState !== 1) return;
      this._envoi = true;
      const lot = this._file.splice(0);
      const corps = new Uint8Array(lot.reduce((n, o) => n + o.length, 0));
      let i = 0;
      lot.forEach(o => { corps.set(o, i); i += o.length; });
      try {
        const r = await fetch(this._url, { method: 'POST', body: corps, cache: 'no-store', signal: this._arret.signal,
                                           headers: { 'Content-Type': 'application/octet-stream' } });
        if (!r.ok) throw new Error('tunnel ' + r.status);
      } catch (e) { this._envoi = false; this._clore(); return; }
      this._envoi = false;
      this._vider();
    }

    // Couper le flux suffit : le serveur ferme la liaison quand son lecteur part.
    close() { this._clore(); }

    _clore() {
      if (this.readyState === 3) return;
      const avant = this.readyState;
      this.readyState = 3;
      this._file = [];
      try { this._arret.abort(); } catch (e) { /* déjà interrompu */ }
      if (avant === 0 && this.onerror) this.onerror();
      setTimeout(() => { if (this.onclose) this.onclose({ code: 1006 }); }, 0);
    }
  }

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
      this._adresseTunnel = adresseTunnel(url);
      this._parTunnel = false;               // le chemin qui a marché en dernier
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
    // Le chemin préféré d'abord ; s'il ne s'ouvre pas, l'autre aussitôt, une
    // fois par tour. Un chemin qui s'est ouvert puis a échoué (identifiants
    // refusés, délai) ne fait pas essayer l'autre : le réseau n'y est pour rien.
    _ouvrir(relais) {
      if (this._fini) return;
      this._erreurSignalee = false;
      this._echec = '';
      this._tampon = new Uint8Array(0);
      const parTunnel = (relais ? !this._parTunnel : this._parTunnel) && !!this._adresseTunnel;
      const relaisPossible = !relais && !!this._adresseTunnel;
      /** @type {any} */ let ws;
      try { ws = parTunnel ? new Tunnel(this._adresseTunnel) : new WebSocket(this.url, ['mqtt']); }
      catch (e) {
        if (relaisPossible) { this._ouvrir(true); return; }
        this._erreur(e.message || 'adresse invalide'); this._reprogrammer(); return;
      }
      ws.binaryType = 'arraybuffer';
      this._ws = ws;
      let ouvert = false;

      this._minuteurConnexion = setTimeout(() => {
        this._echec = 'délai de connexion dépassé';
        this._fermer();
      }, this.opts.connectTimeout);

      ws.onopen = () => {
        ouvert = true;
        const o = this.opts;
        let drapeaux = o.clean === false ? 0 : 0x02;
        const identifiants = [];
        if (o.username !== undefined && o.username !== null) { drapeaux |= 0x80; identifiants.push(...chaine(o.username)); }
        if (o.password !== undefined && o.password !== null) { drapeaux |= 0x40; identifiants.push(...chaine(o.password)); }
        ws.send(paquet(1, 0, [...chaine('MQTT'), 4, drapeaux, o.keepalive >> 8, o.keepalive & 255,
                              ...chaine(o.clientId), ...identifiants]));
      };
      ws.onmessage = e => { if (this._ws === ws) this._recevoir(new Uint8Array(e.data)); };
      ws.onerror = () => { /* le close qui suit porte l'information utile */ };
      ws.onclose = () => {
        if (this._ws !== ws) return;
        clearTimeout(this._minuteurConnexion);
        clearInterval(this._minuteurPing);
        const etait = this.connected;
        this.connected = false;
        this._ws = null;
        if (ws.absent) { this._adresseTunnel = null; this._parTunnel = false; }   // pas de tunnel sur ce serveur
        if (etait) { this._emettre('close'); this._emettre('offline'); }
        else if (!ouvert && relaisPossible && (parTunnel || this._adresseTunnel) && !this._fini) { this._ouvrir(true); return; }
        else if (!this._fini && !this._erreurSignalee) this._erreur(this._echec || 'broker injoignable');
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
          this._parTunnel = this._ws instanceof Tunnel;
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
