# Protocole de pilotage à distance

Ce document décrit comment une application web ou mobile parle au socle
chauffant à travers un broker MQTT, depuis n'importe où.

---

## 1. Le principe

Le socle n'est pas joignable depuis Internet : il est derrière une box, sans
adresse publique. Il ne reçoit donc pas de connexions — **c'est lui qui se
connecte** à un broker MQTT, et il y reste attaché en permanence.

L'application fait de même. Le broker sert de point de rendez-vous entre les
deux, et personne n'a besoin d'ouvrir de port.

```
   socle ───┐                        ┌─── application web
            ├──►  broker MQTT  ◄─────┤
   socle ───┘   (rendez-vous)        └─── application mobile
```

**L'historique reste sur le socle.** Le broker ne transporte que l'état courant,
les événements et les commandes. C'est ce choix qui rend l'ensemble tenable sur
un hébergement gratuit : quelques kilo-octets par appareil et par jour, au lieu
de plusieurs méga-octets si l'on remontait chaque point de mesure.

---

## 2. Le code d'appairage

À son tout premier démarrage, le socle tire au sort un code de 24 caractères
avec le générateur aléatoire matériel de l'ESP32, l'enregistre, et **l'affiche
en grand à l'écran pendant vingt secondes**. Il est aussi écrit sur le port
série.

```
Code d'appairage : K7M2QX-4TBW9H-RPFZ3N-XCVJ8D
```

Ce code est retrouvable à tout moment :

