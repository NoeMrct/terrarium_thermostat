# Manuel du socle chauffant

Ce manuel couvre tout le parcours : déballer, flasher, brancher, régler, surveiller, dépanner. Il
s'adresse à quelqu'un qui n'a jamais ouvert un IDE. Les termes techniques sont expliqués au
passage ; les sections « pour aller plus loin » du README du dépôt restent la référence
complète.

## 1. Ce que fait le socle

Le socle régule la température de **deux zones** d'un terrarium, chacune avec sa sonde et son tapis
chauffant 12 V. Il ne chauffe **jamais deux tapis en même temps** avec une petite alimentation : c'est
structurel, pas un réglage. Il coupe le chauffage de lui-même et le dit haut et fort quand quelque
chose cloche : sonde absente ou figée, température qui dépasse la coupure maximale, chute brutale,
chauffe sans effet.

Il fonctionne seul, sans réseau. Le réseau ajoute : l'interface web locale, l'application à
distance, les alertes sur le téléphone, la domotique.

## 2. Ce qu'il faut

- Le socle monté selon le schéma du dépôt (ESP32, deux MOSFET, deux bilames, convertisseur 5 V).
- Une alimentation **12 V, 3 A** pour les tapis. Déclarer plus d'ampères qu'elle n'en a est le seul
  moyen de la surcharger : l'appareil s'y fie.
