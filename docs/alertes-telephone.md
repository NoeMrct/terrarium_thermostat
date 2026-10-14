# Alertes sur le téléphone, application fermée

Sans serveur, les notifications de l'application ne partent que quand elle
est ouverte. Pour être prévenu à toute heure, deux voies : le **socle
lui-même** appelle un service de notification à chaque alerte (sections 1 et
2 — deux services gratuits suffisent, rien à installer côté socle), ou le
**serveur Terrariums** auto-hébergé pousse les alertes sur le téléphone
(section 4).

## 1. Alertes avec ntfy (gratuit, sans compte)

1. Installer **ntfy** sur le téléphone (Android, iOS) ou ouvrir https://ntfy.sh.
2. Choisir un nom de sujet difficile à deviner, par exemple
   `terrarium-salon-7Qk2mZ` (quiconque connaît le nom peut lire et écrire dessus).
   S'y abonner dans l'application ntfy.
3. Sur l'interface locale du socle, onglet **Réseau** :
   - URL d'alerte : `https://ntfy.sh/terrarium-salon-7Qk2mZ`
   - Format des alertes : **texte lisible**
   - Enregistrer et redémarrer.
4. Tester : débrancher une sonde. En moins de dix secondes, le téléphone affiche
   « Terrarium terraXXXXXX — alerte : [Point chaud] Zone 1 en DEFAUT : SONDE… ».

En format texte, le socle envoie le message en clair avec les en-têtes `Title`,
`Priority` (haute pour un défaut, une chute, une chauffe sans effet) et `Tags`.
Un serveur ntfy auto-hébergé fonctionne de la même façon ; un sujet protégé par
mot de passe se configure avec le « jeton envoyé avec les alertes »
(`Authorization: Bearer …`, ntfy accepte ses jetons d'accès ainsi).

Pushover, Gotify et les webhooks Discord/Slack acceptent aussi un corps texte
avec plus ou moins de bonheur ; pour un serveur maison ou Home Assistant,
garder le format **JSON** : il porte `appareil`, `type`, `zone`, `nomZone`,
`texte`, `horodatage`.

## 2. Savoir que le socle est vivant avec healthchecks.io

Une alerte prévient d'un défaut ; rien ne prévient d'un socle qui s'est tu
(coupure de courant, Wi-Fi tombé, carte morte). Le **heartbeat** le fait.

1. Créer un compte gratuit sur https://healthchecks.io, puis un « check » avec
   une période de **10 minutes** et une grâce de 5 minutes.
2. Copier son URL de ping (`https://hc-ping.com/…`).
3. Onglet **Réseau** du socle : URL de heartbeat = cette adresse, période 5 min.
4. Choisir dans healthchecks comment être prévenu : courriel, ntfy, Telegram, SMS…

Le socle appelle l'URL toutes les cinq minutes avec son identifiant, sa version,
son uptime, ses températures et le nombre de défauts en paramètres : visibles
dans l'historique du check. Quand il se tait plus de 15 minutes, healthchecks
alerte.

## 3. Ce que l'application fait en plus

- Une notification du navigateur tant qu'elle est ouverte (onglet Appareil →
  Notifications), une pastille sur son icône avec le nombre de zones en défaut,
  une vibration sur un nouveau défaut.
- Le badge **silencieux** sur un socle annoncé en ligne mais muet depuis plus de
  deux minutes.

## 4. Avec le serveur Terrariums : notifications push

Si les socles passent par le serveur du dépôt (`serveur/`), c'est lui qui
observe les sujets MQTT et envoie une notification **Web Push** au téléphone,
application fermée : défaut apparu, défaut rétabli, socle disparu (silence
prolongé), mise à jour en échec ou retour arrière.

1. Le serveur doit être servi en HTTPS (le push l'exige) et avoir ses clés
   VAPID — il les engendre au premier démarrage dans son dossier de données ;
   `CONTACT_VAPID` déclare le contact aux services de push.
2. Dans l'application, connectée au serveur : onglet **Appareil → « Activer les
   notifications du serveur »**, puis accepter la demande du navigateur. Sur
   iPhone, l'application doit d'abord être installée sur l'écran d'accueil.
   L'application demande aussitôt au serveur une notification d'essai
   (`POST /api/push/essai`) : elle doit arriver dans la foulée.

Chaque abonnement est propre à un appareil et à un compte ; le serveur
n'envoie que les alertes des socles rattachés à ce compte. Rien n'empêche de
cumuler avec ntfy depuis le socle : les deux voies sont indépendantes.
