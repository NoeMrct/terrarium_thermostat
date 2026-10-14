# Fiche sécurité — socle chauffant

À lire avant de brancher, à garder avec le socle. Un terrarium chauffé est une
source de chaleur sous un animal qui ne peut pas s'en éloigner : les protections
sont là pour qu'une panne coupe, jamais pour qu'elle chauffe.

## Électricité

- Les tapis sont en **12 V** : l'alimentation 230 V → 12 V doit être un bloc
  certifié (marquage CE, double isolation), d'au moins 3 A, posé à l'air libre.
- **USB et 12 V ne sont jamais branchés ensemble** sur la carte. Pour flasher,
  on débranche le 12 V ; pour faire fonctionner, on débranche l'USB.
- Le convertisseur LM2596 est réglé à **5,00 V à vide** avant d'être relié à la
  carte. Une erreur de potentiomètre détruit l'ESP32.
- Un **fusible** sur le 12 V (3 A, rapide) protège les fils en cas de court-circuit
  d'un tapis ou d'un MOSFET. Sans fusible, pas de mise en service définitive.
- Masse en étoile sur un bornier : toutes les masses au même point.

## Chaleur

- Un **bilame KSD9700 70 °C NC** par plaque, en série avec le tapis, en amont du
  MOSFET : il coupe le tapis même si tout le logiciel est mort. Il ne se
  remplace pas par un réglage.
- Un **thermofusible** (par exemple 84 °C) collé à la plaque, en série avec le 12 V,
  coupe définitivement en cas de bilame bloqué. À ajouter avant un animal.
- La **sonde va au point chaud, sous le substrat, contre le tapis**. Dans l'air,
  elle lit une température plus basse que celle que l'animal touche : le socle
  chauffera plus que prévu.
- Vérifier au **thermomètre infrarouge** la température de surface réelle avant
  d'installer un animal, puis une fois par mois.
- La **coupure maximale** est réglée quelques degrés au-dessus de la consigne de
  jour. C'est un verrou : au-dessus, la zone se coupe et ne redémarre qu'à la main.

## Logiciel

- Le socle régule seul, sans réseau. Perdre le Wi-Fi, le broker ou le téléphone
  ne change rien à la température.
- Un **défaut** (sonde, surchauffe, sonde figée, chute brutale, chauffe sans
  effet) coupe la zone et le dit sur l'écran, dans l'application, par alerte.
  On ne lève un défaut qu'après avoir compris sa cause.
- Pendant une **mise à jour**, le chauffage est coupé ; au redémarrage, une
  version qui plante est annulée automatiquement. Le socle ne télécharge un
  firmware que sur ordre, en HTTPS, depuis les releases du projet, et vérifie
  la signature si elle est exigée.
- **Accès** : l'interface locale demande un mot de passe (connexion par défi,
  session de 24 h), le pilotage à distance exige le code d'appairage, et
  l'application peut se verrouiller par un code qui chiffre ces secrets sur le
  téléphone. Qui prend le téléphone ne peut pas chauffer l'animal.
- Le socle ne chauffe jamais plus de tapis que l'alimentation déclarée n'en
  supporte. **Déclarer 3 A pour une alimentation 3 A**, pas plus.

## Avant un animal

1. Montage conforme au schéma, contrôles hors tension faits (continuités, pas
   de court-circuit 12 V ↔ masse).
2. Fusible et bilames en place, thermofusible collé.
3. Sondes liées aux bonnes zones, températures cohérentes entre la sonde, le
   thermomètre IR et un thermomètre indépendant.
4. Consignes, coupure maximale et alimentation réglées ; un cycle jour/nuit
   complet observé sur les courbes sans défaut ni dérive.
5. Alertes testées (une sonde débranchée doit produire une alerte sur le téléphone).
