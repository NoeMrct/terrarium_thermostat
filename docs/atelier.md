# Atelier : monter des socles en série

La page **Atelier** du site (`atelier.html`, lien en bas de la page « Flasher un socle ») suit
chaque socle du flashage à l'étiquette. Elle remplace la ligne de commande
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
| Wi-Fi du banc | Le réseau que le socle rejoint pour les étapes 2 à 4. La console du socle coupe aux espaces : ni le nom ni le mot de passe ne doivent en contenir. |
| Liaison : **serveur Terrariums** | Chaque socle reçoit son compte d'appareil (`POST /api/admin/appareils`) et le garde chez l'acheteur. L'atelier suit le banc avec l'utilisateur MQTT `admin` (le jeton d'administration). Le serveur doit accepter l'adresse de l'atelier dans `ORIGINES`. |
| Liaison : **broker de l'atelier** | Le socle se rode sur votre broker (HiveMQ, Mosquitto…). À l'expédition, l'atelier peut lui faire oublier ce broker (`mqtt off`, identifiants compris) : l'acheteur réglera le sien. |
| Liaison : **aucune** | Sans broker : les sondes, l'essai de chauffe et le rodage se font sur la page locale du socle, et l'opérateur les valide dans l'atelier. |
| Durée du rodage | 24 h par défaut, de 1 à 168 h. |

Le registre (socles, lots, résultats) est gardé par **ce navigateur**. Les mots de passe
(Wi-Fi du banc, broker) et le jeton d'administration ne le sont que jusqu'à la fermeture de
l'onglet : ils sont redemandés à chaque séance.

## Les cinq étapes

### 1. Console (USB, 12 V débranché)

Un socle neuf se flashe d'abord par la page « Flasher un socle ». Ensuite, dans l'atelier, il
faut cliquer « Nouveau socle », puis « Connecter la console » et choisir le port. L'atelier
enchaîne alors :

1. `jeton` et `version` : identifiant, code d'appairage, version du firmware et du protocole.
2. `test usine` : écran, sondes, mémoire, partitions, Wi-Fi, courant. Un échec arrête tout,
   avec l'organe en cause.
3. `motdepasse web <mdp> admin` : le mot de passe de la page locale est tiré dans le
   navigateur (12 caractères, sans `i l o 0 1`). Il sera imprimé sur l'étiquette.
4. `wifi <ssid> <mdp>` : le socle essaie le Wi-Fi du banc et ne l'enregistre que s'il répond.
5. `mqtt …` : le compte sur le serveur ou le broker de l'atelier.

Débranchez ensuite l'USB et branchez le 12 V : le socle rejoint le banc.

### 2. Sondes

Dès que le socle est en ligne, l'atelier lit le bus (deux sondes attendues). Pour chaque zone,
cliquez « Identifier la zone N » et serrez la sonde de cette zone dans la main. Le socle la
reconnaît dès qu'elle a pris 1 °C (2 min au plus) et la lie à sa zone. Si aucune sonde ne bouge,
l'atelier le dit : serrez plus longtemps, sinon vérifiez le câblage.

### 3. Chauffe

Posez les sondes sur leurs plaques et branchez les tapis, puis cliquez « Lancer les essais de
chauffe ». Chaque zone chauffe seule à pleine puissance, 10 minutes au plus, jusqu'au verdict
du socle : c'est bien sa sonde qui monte, une autre monte à sa place (sondes inversées), ou rien
ne bouge (12 V, tapis, bilame, MOSFET). **Ne laissez pas un essai sans surveillance.**

### 4. Rodage

Le socle tourne seul pendant la durée réglée. Tant que la page reste ouverte, l'atelier note les
coupures, les défauts de zone et les redémarrages. À la fin, il demande au socle depuis quand il
tourne : un socle qui a redémarré pendant le rodage est repéré même si la page était fermée. Avec
un redémarrage ou un défaut, le rodage échoue. On peut le recommencer, l'accepter malgré tout
(c'est noté au journal du socle) ou mettre le socle de côté.

### 5. Étiquette et expédition (USB de nouveau, 12 V débranché)

« Vérifier et préparer » relit l'identité sur la console. Ainsi, l'étiquette ne peut pas partir
sur un autre socle. L'atelier envoie ensuite :

- `wifi off` : le socle oublie le Wi-Fi du banc et ouvrira son point d'accès de configuration
  dès le premier démarrage chez l'acheteur ;
- `mqtt off`, avec le broker de l'atelier si le réglage est coché ;
- `effacer-historique` : l'acheteur part d'une courbe vierge.

L'étiquette s'imprime à 62 mm de large (rouleau d'étiquettes courant ; sur une feuille A4,
il suffit de la découper). Elle porte le QR à lien, la référence, le code d'appairage et le mot de
passe de la page locale. Elle se télécharge aussi en SVG.

Cochez « Étiquette collée sous le socle », puis cliquez « Marquer comme expédié ». Le code
d'appairage et le mot de passe sont alors **effacés de l'atelier** : ils ne sont plus que sur
l'étiquette. En cas de perte, ils se régénèrent sur la console (`jeton nouveau`,
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
| Pas de port proposé | Le câble doit transporter les données (pas un câble de charge seul). Sous Windows, le pilote CP210x. |
| « Le socle ne répond pas à jeton » | Le firmware n'est pas flashé, ou la carte redémarre en boucle (bouton EN, puis regarder la console). |
| Wi-Fi du banc refusé | Mot de passe, ou réseau en 5 GHz seulement (l'ESP32 n'a que le 2,4 GHz). |
| « Serveur injoignable » | Adresse https, ou l'adresse de l'atelier absente de la variable `ORIGINES` du serveur. |
| Le socle n'apparaît pas sur le banc | Le Wi-Fi du banc, puis l'hôte et le port MQTT. `sante` sur la console donne la raison d'un refus du broker. |
