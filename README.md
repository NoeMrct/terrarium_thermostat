# Thermostat de terrarium connecté

Un ESP32 qui régule la température de **deux zones** d'un terrarium, un tapis
chauffant par zone, avec cette particularité : **un seul tapis est alimenté à
la fois**. Le courant crête reste à 1,7 A au lieu de 3,3 A, ce qui permet de
tout faire tourner sur une petite alimentation 12 V — la même qui alimente la
carte, à travers un convertisseur LM2596.

Il se pilote depuis une page web, envoie des alertes, garde un historique, et
sait dire quand quelque chose ne va pas.

---

**Pour voir l'interface tout de suite** : ouvre `app/demo.html` d'un
double-clic. Aucun serveur, aucun matériel — l'application réelle avec un socle
simulé dans la page. Le guide complet est dans `INSTALLATION.md`.

---

# 1. Ce dont tu as besoin

## Le matériel

| Quoi | Combien | À quoi ça sert |
|---|---|---|
| ESP32 DevKitC (WROOM-32, 30 broches) | 1 | Le cerveau |
| Sonde DS18B20 étanche | 2 | Mesurer la température, une par zone |
| Tapis chauffant silicone 12 V 20 W | 2 | Chauffer, un par zone |
| MOSFET IRLZ44N | 2 | Interrupteurs électroniques, un par tapis |
| Écran OLED SSD1306 0,96" I²C | 1 | Affichage local (facultatif) |
| Résistance 4,7 kΩ | 1 | Pour le bus des sondes |
| Résistance 10 kΩ | 2 | Pour les grilles des MOSFET |
| Résistance 100 Ω | 2 | Pour les grilles des MOSFET |
| Thermostat bilame KSD9700 70 °C, NC, 5 A | 2 | Sécurité matérielle : un par plaque, en série avec le tapis |
| Convertisseur abaisseur LM2596 | 1 | Fabrique le 5 V de la carte à partir du 12 V |
| Embase jack DC 5,5 × 2,1 mm à bornier | 1 | Raccordement de l'alimentation |
| Alimentation 12 V, 3 A | 1 | Pour tout le montage, tapis et carte |

## Le câblage

**Pour chaque tapis** (à répéter 2 fois, avec les broches 16 et 17) :

```
   GPIO ──[100 Ω]──┬── Grille (G) du MOSFET
                   │
                [10 kΩ]
                   │
                  GND

   +12 V ──── bilame KSD9700 ──── borne (+) du tapis
   borne (−) du tapis ──── Drain (D)
   Source (S) ──── point d'étoile de masse (bornier relié au − de l'alimentation)
```

**Pour les sondes** (les deux en parallèle sur le même fil) :

```
   Fil rouge ──── 3V3
   Fil noir  ──── GND
   Fil jaune ──┬─ GPIO4
               │
            [4,7 kΩ]      ← une seule pour les deux sondes
               │
              3V3
```

**Pour l'écran** : SDA → GPIO21, SCL → GPIO22, VCC → 3V3, GND → GND.

**Pour l'alimentation de la carte** : LM2596 réglé à **5,00 V à vide**, avant
tout branchement. IN+ → +12 V, IN− → point d'étoile, OUT+ → VIN de l'ESP32,
OUT− → GND de l'ESP32. Le port USB ne sert qu'à téléverser, 12 V débranché.

**Pour le bilame** : vissé sur la plaque d'aluminium, à côté du tapis, jamais
sur le tapis lui-même. Il est normalement fermé et ouvre à 70 °C de plaque.

## Trois choses à ne pas rater

**La résistance de 10 kΩ n'est pas optionnelle.** Au démarrage de l'ESP32, ses
broches sont dans un état indéterminé pendant une fraction de seconde. Sans
cette résistance qui tire la grille vers la masse, le MOSFET peut se fermer tout
seul et le tapis chauffer sans aucun contrôle.

**Ne fais pas passer le courant des tapis par la masse de l'ESP32.** La carte
est alimentée par le LM2596 (12 V → 5,00 V, sur VIN), les tapis directement par
le 12 V. Toutes les masses se rejoignent en **un seul point** : un bornier relié
à la borne − de l'alimentation, où arrivent séparément les sources des MOSFET et
le IN− du LM2596. Le retour des tapis ne doit jamais partager un fil avec la
masse de la carte.

**La sonde va au point chaud, sous le substrat, plaquée contre le tapis.** Jamais
dans l'air. Un thermostat de tapis régule une température de contact, pas une
température ambiante — c'est ce que touche l'animal qui compte.

---

# 2. Installation

## Étape 1 — Le logiciel

Dans l'IDE Arduino :

1. **Fichier → Préférences → URL de gestionnaire de cartes**, ajouter :
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. **Outils → Type de carte → Gestionnaire de cartes**, chercher « esp32 » et
   installer le paquet d'Espressif (version 3.3.11 ou plus récente).
3. **Croquis → Inclure une bibliothèque → Gérer les bibliothèques**, installer :
   `OneWire`, `DallasTemperature`, `Adafruit GFX Library`,
   `Adafruit SSD1306`, `PubSubClient`, `ArduinoJson`.

## Étape 2 — Ouvrir le projet

Ouvre `terrarium_thermostat.ino`. Les autres fichiers apparaissent
automatiquement en onglets.

## Étape 3 — Les réglages de la carte

**Outils → Type de carte → ESP32 Dev Module**, puis :

| Réglage | Valeur | Pourquoi |
|---|---|---|
| Partition Scheme | **Custom** | Utilise le `partitions.csv` fourni |
| Flash Size | 4MB | Standard sur les DevKitC |

