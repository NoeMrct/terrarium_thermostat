'use strict';
/* Envoi d'e-mails par SMTP, sans dépendance.
   -----------------------------------------------------------------------------
   Une adresse de la forme :
     smtps://utilisateur:motdepasse@smtp.exemple.fr        TLS dès la connexion (465)
     smtp://utilisateur:motdepasse@smtp.exemple.fr:587      STARTTLS exigé
   Tous les fournisseurs d'e-mail transactionnel parlent SMTP : le choix du
   fournisseur reste un réglage, pas du code. Le texte en clair n'est accepté
   que vers un relais local (localhost) qui ne propose pas STARTTLS.
   Authentification PLAIN (sous TLS), un message par connexion : les codes de
   connexion sont rares, et une connexion courte ne reste jamais à moitié
   ouverte. Corps en base64 (UTF-8 sûr), sujet encodé selon la RFC 2047. */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const LOCAL = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/;

class Courriel {
  constructor(adresse, { de, delaiMs = 20000, hoteEhlo = 'terrariums' } = {}) {
    const u = new URL(adresse);
    if (!/^smtps?:$/.test(u.protocol)) throw new Error('SMTP_URL : smtp:// ou smtps:// attendu');
    this.hote = u.hostname;
    this.implicite = u.protocol === 'smtps:';
    this.port = +u.port || (this.implicite ? 465 : 587);
    this.utilisateur = decodeURIComponent(u.username);
    this.motDePasse = decodeURIComponent(u.password);
    this.de = de || `Terrariums <ne-pas-repondre@${this.hote}>`;
    this.delaiMs = delaiMs;
    this.hoteEhlo = hoteEhlo;
  }

  static adresseDe(entete) {
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(entete);
    return m ? m[1] : String(entete).trim();
  }

  static sujetEncode(s) {
    return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  }

  message({ a, sujet, texte }) {
    const corps = Buffer.from(texte, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
    const domaine = Courriel.adresseDe(this.de).split('@')[1] || 'terrariums';
    return [
      `From: ${this.de}`,
      `To: <${a}>`,
      `Subject: ${Courriel.sujetEncode(sujet)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domaine}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'Auto-Submitted: auto-generated',
      '',
      corps
    ].join('\r\n');
  }

  /** Envoie un message ; rejette avec la réponse du serveur en cas de refus. */
  envoyer({ a, sujet, texte }) {
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(String(a || ''))) return Promise.reject(new Error('destinataire invalide'));
    return new Promise((resoudre, rejeter) => {
      let socket = null, tampon = '', attente = null, fini = false;
      const minuteur = setTimeout(() => terminer(new Error('SMTP : délai dépassé')), this.delaiMs);
      const terminer = err => {
        if (fini) return;
        fini = true;
        clearTimeout(minuteur);
        try { socket.end(); } catch (e) { /* déjà fermé */ }
        err ? rejeter(err) : resoudre();
      };
      // Une réponse SMTP : lignes « 250-… » puis une ligne « 250 … ».
      const surDonnees = d => {
        tampon += d.toString('utf8');
        let fin;
        while ((fin = tampon.indexOf('\r\n')) >= 0) {
          const ligne = tampon.slice(0, fin); tampon = tampon.slice(fin + 2);
          if (!attente) continue;
          attente.lignes.push(ligne);
          if (/^\d{3} /.test(ligne) || /^\d{3}$/.test(ligne)) { const a_ = attente; attente = null; a_.resoudre({ code: +ligne.slice(0, 3), lignes: a_.lignes }); }
        }
      };
      const reponse = () => new Promise(r => { attente = { lignes: [], resoudre: r }; });
      const brancher = s => {
        socket = s;
        s.on('data', surDonnees);
        s.on('error', e => terminer(new Error('SMTP : ' + e.message)));
        s.on('close', () => terminer(new Error('SMTP : connexion fermée par le serveur')));
      };
      const commande = async (ligne, attendu) => {
        const r = reponse();
        socket.write(ligne + '\r\n');
        const rep = await r;
        if (!attendu.includes(rep.code)) {
          const visible = ligne.startsWith('AUTH') ? 'AUTH' : ligne.slice(0, 40);
          throw new Error(`SMTP : « ${visible} » refusé (${rep.lignes.join(' ').slice(0, 160)})`);
        }
        return rep;
      };
      const dialogue = async () => {
        const accueil = await reponse();
        if (accueil.code !== 220) throw new Error('SMTP : accueil inattendu');
        const ehlo = await commande(`EHLO ${this.hoteEhlo}`, [250]);
        if (!this.implicite) {
          if (ehlo.lignes.some(l => /^250[ -]STARTTLS/i.test(l))) {
            await commande('STARTTLS', [220]);
            socket.removeListener('data', surDonnees);
            const brut = socket;
            socket = null;
            await new Promise((ok, ko) => {
              const s = tls.connect({ socket: brut, servername: this.hote }, () => ok());
              brancher(s);
              s.once('error', ko);
            });
            tampon = '';
            await commande(`EHLO ${this.hoteEhlo}`, [250]);
          } else if (!LOCAL.test(this.hote)) {
            throw new Error('SMTP : le serveur ne propose pas STARTTLS ; texte en clair refusé hors relais local');
          }
        }
        if (this.utilisateur) {
          const jeton = Buffer.from(`\0${this.utilisateur}\0${this.motDePasse}`, 'utf8').toString('base64');
          await commande(`AUTH PLAIN ${jeton}`, [235]);
        }
        await commande(`MAIL FROM:<${Courriel.adresseDe(this.de)}>`, [250]);
        await commande(`RCPT TO:<${a}>`, [250, 251]);
        await commande('DATA', [354]);
        // Point en tête de ligne doublé (RFC 5321, 4.5.2).
        const texte_ = this.message({ a, sujet, texte }).replace(/(^|\r\n)\./g, '$1..');
        await commande(texte_ + '\r\n.', [250]);
        try { socket.write('QUIT\r\n'); } catch (e) { /* tant pis */ }
      };
      const demarrer = () => dialogue().then(() => terminer(), terminer);
      if (this.implicite) {
        const s = tls.connect({ host: this.hote, port: this.port, servername: this.hote }, demarrer);
        brancher(s);
      } else {
        const s = net.connect({ host: this.hote, port: this.port }, demarrer);
        brancher(s);
      }
    });
  }
}

module.exports = { Courriel };