- Un câble USB **de données** (les câbles de charge n'en sont pas tous) pour le premier flashage.
- Un téléphone ou un ordinateur pour la configuration.
- Pour le pilotage à distance : un broker MQTT en WebSocket sécurisé (HiveMQ Cloud propose une
  offre gratuite suffisante).

> Règle d'or de l'atelier : **USB et 12 V ne sont jamais branchés en même temps.** Le 12 V alimente
> la carte par le convertisseur 5 V ; l'USB aussi. Les deux ensemble se disputent la carte.

## 3. Installer le firmware

Le plus simple : la page **Flasher un socle** du site, dans Chrome ou Edge, sur un ordinateur.
Branche la carte en USB, clique, choisis le port. Sur une carte neuve, accepte l'effacement
complet ; sur un socle déjà en service, refuse-le pour garder les réglages et le code d'appairage.
Juste après le flashage, la même page propose de **configurer le Wi-Fi** par le câble (protocole
Improv) : choisis ton réseau dans la liste, entre le mot de passe, c'est fait.

Sans Chrome : l'IDE Arduino, avec les réglages de carte décrits dans `INSTALLATION.md` du dépôt
(carte « ESP32 Dev Module », schéma de partition « Custom », flash 4 Mo).

## 4. Premier démarrage

1. Débranche l'USB, branche le 12 V. L'écran affiche « Thermostat terrarium » puis l'état.
2. Si le Wi-Fi n'a pas été donné au flashage, le socle ouvre un réseau **terrarium-config-XXXXXX**
   (les six derniers caractères de son identifiant ; mot de passe `terrarium1234`). Connecte ton
   téléphone dessus : la page de configuration s'ouvre d'elle-même (sinon `http://192.168.4.1`).
3. Onglet **Réseau** : ton Wi-Fi, un utilisateur et un mot de passe pour l'interface, un mot de passe
   OTA si tu veux mettre à jour sans câble, et, pour le pilotage à distance, le serveur MQTT. Enregistre :
   le socle redémarre sur ton réseau.
4. Il est ensuite joignable sur `http://terraXXXXXX.local` (son identifiant, affiché sur l'écran et
   dans l'application) ou sur son adresse IP. L'interface demande l'utilisateur et le mot de passe
   choisis ; le mot de passe ne quitte jamais le navigateur (connexion par défi).

Au tout premier démarrage, l'écran montre le **code d'appairage** pendant vingt secondes, en lettres
et en QR code. Il se retrouve ensuite dans l'onglet Réseau et avec la commande série `jeton`.

## 5. Lier les sondes aux zones

Les sondes DS18B20 ont chacune une adresse unique. Onglet **Réglages → Sondes 1-Wire détectées →
Scanner**, puis « vers zone 1 » / « vers zone 2 ». Si une seule sonde apparaît, c'est le câblage
(voir le dépannage), pas le logiciel.

La sonde va **au point chaud, sous le substrat, contre le tapis** — jamais dans l'air. Vérifie au
thermomètre infrarouge avant d'installer un animal.

## 6. Appairer dans l'application

Ouvre l'application, saisis l'adresse du broker (`wss://…:8884/mqtt`), l'identifiant et le mot de
passe fournis par ton broker. **Tester la connexion** dit tout de suite si c'est bon. Puis
**Ajouter un socle** : scanne le QR (écran du socle ou étiquette), ou tape l'identifiant
(`terraXXXXXX`) et le code d'appairage. Le socle apparaît avec ses deux zones.

L'application peut s'installer comme une vraie application (bouton « Installer l'application », ou
Partager → Sur l'écran d'accueil sur iPhone). Elle fonctionne alors hors ligne pour sa partie
interface, et se met à jour toute seule en proposant « Recharger ».

**Code de verrouillage** (bas de la liste des socles) : avec un code, le mot de passe du broker et
les codes d'appairage sont chiffrés sur le téléphone, et l'application se verrouille après le délai
choisi. Qui prend le téléphone ne peut plus chauffer un animal. Le code ne se retrouve pas : en cas
d'oubli, « Tout effacer » et réappairer (les codes sont sur les socles).

**Avec le serveur Terrariums** (`serveur/` du dépôt, auto-hébergé) à la place d'un broker nu, chaque
socle est rattaché à ton compte par la preuve de son code d'appairage, l'historique est gardé même
application fermée, et le téléphone est prévenu par notification push. L'application le détecte
toute seule à la connexion.

## 7. Régler

Dans la vue d'un socle, onglet **État** : les consignes de jour et de nuit, directement. Onglet
**Réglages** : tout le reste.

| Réglage | Ce que c'est | Valeur de départ |
|---|---|---|
| Consigne jour / nuit | Température visée, au point chaud | selon l'espèce |
| Début du jour / de la nuit | Heures de basculement | 08:00 / 20:00 |
| Rampe | Passage progressif d'une consigne à l'autre, en minutes | 45 |
| Bande | Largeur de la zone de modulation autour de la consigne | 2 °C |
| Coupure max | Au-dessus, la zone se verrouille en défaut. Sécurité absolue. | 40 °C |
| Calibration | Décalage ajouté à la mesure, si la sonde lit faux | 0 |

L'**autotune** règle lui-même la bande et le gain : lance-le une fois le terrarium en place et stable,
il fait osciller la zone pendant environ une heure, puis enregistre ce qu'il a appris.

Onglet **Appareil** : l'alimentation (ampères disponibles, puissance d'un tapis), le cyclage
saisonnier, les statistiques, la santé du socle, les sauvegardes de réglages.

## 8. Lire l'état

- **en ligne** : le socle publie. **silencieux** : il est annoncé en ligne mais n'a rien publié
  depuis plus de deux minutes — vérifie son Wi-Fi. **hors ligne** : le broker ne le voit plus. Dans
  tous les cas, le socle continue de réguler tout seul.
- **chauffe** : le tapis de cette zone est alimenté en ce moment. **demande** : ce que la régulation
  réclame, de 0 à 100 %.
- **dérive** : la température s'éloigne de la consigne depuis un moment sans qu'un défaut soit
  déclaré. Souvent : couvercle ouvert, pièce froide, tapis vieillissant.
- **DÉFAUT** : le chauffage de la zone est coupé et verrouillé. Le libellé dit pourquoi (SONDE,
  SURCHAUFFE, FIGEE…). Une fois la cause corrigée, **Lever les défauts**.

## 9. Courbes et statistiques

Les courbes sur 6 h et 24 h viennent du socle, précises à la minute. Sur 7 et 30 jours,
l'application ajoute les points qu'elle a notés en passant : ouvrir l'application de temps en
temps suffit à remplir ces courbes. Molette ou pincement pour zoomer, glisser pour se déplacer,
double-clic pour revenir. **Exporter en CSV** donne le fichier pour un tableur.

Les statistiques sur 24 h (min, max, moyenne, part du temps hors plage, heures de chauffe, kWh)
disent si un terrarium **tient** ses valeurs, pas seulement s'il les atteint.

## 10. Être prévenu

- **Notifications du navigateur** : un défaut ou une dérive affiche une notification tant que
  l'application est ouverte (même en arrière-plan). Onglet Appareil → Notifications.
- **Sur le téléphone, application fermée** : le socle appelle lui-même une adresse web à chaque
  alerte. Avec [ntfy](https://ntfy.sh), c'est gratuit et sans compte : crée un sujet, mets son adresse dans
  « URL d'alerte » de l'onglet Réseau, choisis le format « texte », installe ntfy sur le téléphone.
  Détails dans `docs/alertes-telephone.md`. Avec le serveur Terrariums : « Activer les notifications
  du serveur » dans l'onglet Appareil, et c'est le serveur qui pousse les alertes.
- **Savoir qu'il est vivant** : l'URL de heartbeat appelée toutes les cinq minutes ; avec
  [healthchecks.io](https://healthchecks.io), tu es prévenu quand le socle se tait.
- **Domotique** : la découverte Home Assistant est activable dans l'onglet Réseau ; `/metrics`
  expose les mesures pour Prometheus.

## 11. Entretenir

- **Entretien** (onglet État → Actions) : coupe le chauffage le temps de nettoyer, puis reprend tout
  seul à l'heure dite.
- **Sauvegarde des réglages** (onglet Appareil) : un fichier JSON avec consignes, horaires et
  réglages de l'appareil, à réimporter sur un socle de rechange.
- **Exporter la configuration** (bas de la liste) : l'application entière — broker et socles — pour
  changer de téléphone. Le fichier contient les codes d'appairage : garde-le pour toi.
- **Redémarrer**, **Effacer l'historique** : onglet Appareil. L'historique local de l'application est
  effacé en même temps.

## 12. Mettre à jour

- **L'application** se met à jour seule : un message « Nouvelle version disponible — Recharger »
  apparaît. Rien n'est forcé au milieu d'un réglage.
- **Le firmware** : dans l'application, onglet Appareil, la carte **Mise à jour du firmware** dit
  si une version plus récente est publiée et un bouton la fait **télécharger et installer par le socle
  lui-même** (signature vérifiée si le socle l'exige). Sinon : page Flasher un socle (USB), onglet
  Réseau de l'interface locale (envoi du fichier `.bin`, ou « Mise à jour depuis GitHub »), ou OTA
  depuis l'IDE si un mot de passe OTA est défini. Pendant l'écriture, le chauffage est coupé ; au
  redémarrage, la nouvelle version doit se déclarer saine dans la minute et demie, sinon le socle
  revient de lui-même à la version précédente — et l'application affiche « retour arrière ».

## 13. Sécurité

- Un bilame 70 °C sur chaque plaque, en série avec le tapis, et un fusible sur le 12 V : ce sont les
  protections qui ne dépendent pas du logiciel. Le README (section « Ce qui protège le matériel »)
  détaille le reste.
- Ne laisse pas un animal sur un socle dont les sondes ne sont pas vérifiées au thermomètre
  indépendant.
- Une coupure maximale réglée trop haut n'est pas une sécurité. Garde-la quelques degrés au-dessus
  de la consigne de jour, jamais plus.
- Le socle refuse les réglages hors bornes ; s'il affiche un défaut, c'est qu'il a de bonnes
  raisons. Ne « lève » un défaut qu'après avoir compris sa cause.

## 14. Dépanner

L'arbre de décision complet est dans `docs/depannage.md`. Les trois cas les plus fréquents :

- **Aucune sonde détectée** : résistance de 4,7 kΩ entre data et 3,3 V, masse commune, bornier
  mesuré à l'ohmmètre, sonde sur GPIO4.
- **hors ligne dans l'application** : le socle n'a pas de Wi-Fi ou pas de broker. Son écran affiche
  « AP » s'il n'a pas pu se connecter : il a rouvert le réseau de configuration. Sur place, la
  commande série `wifi <ssid> <mot de passe>` essaie le réseau tout de suite et dit s'il répond.
- **Port USB « accès refusé »** sous Windows : pilote CP210x manquant.

## 15. Diagnostic et aide

Le bouton **Diagnostic** (en bas de la liste des socles) assemble un rapport : version de
l'application, navigateur, état du broker, pour chaque socle sa version, son signal Wi-Fi, sa
mémoire, son dernier redémarrage, et les erreurs récentes. Il ne contient ni mot de passe ni code
d'appairage. **Copier le rapport** et le joindre à une demande d'aide fait gagner un aller-retour ;
avec le serveur Terrariums, **Envoyer au serveur** le dépose directement.

Sur le socle, la commande série `test usine` vérifie l'écran, les sondes, la mémoire, les
partitions et le Wi-Fi en une fois (`test usine oui` actionne aussi chaque MOSFET une fraction de
seconde : jamais avec un animal dessus).
