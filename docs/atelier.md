# Atelier : monter des socles en série

La page **Atelier** du site (`atelier.html`, lien en bas de la page « Flasher un socle ») suit
chaque socle du flashage à l'étiquette, flashage compris : elle installe elle-même le firmware
publié sur une carte vierge ou en retard. Elle remplace la ligne de commande
`outils/provisionner.js` pour la fabrication courante. Le script reste disponible pour un
poste sans Chrome.

Elle s'ouvre dans **Chrome ou Edge, sur un ordinateur** : il faut le port série du navigateur
(Web Serial), qui n'existe qu'en HTTPS ou sur `localhost`.

> Règle d'or : **USB et 12 V ne sont jamais branchés en même temps.** La console USB ne sert
> qu'aux étapes 1 et 5, 12 V débranché. Les étapes 2 à 4 se font sur le banc, en 12 V, par le
> broker.

## Avant la première séance : les réglages

| Réglage | À quoi il sert |
|---|---|
| Adresse de l'application | Le lien imprimé dans le QR de l'étiquette (`https://…/#a/<id>/<code>`) : l'appareil photo du téléphone ouvre l'installation, référence et code déjà remplis. Par défaut, le site qui sert l'atelier. |
| Wi-Fi du banc | Le réseau que le socle rejoint pour les étapes 2 à 4. **Rien à saisir d'avance** : au premier socle, la page affiche les réseaux qu'il capte (du plus fort au plus faible), on touche le bon et on tape son mot de passe une fois. Connecté au serveur, il vaut ensuite pour **tous les postes de l'atelier** (le serveur le garde chiffré). La console du socle coupe aux espaces : ni le nom ni le mot de passe ne doivent en contenir. « Retenir sur cet ordinateur » (coché d'office) le garde aussi sur ce poste. |
| Liaison : **serveur Terrariums** | Chaque socle reçoit son compte d'appareil (`POST /api/admin/appareils`) et le garde chez l'acheteur. Le serveur du déploiement (variable Netlify `TERRARIUM_SERVEUR`) est réglé d'office. On s'y connecte avec un **compte de l'équipe** : administrateur, ou **rôle atelier** (voir plus bas). E-mail, « Recevoir un code », code reçu, « Se connecter ». La session reste ouverte tant que l'atelier sert au moins une fois par mois ; elle partage le registre, crée les comptes d'appareil et suit le banc par MQTT (identifiant : l'e-mail). À défaut de compte, le jeton d'administration (utilisateur MQTT `admin`) reste possible dans « Réglages avancés du serveur ». Le serveur doit accepter l'adresse de l'atelier dans `ORIGINES`. |
| Liaison : **broker de l'atelier** | Le socle se rode sur votre broker (HiveMQ, Mosquitto…). À l'expédition, l'atelier peut lui faire oublier ce broker (`mqtt off`, identifiants compris) : l'acheteur réglera le sien. |
| Liaison : **aucune** | Sans broker : les sondes, l'essai de chauffe et le rodage se font sur la page locale du socle, et l'opérateur les valide dans l'atelier. |
| Durée du rodage | 24 h par défaut, de 1 à 168 h. |
| Console USB : « Démarrer seul quand une carte est branchée » | Coché d'office. Une carte branchée sur un port que Chrome connaît déjà lance l'étape qui l'attend : 1 pour une carte neuve ou vierge, 5 pour un socle prêt. La première carte, Chrome demande le port ; ensuite il le reconnaît seul (pour toutes les cartes si leur puce USB porte le même numéro de série, sinon la fenêtre revient à chaque carte). « Nouveau socle » ne demande plus le port quand un seul est autorisé et branché. |
| Alertes (connecté au serveur) | « Par e-mail » (coché d'office) et « Notifications sur cet ordinateur ». Fin de rodage, incident, socle disparu pendant le rodage : l'équipe de l'atelier est prévenue, page fermée ou non ; les alertes proches arrivent ensemble. |

**Connecté au serveur, le registre est partagé** : tous les postes voient les mêmes socles et
les mêmes lots, à quinze secondes près. Sans serveur (broker de l'atelier, aucune liaison), il
reste gardé par **ce navigateur**. Dans les deux cas, ce navigateur garde aussi la session du
compte et, si on le fait retenir, le mot de passe du Wi-Fi du banc (chacun sous sa propre clé,
jamais dans le registre exporté). Le mot de passe du broker de l'atelier et le jeton
d'administration ne sont gardés que jusqu'à la fermeture de l'onglet.

**Le code d'appairage et le mot de passe de la page locale ne quittent jamais le poste qui a
monté le socle** : ni le serveur, ni les autres postes ne les voient. Un autre poste qui doit
continuer les étapes 2 ou 3 (commandes signées par le code) clique « Reprendre sur ce poste » :
12 V débranché, USB branché une minute, l'atelier relit le code sur la console et tire un
nouveau mot de passe de la page locale (seule l'étiquette le portera). L'étape 5 par l'USB le
fait d'elle-même.

## Les membres de l'atelier : le rôle « atelier »

Pour qu'un membre de l'équipe monte des socles sans accès aux clients :

1. Il ouvre l'application une fois et crée son compte avec son e-mail (code reçu par e-mail).
2. Un administrateur ouvre la console (`/console/`), onglet **Comptes**, sa fiche, puis
   « **Donner le rôle atelier** » (ou, sur le serveur : `node serveur.js utilisateur atelier
   <e-mail> oui`).
3. Il ouvre la page Atelier sur son ordinateur et se connecte avec son e-mail : le registre, le
   Wi-Fi du banc et les lots de l'atelier arrivent seuls.

Le rôle atelier permet : se connecter à la page Atelier, créer le compte d'appareil d'un socle
**sans propriétaire**, piloter sur le broker les socles **en cours de montage** (au registre,
pas encore expédiés, sans propriétaire). Il ne permet pas : la console, les comptes, les
clients, les socles vendus. Un socle rattaché à un client sort de son ressort, même au
registre.

## Les cinq étapes

### 1. Console (USB, 12 V débranché)

Branchez la carte en USB : l'étape démarre seule si Chrome connaît déjà le port ; sinon,
« Nouveau socle » et choisissez le port. Une carte qui ne répond pas (vierge), ou dont le firmware est plus ancien
que celui publié sur la page « Flasher un socle », reçoit d'abord ce firmware : la fenêtre
d'installation d'ESP Web Tools s'ouvre sur le même port (« Install », puis la fermer à la
fin), et l'atelier reprend la console seul. L'installation est notée au journal du socle.
L'atelier enchaîne alors :

1. `jeton` et `version` : identifiant, code d'appairage, version du firmware et du protocole.
2. Les réseaux Wi-Fi que le socle capte (scan Improv) : celui du banc s'il y est, sinon la page
   demande lequel prendre (premier socle, ou réseau du banc invisible : 5 GHz seulement, ou trop
   loin — « Essayer quand même » reste possible).
3. `test usine` : écran, sondes, mémoire, partitions, Wi-Fi, courant. Un échec arrête tout,
   avec l'organe en cause.
4. `motdepasse web <mdp> admin` : le mot de passe de la page locale est tiré dans le
   navigateur (12 caractères, sans `i l o 0 1`). Il sera imprimé sur l'étiquette.
5. `wifi <ssid> <mdp>` : le socle essaie le Wi-Fi du banc et ne l'enregistre que s'il répond.
6. `mqtt …` : le compte sur le serveur ou le broker de l'atelier.

Débranchez ensuite l'USB et branchez le 12 V : le socle rejoint le banc.

### 2. Sondes

Dès que le socle est en ligne, l'atelier lit le bus (deux sondes attendues). Cliquez
« Identifier la zone 1 » et serrez la sonde de cette zone dans la main. Le socle la reconnaît
dès qu'elle a pris 1 °C (2 min au plus) et la lie à sa zone ; **l'identification de la zone 2
démarre alors d'elle-même** : prenez la seconde sonde. Si aucune sonde ne bouge, l'atelier le
dit : serrez plus longtemps, sinon vérifiez le câblage.

### 3. Chauffe

Posez les sondes sur leurs plaques et branchez les tapis, puis cliquez « Lancer les essais de
chauffe ». Chaque zone chauffe seule à pleine puissance, 10 minutes au plus, jusqu'au verdict
du socle : c'est bien sa sonde qui monte, une autre monte à sa place (sondes inversées), ou rien
ne bouge (12 V, tapis, bilame, MOSFET). **Ne laissez pas un essai sans surveillance.**

### 4. Rodage

Le socle tourne seul pendant la durée réglée. **Relié au serveur Terrariums, c'est le serveur
qui le surveille, page fermée ou non** : coupures, défauts de zone et redémarrages sont notés en
direct ; à la fin, il compare la durée de marche du socle à celle du rodage (un redémarrage se
voit même sans avoir été vu passer) et conclut. L'équipe reçoit une alerte (e-mail groupé,
notification) : rodage réussi, échoué, incident, socle disparu plus de cinq minutes. Un socle
hors ligne à la fin est attendu une demi-heure, puis le rodage échoue.

Avec le broker de l'atelier, c'est la page qui surveille, tant qu'elle reste ouverte, et qui
conclut à la fin de la même façon. Avec un redémarrage ou un défaut, le rodage échoue. On peut
le recommencer, l'accepter malgré tout (c'est noté au journal du socle) ou mettre le socle de
côté.