- commande série `jeton` (il se réaffiche aussi à l'écran) ;
- onglet Réseau de l'interface web locale ;
- `jeton nouveau` en génère un autre — les applications déjà appairées devront
  alors être réappairées.

Il vaut **preuve de propriété** : quiconque le possède peut piloter le socle. Il
n'est jamais transmis en clair sur le réseau tant que MQTT est chiffré.

Pour un produit, l'imprimer sous forme de QR code collé sous l'appareil évite à
l'acheteur d'avoir à le recopier.

---

## 3. Configuration du socle

```
mqtt broker.exemple.fr 8883 utilisateur motdepasse
mqtt tls on
redemarrer
```

Vérifier ensuite avec `reseau`. Le socle publie son état toutes les vingt
secondes et se reconnecte tout seul.

Tout cela se règle aussi depuis l'onglet Réseau de l'interface web.

---

## 4. Les sujets MQTT

Avec un préfixe `terrarium` et un identifiant d'appareil `terraA1B2C3` :

| Sujet | Sens | Contenu |
|---|---|---|
| `terrarium/terraA1B2C3/statut` | socle → app | `en ligne` / `hors ligne` (persistant) |
| `terrarium/terraA1B2C3/zone1/etat` | socle → app | JSON d'état, toutes les 20 s |
| `terrarium/terraA1B2C3/zone2/etat` | socle → app | idem |
| `terrarium/terraA1B2C3/cmd` | app → socle | requête JSON |
| `terrarium/terraA1B2C3/reponse` | socle → app | réponse JSON |

Le sujet `statut` utilise le **testament** MQTT : si le socle disparaît
brutalement (coupure de courant, WiFi perdu), le broker publie lui-même
`hors ligne`. L'application le sait en quelques secondes, sans rien interroger.

---

## 5. Le canal de commande

Une seule paire de sujets transporte tout, en JSON. La surface exposée est celle
de l'interface web locale.

### Requête

```json
{ "req": "42", "action": "zone", "jeton": "K7M2QX...", "z": 0, "jour": 32.5 }
```

- `req` : identifiant libre, recopié dans la réponse pour l'apparier.
- `action` : voir le tableau ci-dessous.
- `jeton` : **obligatoire pour toute action modifiante**. Les actions de lecture
  s'en passent.

### Réponse

```json
{ "req": "42", "ok": true }
{ "req": "42", "ok": false, "erreur": "Consigne de jour hors 10-45 C" }
```

### Actions disponibles

| Action | Jeton | Paramètres | Effet |
|---|---|---|---|
| `etat` | non | — | Températures, consignes du moment **et de référence**, demande, charge, défauts, autotune, dérive, horaires, temps de fonctionnement |
| `version` | non | — | Version du firmware et date de compilation |
| `stats` | non | — | Min / max / moyenne sur 24 h, temps hors plage, énergie, compteurs de défauts |
| `historique` | non | `heures` (1-400, défaut 24), `max` (1-200, défaut 120) | Points de courbe, échantillonnés |
| `zone` | **oui** | `z`, et `nom`, `jour`, `nuit`, `bande`, `ki`, `max`, `offset`, `rampe`, `debutJour`, `debutNuit`, `deriveSeuil`, `deriveMin`, `inefficaceMin`, `inefficaceDelta`, `chuteSeuil`, `chuteSecondes` | Modifie une zone |
| `globaux` | **oui** | aucun (lecture), ou `amperes`, `watts`, `volts`, `entretienMin`, `ecranVeilleMin`, `saisonActive`, `saisonDelta`, `saisonDescenteJ`, `saisonPlateauJ`, `saisonRemonteeJ` | Lit ou modifie les réglages de l'appareil |
| `reset` | **oui** | — | Lève les défauts verrouillés |
| `entretien` | **oui** | `minutes` (0-240, 0 annule) | Coupe le chauffage temporairement, reprise automatique |
| `autotune` | **oui** | `z` | Lance la calibration automatique |
| `stop-autotune` | **oui** | `z` | L'interrompt |
| `effacer-historique` | **oui** | — | Vide les courbes |
| `alim` | **oui** | `amperes`, `watts` | Raccourci historique de `globaux` |
| `redemarrer` | **oui** | — | Redémarre le socle |

Les horaires (`debutJour`, `debutNuit`) sont en minutes depuis minuit :
`8:00` s'écrit `480`.

### Format de l'historique

Un message MQTT n'a pas de tampon extensible, contrairement à une réponse HTTP
diffusée par morceaux. Les points sont donc renvoyés **compactés**, sous forme de
tableaux plutôt que d'objets — une clé par valeur aurait triplé la taille :

```json
{
  "req": "42", "ok": true,
  "format": ["epoch", "t1", "consigne1", "t2", "consigne2"],
  "unite": "centiemes de degre",
  "pas": 12, "heures": 24, "n": 120,
  "points": [[1757520000, 3205, 3200, 2790, 2800], [1757520720, null, 3200, 2788, 2800]]
}
```

`null` marque une mesure absente. `pas` dit combien de points d'origine sépare
deux points renvoyés. **L'historique complet reste sur le socle** : ce canal n'en
transporte qu'un échantillonnage, à la demande.

### Validation

Les réglages passent **exactement les mêmes contrôles** que par l'interface
web ou la console série : la validation vit dans le cœur de régulation, elle
n'est pas réécrite pour chaque interface. Une application ne peut donc pas
placer le socle dans un état que l'interface locale refuserait.

---

## 6. Exemple d'application

```js
import mqtt from 'mqtt';

const ID = 'terraA1B2C3';
const JETON = 'K7M2QX...';
const base = `terrarium/${ID}`;

const client = mqtt.connect('wss://broker.exemple.fr:8884/mqtt', {
  username: 'app', password: '…'
});

client.on('connect', () => {
  // Attention : le joker occupe un niveau entier, « zone+/etat » est invalide.
  client.subscribe([`${base}/statut`, `${base}/+/etat`, `${base}/reponse`]);
});

client.on('message', (sujet, charge) => {
  if (sujet.endsWith('/statut')) {
    majPresence(charge.toString() === 'en ligne');
  } else if (sujet.endsWith('/etat')) {
    majZone(sujet, JSON.parse(charge));
  } else if (sujet.endsWith('/reponse')) {
    const r = JSON.parse(charge);
    (attentes[r.req] || (() => {}))(r);
    delete attentes[r.req];
  }
});

const attentes = {};
function commander(action, params = {}) {
  return new Promise((resoudre, rejeter) => {
    const req = String(Date.now());
    attentes[req] = r => (r.ok ? resoudre(r) : rejeter(new Error(r.erreur)));
    client.publish(`${base}/cmd`, JSON.stringify({ req, action, jeton: JETON, ...params }));
    setTimeout(() => {
      if (attentes[req]) { delete attentes[req]; rejeter(new Error('pas de reponse')); }
    }, 8000);
  });
}

// Passer la zone 1 à 32,5 °C le jour
await commander('zone', { z: 0, jour: 32.5 });

// Douze heures de courbe, 60 points au plus
const h = await commander('historique', { heures: 12, max: 60 });
const releves = h.points.map(([t, t1, c1]) => ({
  date: new Date(t * 1000),
  temperature: t1 === null ? null : t1 / 100,
  consigne:    c1 === null ? null : c1 / 100
}));

// Déclarer une alimentation plus grosse
const g = await commander('globaux', { amperes: 5 });
console.log(`${g.zonesSimultanees} zone(s) peuvent chauffer en même temps`);
```

**Le délai d'attente n'est pas facultatif** : un socle hors ligne ne répond pas,
et l'application doit le présenter comme tel plutôt que de rester bloquée.

---

## 7. Sécurité

| Mécanisme | Ce qu'il protège |
|---|---|
| MQTT chiffré (TLS) | Personne ne lit ni ne modifie le trafic en chemin |
| Certificats vérifiés (activé d'usine) | Personne ne se fait passer pour ton broker |
| Identifiants par appareil sur le broker | Un socle compromis ne donne pas accès aux autres |
| Jeton exigé pour les actions modifiantes | Un broker mal cloisonné ne suffit pas à piloter un socle |
| Validation dans le cœur de régulation | Aucune commande ne peut créer un réglage dangereux |
| OTA réseau désactivée sans mot de passe | Personne sur le réseau local ne réécrit le firmware |

**À faire côté broker** : un compte par appareil, avec des droits limités à ses
propres sujets. Sans ce cloisonnement, un appareil compromis pourrait écouter et
commander tous les autres — le jeton limite les dégâts, mais ne remplace pas un
cloisonnement correct.

**Ce que le jeton ne protège pas** : les actions de lecture (`etat`, `version`,
`stats`, `historique`) s'en passent délibérément, pour qu'un tableau de bord de
supervision puisse afficher l'état sans détenir de quoi modifier quoi que ce
soit. Quiconque peut s'abonner aux sujets du socle voit donc ses températures.
Si cela pose problème, c'est au cloisonnement du broker de le régler.

---

## 8. Ce que le socle continue de faire sans réseau

C'est le point le plus important pour un produit dont dépend un animal vivant.

Broker injoignable, WiFi coupé, serveur éteint : **la régulation continue à
l'identique**. Les consignes, le cycle jour/nuit, les diagnostics, les coupures
de sécurité et l'historique fonctionnent en local. L'écran affiche tout, la
console série pilote tout, et l'interface web reste accessible sur le réseau
local.

Le réseau n'ajoute que la commodité : accès de loin, alertes, courbes sur le
téléphone. Il ne conditionne jamais la sécurité de l'animal, et aucune évolution
future ne doit changer cela.