Le choix « Custom » est important. Les schémas prêts à l'emploi ne conviennent
pas ici : le firmware occupe 1,41 Mo, et le schéma par défaut n'offre que
1,28 Mo — il ne rentrerait même pas. Le fichier `partitions.csv` fourni donne
1,5 Mo pour le programme (avec 160 Ko de marge) et 896 Ko pour les données.

## Étape 4 — Téléverser

Branche l'ESP32 en USB (12 V débranché), choisis le bon port, et téléverse. Ouvre ensuite le
moniteur série à **115200 bauds** : le thermostat parle.

## Étape 5 — Première configuration

Aucun réseau n'est configuré au départ. L'ESP32 ouvre donc son propre point
d'accès WiFi :

- **Réseau** : `terrarium-config`
- **Mot de passe** : `terrarium1234`
- **Adresse** : http://192.168.4.1

Connecte-toi avec ton téléphone et renseigne ton WiFi dans l'onglet Réseau. Ou,
au moniteur série :

```
wifi MonReseau MonMotDePasse
redemarrer
```

Le thermostat est ensuite accessible sur **http://terrarium.local**.

## Étape 6 — Sécuriser l'accès

Par défaut l'interface est ouverte à tout le monde sur ton réseau. Trois
commandes à passer :

```
motdepasse web MonMotDePasse
motdepasse ota UnAutreMotDePasse
motdepasse ap EncoreUnAutre
```

## Étape 7 — Associer les sondes aux zones

```
scan
```

affiche les sondes trouvées avec leur numéro de série. Puis :

```
lier 0 1        (la sonde n°0 régule la zone 1)
lier 1 2        (la sonde n°1 régule la zone 2)
```

Si le compte tombe juste au premier démarrage, c'est fait automatiquement.

**Pourquoi c'est nécessaire :** les sondes partagent un seul fil, et l'ordre dans
lequel l'ESP32 les découvre n'est pas garanti d'un démarrage à l'autre. Sans
cette association figée, les deux zones pourraient s'inverser après une coupure
de courant — et chauffer chacune à la consigne de l'autre.

## Étape 8 — Régler et calibrer

Depuis la page web (onglet Réglages) ou au série :

```
jour 1 32          consigne de jour de la zone 1
nuit 1 26          consigne de nuit
heures 1 08:00 20:00
```

Laisse tourner une nuit **à vide**, compare avec un thermomètre de référence, et
corrige l'écart :

```
offset 1 -0.4      si la sonde lit 0,4 °C de trop
```

## Étape 9 — Calibrer la régulation (facultatif mais recommandé)

Une fois le terrarium en place et stabilisé :

```
autotune 1
```

La zone va volontairement osciller pendant une heure environ, puis le thermostat
en déduit ses propres réglages de régulation. Voir la section 5 pour ce qui se
passe réellement.

---

# 3. Utilisation au quotidien

## La page web

`http://terrarium.local` — quatre onglets :

- **Vue** : températures en direct, état de chauffe, courbes sur 6 h à 14 jours,
  export CSV.