### 5. Étiquette et expédition (USB de nouveau, 12 V débranché)

Branchez le socle prêt en USB : l'étape démarre seule (sinon « Vérifier et préparer »). Elle
relit l'identité sur la console. Ainsi, l'étiquette ne peut pas partir sur un autre socle.
L'atelier envoie ensuite :

- `wifi off` : le socle oublie le Wi-Fi du banc et ouvrira son point d'accès de configuration
  dès le premier démarrage chez l'acheteur ;
- `mqtt off`, avec le broker de l'atelier si le réglage est coché ;
- `effacer-historique` : l'acheteur part d'une courbe vierge.

**L'étiquette part à l'imprimante d'elle-même** (« Réimprimer l'étiquette » au besoin), à 62 mm
de large (rouleau d'étiquettes courant ; sur une feuille A4, il suffit de la découper). Elle
porte le QR à lien, la référence, le code d'appairage et le mot de passe de la page locale. Elle
se télécharge aussi en SVG.

Collez l'étiquette sous le socle, puis cliquez « Étiquette collée : marquer comme expédié ».
Le code d'appairage et le mot de passe sont alors **effacés de l'atelier** : ils ne sont plus
que sur l'étiquette. En cas de perte, ils se régénèrent sur la console (`jeton nouveau`,
`motdepasse web …`).

