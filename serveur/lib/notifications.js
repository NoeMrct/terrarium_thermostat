'use strict';
/* Notifications push (Web Push, VAPID) : les propriétaires d'un socle sont
   prévenus sur leur téléphone, application fermée, d'un défaut, d'un retour à
   la normale, d'un socle qui disparaît, d'une mise à jour en échec. La paire de
   clés VAPID est engendrée au premier démarrage (donnees/vapid.json) ; la clé
   publique est donnée à l'application, qui s'abonne auprès de son navigateur. */

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

class Notifications {
  constructor(dossier, options = {}) {
    this.chemin = path.join(dossier, 'vapid.json');
    this.contact = options.contact || 'mailto:admin@example.invalid';
    this.envoyer = options.envoyer || ((abonnement, charge, opts) => webpush.sendNotification(abonnement, charge, opts));
    try { this.cles = JSON.parse(fs.readFileSync(this.chemin, 'utf8')); }
    catch (e) {
      this.cles = webpush.generateVAPIDKeys();
      fs.mkdirSync(dossier, { recursive: true });
      fs.writeFileSync(this.chemin, JSON.stringify(this.cles, null, 1), { mode: 0o600 });
    }
    webpush.setVapidDetails(this.contact, this.cles.publicKey, this.cles.privateKey);
    this.derniers = {};            // clé d'anti-répétition -> instant
    this.antiSpamMs = options.antiSpamMs || 30 * 60000;
    this.envoyes = 0;
    this.echecs = 0;
  }

  clePublique() { return this.cles.publicKey; }

  // Envoie à tous les abonnements d'un utilisateur ; retire ceux que le service
  // de push déclare morts (410 Gone, 404). Renvoie le nombre d'envois réussis.
  async notifier(comptes, login, notification, cleAntiSpam) {
    if (cleAntiSpam) {
      const avant = this.derniers[cleAntiSpam] || 0;
      if (Date.now() - avant < this.antiSpamMs) return 0;
      this.derniers[cleAntiSpam] = Date.now();
    }
    const charge = JSON.stringify({ titre: notification.titre, corps: notification.corps, socle: notification.socle, tag: notification.tag || notification.socle, urgent: !!notification.urgent });
    let reussis = 0;
    for (const a of comptes.abonnementsPush(login)) {
      try {
        await this.envoyer(a, charge, { TTL: 3600, urgency: notification.urgent ? 'high' : 'normal' });
        reussis++; this.envoyes++;
      } catch (e) {
        this.echecs++;
        if (e && (e.statusCode === 410 || e.statusCode === 404)) comptes.retirerAbonnementPush(login, a.endpoint);
      }
    }
    return reussis;
  }

  async notifierProprietaires(comptes, socle, notification, cleAntiSpam) {
    let n = 0;
    for (const u of comptes.proprietaires(socle)) n += await this.notifier(comptes, u.login, notification, cleAntiSpam ? `${cleAntiSpam}:${u.login}` : null);
    return n;
  }
}

module.exports = { Notifications };