- **Réglages** : tout ce qui concerne les zones (consignes, horaires, réglages
  de régulation, calibration, seuils d'alerte), bouton d'autotune.
- **Réseau** : WiFi, mots de passe, URL d'alertes, MQTT, fuseau horaire.
- **Journal** : l'historique des événements (défauts, redémarrages, changements).

## L'écran

Pour chaque zone : le nom, la consigne visée, la température actuelle en gros, et
le pourcentage de temps de chauffe demandé. En bas, l'heure et l'adresse IP.

## Le moniteur série

Tout ce qui se règle par le web se règle aussi ici. Tape `help` pour la liste.
C'est le filet de sécurité : si le WiFi ne marche pas, l'appareil reste
pilotable par le câble USB.

---

# 4. Les fonctionnalités

## Régulation à deux zones

Chaque zone a sa sonde, sa consigne, ses horaires, ses seuils. Elles sont
totalement indépendantes — sauf pour le partage du temps de chauffe.

## Puissance partagée, adaptée à ton alimentation

Au lieu d'alimenter les deux tapis en même temps (3,3 A), le thermostat leur
distribue des créneaux de 30 secondes. Combien de zones peuvent chauffer
simultanément dépend de **ce que tu déclares** :

```
alim 3          alimentation de 3 A  -> une zone à la fois
alim 5          alimentation de 5 A  -> les deux zones en même temps
alim 5 30       ...avec des tapis de 30 W
```

Le calcul tient compte d'une marge de 20 %, parce qu'une alimentation annoncée
pour 5 A ne les tient pas forcément en continu.

**Avec une seule zone à la fois**, si les deux réclament à fond simultanément,
chacune ne reçoit qu'environ la moitié du temps ; par grand froid les consignes
peuvent ne pas être atteintes. L'indicateur « charge » le dit, et l'alerte de
dérive prévient. **En passant à 5 A**, ce plafond disparaît : le banc d'essai
montre 30,1 / 16,9 °C avec une zone à la fois contre 32,0 / 28,0 °C avec deux,
dans une pièce à 0 °C.

## Cyclage saisonnier

Certaines espèces ont besoin d'une baisse progressive sur plusieurs semaines :

```
saison 5 21 60 21     -5 °C étalés sur 21 jours, 60 jours de plateau, 21 jours de remontée
saison off
```

Le décalage s'applique aux consignes de jour comme de nuit, et reste borné par
les mêmes limites de sécurité que les consignes elles-mêmes.

## Mode entretien

```
entretien 10
```

coupe le chauffage dix minutes pour nettoyer, **avec reprise automatique**. À la
différence de `off`, qui verrouille jusqu'à intervention manuelle.

## Statistiques et consommation

L'onglet Stats (ou la commande `stats`) donne, pour chaque zone : minimum,
maximum, moyenne sur 24 h, pourcentage de temps passé à plus d'un degré de la
consigne, heures de chauffe cumulées, kWh consommés, et le nombre de fois où
chaque type de défaut s'est produit depuis l'installation.

C'est ce qui permet de juger si un terrarium tient réellement ses valeurs,
plutôt qu'un instantané.

## Cycle jour / nuit

Deux consignes par zone, avec des horaires réglables et une transition
progressive (45 minutes par défaut) au lieu d'un saut brutal. L'heure vient
d'Internet (NTP).

Sans heure fiable, le thermostat **reste sur la consigne de jour et le signale**,
plutôt que d'inventer un cycle sur une heure fausse.

## Détection de pannes

Un principe guide toutes ces réactions : **on ne coupe le chauffage que lorsque
couper protège vraiment**. Un terrarium trop froid ne gagne rien à ce qu'on
arrête de le chauffer.

Le thermostat surveille cinq choses et coupe le chauffage si l'une d'elles part
en vrille (détail des méthodes en section 5) :

| Panne détectée | Réaction |
|---|---|
| Sonde débranchée ou valeur aberrante | Coupure verrouillée en ~10 s |
| Sonde bloquée sur une valeur | Avertissement à 15 min, coupure à 30 min |
| Température au-dessus du seuil absolu | Coupure immédiate |
| Chauffe sans effet (tapis mort, MOSFET HS, bilame ouvert, sonde déplacée, puissance insuffisante) | **Alerte** après 20 min de chauffe sans gain — jamais de coupure |
| Chute brutale (terrarium resté ouvert) | Alerte en quelques minutes |
| Température qui dérive sous la consigne | Alerte à 15 min |

**Un défaut ne se lève jamais tout seul.** Il faut une action explicite (`reset`
ou le bouton dans l'interface), et il survit à un redémarrage.

## Alertes et surveillance à distance

- **Alertes** : à chaque défaut ou retour à la normale, un POST JSON part vers
  une URL de ton choix (ntfy.sh, un webhook Discord, Home Assistant, n8n…). La
  charge identifie l'appareil, la zone et la nature de l'événement, ce qui
  permet de trier sans analyser une phrase :

  ```json
  { "appareil": "terraA1B2C3", "version": "3.1.0",
    "horodatage": "2026-09-10 19:04:11", "heureFiable": true,
    "type": "DEFAUT", "zone": 1, "nomZone": "Point chaud",
    "texte": "Point chaud en DEFAUT : SONDE (—) . Chauffage coupe et verrouille." }
  ```

  Types possibles : `DEFAUT`, `RETABLI`, `DERIVE`, `DERIVE_FIN`, `SONDE_FIGEE`,
  `AUTOTUNE`, `CHUTE`, `SANS_EFFET`, `INFO`. `zone` vaut `null` pour un message
  système. Un jeton partagé peut être joint (`url jeton <secret>`) : il part en
  `Authorization: Bearer …`, pour que l'URL ne soit pas le seul secret.
  L'en-tête `X-Terrarium-Appareil` porte aussi l'identifiant.
- **Heartbeat** : un appel périodique à un service extérieur du type
  healthchecks.io. **C'est la seule chose qui te préviendra si l'ESP32 meurt
  complètement** — un appareil éteint n'envoie pas d'alerte. L'appel joint
  l'identité et l'essentiel de l'état, en paramètres d'URL :
  `?id=terraA1B2C3&v=3.1.0&uptime=86400&t1=32.05&t2=27.90&defauts=0&alertes=0`.
  Avec plusieurs socles, on sait donc lequel s'est tu.

## Historique

Un point par minute, gardé dans la mémoire flash : **14 jours** avec la table de
partition fournie. Visible en courbes, exportable en CSV. Survit aux
redémarrages.

## Domotique

- **MQTT** avec découverte automatique Home Assistant : les températures,
  consignes, états de chauffe et défauts apparaissent tout seuls, et les
  consignes sont modifiables depuis HA. Chiffrement TLS disponible
  (`mqtt tls on`) pour un broker distant.
- **Pilotage à distance** par un canal de commande JSON, protégé par un code
  d'appairage propre à l'appareil. Voir `PROTOCOLE.md`.
- **Application web installable** (`app/`) qui parle directement au broker :
  liste des socles, températures en direct, réglages complets d'une zone,
  courbes, statistiques 24 h, alimentation et cyclage saisonnier, entretien,
  autotune. Elle prévient par notification quand un défaut apparaît, tant
  qu'elle est ouverte. Aucun serveur intermédiaire à héberger.
- **Prometheus** sur `/metrics` si tu préfères Grafana.

## Mise à jour sans fil (OTA)

Oui, le code se met à jour à distance comme une application, sans jamais
rebrancher de câble. Deux chemins, voir la section 6 dédiée :

- depuis l'IDE Arduino ou `espota.py`, **à condition qu'un mot de passe OTA soit
  défini** — sans lui, ArduinoOTA n'est pas démarrée du tout ;
- depuis l'onglet Réseau de l'interface web, en envoyant le fichier `.bin`, ce
  qui ne demande rien d'autre que le mot de passe de l'interface.

## Écran qui se met en veille

Ces dalles marquent quand elles affichent la même image en permanence. L'écran
s'éteint au bout de dix minutes (`ecran 10`, `ecran 0` pour ne jamais
l'éteindre), et se rallume tout seul dès qu'un défaut apparaît ou qu'une
commande est tapée. Il affiche aussi le temps restant avant la prochaine
transition jour/nuit.

## Application installable

Depuis le navigateur d'un téléphone, « Ajouter à l'écran d'accueil » installe
l'interface comme une application, avec son icône et sans barre d'adresse.

---

# 5. Comment ça marche à l'intérieur

Cette section explique les mécanismes, sans jargon.

## Le thermostat n'est pas un simple « on/off »

Un thermostat basique fait : trop froid → j'allume, trop chaud → j'éteins. Ça
marche, mais la température oscille en permanence autour de la consigne, et le
tapis passe son temps à démarrer et s'arrêter.

Ici chaque zone produit un **pourcentage de temps de chauffe** entre 0 et 100 %.
C'est le principe du **régulateur PI**, qui additionne deux idées :

- **P comme proportionnel** : plus on est loin de la consigne, plus on demande.
  À 2 °C sous la cible, on demande 100 %. À 1 °C, 50 %. À 0,2 °C, 10 %. Cette
  largeur de 2 °C s'appelle la *bande proportionnelle*.
- **I comme intégral** : le proportionnel seul se stabilise toujours un peu en
  dessous de la cible, parce qu'il faut bien un petit écart pour demander la
  chaleur qui compense les pertes. L'intégral corrige ça : il accumule
  lentement l'écart restant et rattrape ce dernier demi-degré.

**Le piège de l'intégral**, évité ici : si la zone ne peut physiquement pas
atteindre sa consigne (pièce trop froide), l'intégral gonflerait indéfiniment et
mettrait des heures à redescendre ensuite. Le code arrête donc de l'accumuler
dès que la demande est déjà saturée à 100 %.

**Le point de fonctionnement appris** : le thermostat retient en permanence le
pourcentage de chauffe dont il a besoin à l'équilibre. Après un défaut ou un
changement de consigne, il repart directement à ce niveau au lieu de laisser
l'intégral tout reconstruire de zéro.

## Le partage du temps entre les zones

Chaque zone demande un pourcentage. Il faut donc distribuer les créneaux de
30 secondes en respectant ces proportions. Le mécanisme est un **système de
crédits**, comme une monnaie :

1. À chaque créneau, chaque zone **gagne** `sa demande × 30 secondes` de crédit.
   Une zone à 100 % gagne 30 s, une zone à 30 % en gagne 9.
2. Le créneau va à la zone qui a **le plus gros crédit**, et elle le **paie**
   30 s.
3. Le crédit est plafonné, pour qu'une zone longtemps inactive n'accapare pas le
   chauffage ensuite.

Résultat : une zone à 30 % obtient environ un créneau sur trois, deux zones à
100 % alternent, et personne n'est jamais oublié.

**À l'intérieur d'une zone**, ses deux tapis se relaient en privilégiant celui
qui a le plus longtemps reposé : la chaleur se répartit au lieu de se concentrer
sur un seul point.

## L'autotune : trouver les bons réglages tout seul

La bande proportionnelle idéale dépend de ton terrarium : son volume, son
isolation, la puissance du tapis, l'endroit exact où est la sonde. Impossible à
deviner à l'avance.

La méthode utilisée s'appelle **l'essai par relais** (Åström-Hägglund). L'idée
est astucieuse : au lieu d'essayer de calculer, on **fait délibérément osciller**
le système et on regarde comment il réagit.

1. On chauffe à fond jusqu'à dépasser la consigne, puis on coupe jusqu'à passer
   dessous, en boucle.
2. On mesure deux choses : **de combien** ça oscille (l'amplitude) et **combien
   de temps** dure un aller-retour (la période).
3. Un système qui réagit fort et vite est nerveux : il lui faut une bande large.
   Un système mou et lent supporte une bande étroite. Les formules classiques de
   Ziegler-Nichols traduisent l'amplitude et la période en réglages.

**Deux précautions** prises ici :

- Le relais ne bascule qu'après un écart franc de 0,3 °C. Sans ça il
  commuterait sur le bruit de mesure de la sonde (qui a une résolution de
  0,0625 °C) et identifierait des réglages absurdes — c'est un piège dans lequel
  la première version tombait, la simulation l'a révélé.
- La zone en autotune passe **prioritaire** sur les créneaux de chauffe. Sinon
  son « à fond » ne serait qu'un demi-régime et la mesure serait faussée.

L'autotune est abandonné automatiquement s'il s'approche du seuil de sécurité,
s'il dépasse deux heures, ou si l'oscillation obtenue est trop faible pour être
exploitable.

## Reconnaître une sonde en panne

Une sonde DS18B20 ne dit pas « je suis cassée ». Il faut le déduire.

**La valeur 85,00 °C.** C'est la valeur que contient le registre de la sonde
quand aucune mesure n'a abouti. Ce n'est pas une température, c'est un « je n'ai
rien à te dire ». Le code l'ignore, et ne conclut à une panne qu'après trois
occurrences de suite — sinon un parasite isolé sur le fil couperait le
chauffage pour rien.

**La sonde figée.** Si la valeur ne bouge pas d'un cheveu pendant très
longtemps, le capteur est probablement bloqué. C'est dangereux : figée sur une
valeur basse, elle ferait chauffer indéfiniment, et la sécurité de surchauffe
— qui repose sur cette même sonde — ne se déclencherait jamais.

Mais attention au faux positif : une zone parfaitement à l'équilibre, qui ne
chauffe pas, peut légitimement afficher la même valeur pendant une heure. Le
compteur n'avance donc **que si le système essaie activement de faire bouger la
température**. La simulation avait justement révélé ce faux positif.

**La chauffe sans effet.** Si on injecte 20 W pendant vingt minutes cumulées et
que la température ne monte pas d'un demi-degré, quelque chose est cassé : tapis
grillé, MOSFET mort, ou sonde qui s'est déplacée loin de la source. Le
thermostat prévient d'abord par une alerte de dérive, puis coupe.

## La mémoire flash sans l'user prématurément

L'historique est un **anneau** : quand il est plein, les nouveaux points
remplacent les plus anciens. Le problème classique, c'est de savoir où on en
était après une coupure de courant.

La solution naïve consiste à écrire un compteur en tête de fichier à chaque
point. Mais ça veut dire 1440 réécritures par jour au même endroit, pour
16 octets utiles — la flash n'aime pas ça.

Ici, **chaque point porte son propre numéro d'ordre**, et rien n'est réécrit en
tête. Au démarrage, l'anneau contient des numéros croissants avec exactement une
rupture : c'est l'endroit où le plus ancien point côtoie le plus récent. On la
trouve par **recherche dichotomique** — on coupe l'intervalle en deux, on regarde
de quel côté est la rupture, on recommence. Quinze lectures suffisent pour
retrouver sa place dans 20 000 points.

Cet algorithme a été validé séparément sur toutes les combinaisons possibles de
capacité et de remplissage.

## Ce qui protège le matériel

**Une seule fonction pilote les sorties de puissance**, et elle est construite
pour ne jamais pouvoir en allumer deux. Elle coupe toujours avant d'allumer.

**Les broches ne sont écrites que si l'état change.** Ça paraît un détail, mais
réécrire la même valeur à chaque tour de boucle faisait retomber la grille du
MOSFET pendant deux microsecondes des milliers de fois par seconde. À chaque
fois, le transistor repassait brièvement dans un état intermédiaire où il chauffe
beaucoup. Un état correct est simplement réaffirmé toutes les 5 secondes, ce qui
ne provoque aucune coupure.

**Un chien de garde** (watchdog) redémarre l'ESP32 si le programme se fige. Au
redémarrage, les broches repassent en haute impédance et les résistances de
10 kΩ coupent les tapis — d'où leur importance.

**Le réseau ne bloque jamais la régulation.** Aucune opération réseau n'attend
plus de 4 secondes, et si le WiFi tombe, le thermostat continue tranquillement.

## La mesure de charge

Le pourcentage de « charge » affiché est calculé sur une **fenêtre glissante de
10 minutes**, découpée en 20 seaux de 30 secondes. À chaque instant on vide les
seaux devenus trop vieux et on remplit le seau courant. C'est plus juste qu'un
compteur remis à zéro périodiquement, qui ferait chuter l'affichage d'un coup.

---

# 6. Mettre à jour à distance

Une fois le WiFi configuré, **oui, le firmware se met à jour comme une
application, sans toucher à la carte**. Il y a trois façons de faire.

## Depuis l'onglet Réseau de l'interface web (rien à installer)

1. Dans l'IDE Arduino, **Croquis → Exporter les binaires compilés** : un fichier
   `terrarium_thermostat.ino.bin` apparaît à côté du croquis.
2. Ouvrir l'interface web du socle, onglet **Réseau**, section
   « Mise à jour du firmware », choisir ce fichier, téléverser.
3. Une barre de progression suit l'envoi ; l'appareil redémarre tout seul.

Cette voie ne demande **ni mot de passe OTA, ni mDNS, ni arduino-cli** : elle est
protégée par l'authentification de l'interface web, exactement comme la page qui
permet déjà de changer les réglages réseau et de redémarrer l'appareil. C'est
aussi le moyen de remettre l'OTA réseau en service quand elle a été désactivée
faute de mot de passe.

## Depuis l'IDE Arduino

1. Ouvrir le projet, **Outils → Port** : à côté des ports série apparaît une
   entrée réseau `terrarium at 192.168.x.x`.
2. La sélectionner et téléverser normalement.
3. Le mot de passe défini par `motdepasse ota` est demandé.

L'ESP32 et l'ordinateur doivent être sur le même réseau. Si l'entrée réseau
n'apparaît pas, deux causes possibles : le réseau bloque la découverte mDNS
(voir la méthode en ligne de commande ci-dessous, qui n'en a pas besoin), ou
**aucun mot de passe OTA n'est défini** — dans ce cas l'OTA réseau n'est pas
démarrée du tout, et la page web l'annonce en haut de l'écran.

## En ligne de commande

```
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=custom .
arduino-cli upload --fqbn esp32:esp32:esp32 \
  --port 192.168.1.42 --protocol network \
  --upload-field password=TON_MOT_DE_PASSE_OTA .
```

## Ce qui se passe pendant la mise à jour

**Le chauffage est coupé dès la première seconde du transfert**, et reste coupé
jusqu'à la fin. C'est délibéré : un transfert interrompu ne doit pas laisser un
tapis alimenté sans régulation derrière lui. Le transfert dure une dizaine de
secondes, la coupure est donc sans conséquence thermique.

## Pourquoi c'est sûr

L'ESP32 possède **deux emplacements pour le programme**. La nouvelle version
est écrite dans celui qui n'est pas utilisé, et la bascule n'a lieu qu'une fois
le transfert complet et vérifié. Une coupure de courant en plein téléversement
laisse donc l'ancienne version intacte, et l'appareil redémarre dessus.

C'est précisément pour garder ces deux emplacements que le projet fournit sa
propre table de partitions : le firmware occupe 1,41 Mo, et les découpages
prêts à l'emploi n'en offrent que 1,28 Mo.

## Ce qu'il faut vérifier après coup

Le numéro de version est affiché dans l'en-tête de la page web, dans l'onglet
Stats, et par la commande `version`. Après quelques mises à jour, c'est le seul
moyen fiable de savoir ce qui tourne réellement.

Les réglages, l'historique et le journal **survivent** à une mise à jour : ils
sont dans des zones de mémoire que le téléversement ne touche pas.

## Précautions

- Ne mets jamais à jour à distance quand tu n'es pas chez toi : si le nouveau
  firmware a un problème, il faut un câble USB pour en sortir.
- **L'OTA réseau ne démarre que si un mot de passe OTA est défini.** Sans lui,
  n'importe quel appareil du réseau local — un invité, une caméra compromise —
  pourrait réécrire le programme d'un montage dont dépend un animal vivant. Le
  firmware refuse donc de l'offrir, le dit dans le journal, et l'affiche en haut
  de l'interface web. `motdepasse ota <mdp>`, ou l'onglet Réseau, l'active.
- Lance les bancs d'essai avant de téléverser : `cd sim && make test`.

---

# 7. Toutes les commandes série

| Commande | Effet |
|---|---|
| `help` | La liste des commandes |
| `status` | État courant des deux zones |
| `version` | Version du firmware et date de compilation |
| `jeton [nouveau]` | Code d'appairage de l'appareil |
| `mqtt tls <on\|off>` | Chiffrer la liaison MQTT |
| `stats` | Statistiques, énergie, compteurs de défauts |
| `entretien [min]` | Coupure temporaire avec reprise automatique |
| `entretien-defaut <min>` | Durée d'entretien proposée par défaut |
| `alim <A> [W] [V]` | Puissance disponible → zones simultanées |
| `saison <°C> <jours> [plateau] [remontée]` | Cyclage saisonnier (`saison off`) |
| `ecran <minutes>` | Veille de l'afficheur (0 = jamais) |
| `scan` | Liste les sondes détectées avec leur numéro de série |
| `journal` | Les derniers événements |
| `reseau` | État WiFi, MQTT, alertes, heure |
| `nom 1 Pogona` | Renommer une zone |
| `jour 1 32` | Consigne de jour |
| `nuit 1 26` | Consigne de nuit |
| `heures 1 08:00 20:00` | Début du jour, début de la nuit |
| `rampe 1 45` | Durée de la transition, en minutes |
| `bande 1 2.0` | Bande proportionnelle |
| `ki 1 0.0006` | Gain intégral |
| `max 1 40` | Seuil de coupure absolue |
| `offset 1 -0.4` | Calibration de la sonde |
| `derive 1 3 15` | Seuil d'alerte de dérive, et délai |
| `sanseffet 1 20 0.3` | Alerte de chauffe sans effet : délai, hausse attendue |
| `chute 1 2 300` | Chute brutale : seuil en °C et fenêtre d'observation en s |
| `autotune 1` | Lancer la calibration automatique |
| `stop-autotune 1` | L'interrompre |
| `lier 0 1` | Associer la sonde n°0 à la zone 1 |
| `wifi SSID motdepasse` | Identifiants réseau |
| `motdepasse web <mdp>` | Protéger l'interface web |
| `motdepasse ota <mdp>` | Protéger les mises à jour sans fil |
| `motdepasse ap <mdp>` | Protéger le point d'accès de secours |
| `url alertes <url>` | Où envoyer les alertes (POST JSON) |
| `url heartbeat <url>` | Où envoyer le signe de vie |
| `url jeton <secret\|off>` | Jeton joint aux alertes (`Authorization: Bearer`) |
| `mqtt <serveur> [port] [user] [mdp]` | Configurer MQTT (`mqtt off` pour couper) |
| `reset` | Lever les défauts verrouillés |
| `off` | Tout couper et verrouiller |
| `effacer-historique` | Vider les courbes |
| `redemarrer` | Redémarrer |

---

# 8. L'API web

| Adresse | Méthode | Ce que ça fait |
|---|---|---|
| `/api/status` | GET | État complet en JSON |
| `/api/history?heures=24` | GET / DELETE | Points pour les courbes, ou vider l'historique |
| `/api/history.csv` | GET | Export complet |
| `/api/journal` | GET / DELETE | Lire ou vider le journal |
| `/api/sondes` | GET / POST | Lister ou associer les sondes |
| `/api/config` | POST | Modifier une zone (tous les réglages, seuils de chute compris) |
| `/api/globaux` | GET / POST | Alimentation, entretien, veille de l'écran, cyclage saisonnier |
| `/api/reseau` | GET / POST | Configuration réseau |
| `/api/reset` | POST | Lever les défauts |
| `/api/autotune?z=0` | POST / DELETE | Lancer ou interrompre un autotune |
| `/api/stats` | GET | Statistiques 24 h, énergie, compteurs de défauts |
| `/api/maintenance?minutes=10` | POST | Coupure temporaire |
| `/api/redemarrer` | POST | Redémarrer l'appareil |
| `/api/maj` | POST | Téléverser un firmware (`multipart/form-data`) |
| `/metrics` | GET | Format Prometheus |
| `/manifest.json`, `/icone.svg`, `/sw.js` | GET | Application installable |

Les requêtes qui **modifient** quelque chose exigent un en-tête maison. Un
navigateur ne l'ajoute pas sur une requête venue d'un autre site, ce qui écarte
les requêtes forgées par une page malveillante :

```
curl -X POST -H 'X-Terrarium: 1' http://terrarium.local/api/reset
```

---

# 9. Où sont rangées les données

| Donnée | Support | Détail |
|---|---|---|
| Réglages des zones, réseau, défauts | NVS | Vérifiés et corrigés à chaque chargement |
| Historique | Fichiers (LittleFS) | 14 jours avec la table fournie |
| Journal d'événements | Fichiers | Rotation automatique, jusqu'à 64 Ko |
| Alertes en attente d'envoi | Fichiers | Survivent à une coupure réseau |
| Heure de secours | NVS | Sauvegardée toutes les 10 minutes |

Les réglages relus depuis la mémoire sont systématiquement vérifiés : une valeur
aberrante (mémoire abîmée) est ramenée à sa valeur par défaut, journalisée, et
réécrite — pas seulement corrigée en RAM.

---

# 10. Le banc d'essai

Trois modules ne dépendent pas d'Arduino — le cœur de la régulation
(`controle`), l'index de l'anneau d'historique (`anneau`) et le formatage
partagé (`format`). Le dossier `sim/` les compile pour PC et les exerce :

```
cd sim
make test              les trois bancs d'essai
make regulation        19 scénarios de régulation sur un modèle thermique
make anneau            l'anneau d'historique, toutes combinaisons capacité × remplissage
make format            échappement JSON et horaires, cas piégeux compris
make sanitize          rejoue tout sous AddressSanitizer et UndefinedBehaviorSanitizer
make csv N=2           trace détaillée d'un scénario dans run.csv
```

Côté réseau et interfaces, `outils/` complète la couverture sans matériel :

```
cd outils
npm install
node test-page-web.js       l'interface web embarquée, dans un DOM sans navigateur
node construire-demo.js && node test-demo.js
node socle-simule.js &      un faux socle sur un vrai broker MQTT
node test-protocole.js      toutes les actions de PROTOCOLE.md
node test-application.js    l'application réelle, de bout en bout
```

Scénarios de régulation : stabilisation, deux zones en demande simultanée,
partage proportionnel, sonde débranchée, sonde figée, valeur 85 °C parasite,
tapis grillé, tapis mort dès le départ, surchauffe externe, cycle jour/nuit,
autotune, réglages corrompus, exclusion mutuelle, autotune en concurrence, repos
du tapis après défaut, limite de puissance relevée, mode entretien, chute
brutale, cyclage saisonnier.

**Ce banc a trouvé de vrais défauts** : le faux positif « sonde figée » sur une
zone à l'équilibre, l'alerte de dérive qui arrivait après la coupure au lieu de
la précéder, et l'autotune qui identifiait des réglages absurdes en commutant sur
le bruit de la sonde.

Il ne couvre en revanche **rien de ce qui touche au matériel** (sondes réelles,
WiFi, écran, système de fichiers) : ces parties sont compilées, relues, mais
n'ont jamais tourné sur une carte.

## Ce qui a été vérifié

- Compilation avec le cœur ESP32 3.3.11 (chaîne xtensa-esp-elf 14.2.0),
  aucun avertissement dans les fichiers du projet avec `--warnings all`. La
  version 3.2.0 occupe **1 410 759 octets**, soit 90 % de l'emplacement
  applicatif de 1,5 Mo, et 60 048 octets de RAM statique (18 %). C'est cette
  compilation qui a révélé que la partition de fichiers, nommée `littlefs`,
  était introuvable par `LittleFS.begin()` — corrigé en la nommant `spiffs`.
- Analyse statique cppcheck, exécution sous AddressSanitizer et
  UndefinedBehaviorSanitizer.
- Comportement identique de part et d'autre du repliement du compteur de temps
  interne (qui survient tous les 49,7 jours).
- Reconstruction de l'anneau d'historique : toutes les combinaisons capacité ×
  remplissage de 1 à 64, plus la capacité réelle de 20 160 points, avec
  vérification que la recherche reste dichotomique.
- Échappement JSON, y compris troncature sur tampon court et noms de zone
  contenant guillemets, antislashs et caractères de contrôle.
- Interface web embarquée : rendu, formulaires, requêtes réellement émises,
  graphique, dans un DOM sans navigateur.
- Protocole MQTT : chacune des actions documentées, avec ses refus.

Restent **non couverts** : le matériel (sondes, écran, GPIO), la pile WiFi, et
l'écriture réelle en flash. Ces parties sont relues et compilées, pas exercées.

---

# 11. Mise en service, terrarium vide

À faire **avant d'y installer un animal**, dans cet ordre :

1. `scan` renvoie bien deux sondes, avec des températures plausibles.
2. Vérifier au multimètre qu'un seul MOSFET conduit à la fois.
3. Laisser tourner une nuit et comparer aux relevés d'un thermomètre
   indépendant, puis calibrer avec `offset`.
4. Débrancher volontairement une sonde : le défaut doit apparaître en moins de
   10 secondes et le chauffage se couper.
5. Couper l'alimentation quelques minutes : au redémarrage, un défaut en cours
   doit toujours être là, et l'heure être signalée comme approximative.
6. Noter le **code d'appairage** affiché au premier démarrage (retrouvable
   ensuite par la commande `jeton`).

---

# 12. Dépannage

| Symptôme | Cause probable |
|---|---|
| `scan` ne trouve aucune sonde | Résistance de 4,7 kΩ absente, ou fil de données sur la mauvaise broche |
| Une seule sonde sur deux détectée | Soudure, ou deux sondes qui se gênent sur un fil trop long |
| Les zones semblent inversées | Association non figée : faire `scan` puis `lier` |
| Un tapis chauffe au démarrage | Résistance de 10 kΩ manquante sur la grille |
| La température n'atteint jamais la consigne | Regarder la charge : si elle est à 100 %, l'alimentation ou le tapis est sous-dimensionné |
| Alerte « chauffe sans effet » | Tapis grillé, MOSFET HS, sonde déplacée, ou puissance insuffisante. Plaque brûlante au toucher : le bilame a ouvert, la sonde n'est plus dessus |
| Alerte de chute brutale trop fréquente | Seuil trop bas pour ce terrarium : `chute <z> <degC> [s]`, ou l'onglet Réglages |
| Une zone n'atteint jamais sa consigne | Charge à 100 % : passer à une alimentation plus grosse et relever `alim` |
| Défaut « SONDE » à répétition | Mauvais contact, fil trop long, ou alimentation parasite |
| `terrarium.local` inaccessible | Certains réseaux bloquent le mDNS : utiliser l'adresse IP affichée à l'écran |
| L'appareil redémarre tout seul | Consulter le journal : la cause du redémarrage y est écrite |
| Les alertes n'arrivent pas | Vérifier l'URL ; le journal indique les abandons après 8 tentatives |
| L'autotune échoue | Terrarium pas encore stabilisé, ou tapis trop faible pour faire osciller |

---

# 13. Ce que ce montage ne fait pas

À lire avant d'y mettre un animal.

**Un firmware n'est pas une sécurité suffisante.** Le code couvre beaucoup de
modes de panne, mais il ne survit pas à un MOSFET qui claque en court-circuit :
dans ce cas le tapis chauffe en continu quoi que décide l'ESP32. Seul un organe
physique arrête ça. Ici, c'est le **bilame KSD9700** vissé sur chaque plaque, en
série avec son tapis : il ouvre à 70 °C de plaque et referme en refroidissant,
quoi qu'en pense l'ESP32. Restent absents :

- un **thermofusible** en série sur chaque tapis (coupure définitive, sans
  réarmement),
- un **fusible** sur la ligne 12 V — en court-circuit franc, c'est le bloc
  d'alimentation qui se met en sécurité.

**Une seule sonde par zone.** Sa panne n'est détectable que par les diagnostics
indirects décrits plus haut, jamais par recoupement avec une deuxième mesure.

**Un tapis mort et une puissance insuffisante sont indiscernables.** Avec une
seule sonde et sans mesure de courant, l'information n'existe pas : le tapis met
deux minutes à se faire sentir sur la sonde, ce qui interdit de conclure en
comparant les périodes de chauffe et de repos. C'est pourquoi ce diagnostic
alerte sans couper. Une mesure de courant sur la ligne 12 V lèverait l'ambiguïté
— c'est du matériel en plus.

**Une sonde bloquée pile sur une consigne déjà atteinte**, sans chauffe en
cours, reste indétectable — il n'y a alors aucune information exploitable.

**L'heure restaurée après une coupure de courant est en retard** de toute la
durée de la coupure, jusqu'à la resynchronisation. Elle est signalée comme
approximative.

**L'IRLZ44N commandé en 3,3 V n'est pas complètement saturé** (sa spécification
est donnée pour 5 V). C'est tolérable à 1,7 A, mais un IRLB8721 ou un AOD4184
serait plus franc.

**Le multiplexage plafonne chaque zone à environ 50 %** de puissance moyenne
quand les deux réclament en même temps. C'est un compromis assumé, pas un
défaut.

---

# 14. Les fichiers du projet

| Fichier | Rôle |
|---|---|
| `terrarium_thermostat.ino` | Assemble les modules, boucle principale, pilotage des sorties |
| `controle.h` / `.cpp` | Le cerveau : régulation, ordonnanceur, diagnostics, autotune. Sans dépendance Arduino |
| `anneau.h` / `.cpp` | Index du journal circulaire d'historique. Sans dépendance Arduino, donc testable sur PC |
| `format.h` / `.cpp` | Échappement JSON et horaires, partagés par le web, la console et MQTT. Idem |
| `stockage.h` / `.cpp` | Réglages, historique, journal, file d'alertes |
| `sondes.h` / `.cpp` | Bus des DS18B20, association sonde ↔ zone |
| `reseau.h` / `.cpp` | WiFi, serveur web, OTA, MQTT, alertes, métriques |
| `affichage.h` / `.cpp` | Écran OLED |
| `console.h` / `.cpp` | Commandes série |
| `page_web.h` | L'interface web, embarquée dans le programme |
| `config.h` | Brochage et cadences |
| `partitions.csv` | Découpage de la mémoire flash |
| `PROTOCOLE.md` | Pilotage à distance : sujets MQTT, commandes, sécurité |
| `app/` | Application web installable pour piloter les socles de loin |
| `app/vendor/` | Bibliothèque MQTT embarquée (version figée, pour marcher hors ligne) |
| `app/demo.html` | Démonstration autonome, ouvrable d'un double-clic — **fichier généré**, voir `outils/construire-demo.js` |
| `INSTALLATION.md` | Guide d'installation, des trois niveaux à la mise en service |
| `outils/` | Socle simulé, test du protocole, générateur d'étiquette QR |
| `.github/workflows/` | Vérification automatique à chaque modification |
| `sim/` | Le banc d'essai pour PC |