Un firmware antérieur à `wifi off` cherche un réseau nommé « off » et n'efface rien. L'atelier
le signale sans bloquer : chez l'acheteur, ce socle ouvrira son point d'accès au bout de trois
minutes sans réseau.

## Lots, mise de côté, registre

- **Lot** : les socles nouvellement enregistrés vont dans le lot en cours. « Nouveau lot » en
  commence un autre.
- **Mettre de côté** (avec une raison) sort un socle de la file. « Reprendre » le remet à son
  étape. Rebrancher un socle déjà connu sur « Nouveau socle » le fait recommencer à l'étape 1
  (retour SAV, réparation).
- **Registre (CSV)** : un socle par ligne avec son lot, son firmware, ses sondes, ses verdicts,
  son rodage et ses dates. Il ne contient aucun secret. Il s'ouvre dans un tableur (séparateur
  `;`).
- La **console série** se connecte aussi seule, pour taper des commandes (`help`, `status`,
  `sante`…). Les mots de passe envoyés y sont masqués.

## Dépannage

| Symptôme | Piste |
|---|---|
| Pas de port proposé | Le câble doit transporter les données (pas un câble de charge seul). Sous Windows, le pilote de la puce USB de la carte : CP210x ou CH340. |
| « Le socle ne répond pas à jeton » | Aucun firmware publié à installer (page « Flasher un socle »), ou la carte redémarre en boucle (bouton EN, puis regarder la console). |
| La fenêtre d'installation ne trouve pas la carte | Maintenir le bouton BOOT de la carte pendant le « Install », puis le relâcher quand l'écriture commence. |
| « Après l'installation, le socle ne répond pas » | Fenêtre fermée avant la fin : « Reprendre la console » recommence l'installation. |
| Wi-Fi du banc refusé | Mot de passe, ou réseau en 5 GHz seulement (l'ESP32 n'a que le 2,4 GHz) : la liste des réseaux captés le montre. |
| « Ce compte n'a pas le rôle atelier » | Un administrateur le lui donne : console → Comptes → la fiche → « Donner le rôle atelier ». |
| « Le code de ce socle est resté sur le poste qui l'a monté » | Continuer sur ce poste-là, ou « Reprendre sur ce poste » (USB, 12 V débranché). |
| « Fiche changée entre-temps » | Un autre poste (ou le serveur pendant le rodage) a écrit la fiche juste avant : la sienne est reprise, refaites l'action si besoin. |
| Une carte branchée ne lance rien | « Démarrer seul » décoché, ou Chrome ne connaît pas encore ce port : « Nouveau socle » (une fois). |
| « Serveur injoignable » | Adresse https, ou l'adresse de l'atelier absente de la variable `ORIGINES` du serveur. |
| « Session expirée » | Plus d'un mois sans servir : Réglages, se reconnecter avec le code reçu par e-mail. |
| Le socle n'apparaît pas sur le banc | Le Wi-Fi du banc, puis l'hôte et le port MQTT. `sante` sur la console donne la raison d'un refus du broker. |
