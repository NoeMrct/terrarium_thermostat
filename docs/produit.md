# Du prototype au produit — ce qui reste hors logiciel

Une liste de contrôle, pas un plan : chaque point se coche avant la première vente.

## Conformité (France / Union européenne)

- **Marquage CE** : le socle est un appareil électrique basse tension (12 V) avec
  un bloc secteur. Directives concernées : CEM 2014/30/UE (émissions et immunité
  — l'ESP32 et les MOSFET commutés rayonnent), RoHS 2011/65/UE, et RED 2014/53/UE
  parce que l'ESP32 émet en radio (module certifié : réutiliser son dossier).
  Le bloc 230 V reste un produit tiers certifié, acheté avec sa déclaration.
- **DEEE** : inscription au registre des producteurs (ADEME/SYDEREP), symbole
  poubelle barrée, filière de reprise.
- **Sécurité** : la fiche `docs/securite.md` devient la notice livrée ; les
  avertissements chaleur/animal y figurent en toutes lettres.
- **Site et application** : mentions légales et politique de confidentialité
  (pages en français et en anglais déjà en place, passages *à compléter* à
  remplir), conditions de vente si vente en ligne, médiation de la
  consommation. Le détail réglementaire (CEM, RED, CRA, DEEE, RGPD) est dans
  `docs/conformite.md`.

## Broker et comptes (voir la décision `docs/decisions/0001-broker.md`)

- Un socle vendu ne doit pas dépendre d'un broker que le client ne possède pas
  sans que ce soit dit : local sans compte, distance en option.
- HiveMQ : un identifiant par socle avec une permission limitée à
  `terrarium/<id>/#`, et un identifiant par application. Procédure dans le document
  « Mise en service ».
- Le serveur Terrariums (`serveur/`) est prêt pour un revendeur qui veut
  héberger l'option distance : comptes, droits par socle, historique, push.
  Prix de l'option, hébergement, RGPD sur les températures rattachées à un
  compte : décisions ouvertes (décision `0009`).

## Fabrication

- PCB au lieu de la breadboard (KiCad), boîtier, borniers à vis, embouts sertis.
- Processus : `outils/provisionner.js` enchaîne l'auto-test usine
  (`test usine`), le compte sur le serveur et l'étiquette QR en une commande ;
  flashage par la page web ou par USB ; fiche de démarrage rapide imprimée
  (PDF de la release) dans la boîte ; `docs/securisation-serie.md` pour les
  fusibles de l'ESP32 ; `outils/test-materiel.js` sur un exécuteur avec une
  carte branchée pour que chaque release soit essayée sur du vrai matériel.
- Pièces critiques avec leurs références exactes (MOSFET, bilame, thermofusible,
  fusible, convertisseur) et un fournisseur de secours.

## Support

- Le rapport de diagnostic de l'application et `docs/depannage.md` sont la base.
- Une adresse de contact, un délai de réponse, une politique de retour.
