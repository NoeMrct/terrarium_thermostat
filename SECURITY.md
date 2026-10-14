# Sécurité

## Signaler une faille

Un problème de sécurité ne se signale pas dans une issue publique : utilisez
**Security → Report a vulnerability** sur le dépôt GitHub (avis de sécurité
privé). Décrivez ce qui est affecté (firmware, application, interface locale,
protocole MQTT), comment reproduire, et ce qu'un attaquant obtiendrait. Une
réponse est donnée sous une semaine ; un correctif publié est crédité à son
auteur s'il le souhaite.

## Ce que le projet protège, et comment

- **Le socle** : interface web locale à mot de passe (connexion par
  défi/réponse SHA-256 — le mot de passe ne circule pas —, session `HttpOnly`
  `SameSite=Strict` de 24 h, comparaison à durée constante, pause après cinq
  échecs), en-tête anti-requête-forgée sur toute action, OTA réseau désactivée
  tant qu'aucun mot de passe n'est défini, images de mise à jour signées
  (ECDSA P-256) quand une clé publique est compilée, mise à jour tirée limitée
  aux releases du dépôt en HTTPS avec certificat vérifié, retour arrière
  automatique après une mise à jour qui plante, point d'accès de secours à mot
  de passe obligatoire et propre à chaque socle, compilation reproductible et
  binaires de release attestés (`gh attestation verify`).
- **Le protocole** : toute action modifiante exige le code d'appairage du socle,
  qui n'est jamais publié ; MQTT chiffré (TLS, magasin d'autorités du cœur ESP32)
  vers un broker distant ; commandes rejouées sans effet.
- **L'application** : aucun serveur obligatoire, aucun compte ; politique de
  sécurité du contenu stricte (scripts du site seulement, Trusted Types :
  toute écriture HTML passe par une seule politique), en-têtes HSTS, nosniff,
  pas d'iframe ; adresses de broker non chiffrées refusées hors développement ;
  code de verrouillage facultatif qui chiffre le mot de passe du broker et les
  codes d'appairage sur l'appareil (PBKDF2 300 000 tours, AES-GCM-256) ;
  bibliothèque de flashage copiée dans le dépôt et vérifiée par somme SHA-256.
- **Le serveur** (facultatif, `serveur/`) : mots de passe `scrypt`, sessions à
  jeton, dix échecs par adresse et par quart d'heure, droits par socle
  appliqués par le broker lui-même, rattachement d'un socle uniquement par la
  preuve de son code d'appairage, API d'administration à jeton séparé.

## Ce qui n'est pas couvert

- La flash du socle n'est pas chiffrée et le démarrage sécurisé n'est pas
  activé : quelqu'un qui a l'appareil en main peut lire sa mémoire (mots de
  passe Wi-Fi et MQTT compris) ou le reflasher par USB. `docs/securisation-serie.md`
  décrit comment activer secure boot et le chiffrement de flash sur des cartes
  destinées à la vente — opérations irréversibles, hors du dépôt.
- L'interface locale est en HTTP sur le réseau domestique : le mot de passe ne
  circule plus en clair (défi/réponse), mais le cookie de session et les
  données, si. Elle n'est pas prévue pour être exposée sur Internet ; le
  pilotage à distance passe par MQTT/TLS.
- Le serveur et le socle acceptent les redirections de GitHub vers ses serveurs
  d'objets : une compromission de GitHub lui-même n'est pas dans le modèle de
  menace (la signature des images, elle, y résisterait).

## Versions prises en charge

| Version | Prise en charge |
|---|---|
| 3.4.x (dernière release) | Correctifs de sécurité et de fonctionnement |
| 3.3.x | Correctifs de sécurité seulement, jusqu'à la release 3.5 |
| ≤ 3.2 | Aucune : mettre à jour (les socles en 3.3 se mettent à jour depuis l'application) |

Un correctif de sécurité est publié comme une release ordinaire (étiquette,
binaires attestés, notes) et annoncé dans un avis de sécurité GitHub. Pour un
produit vendu, le Cyber Resilience Act attend un engagement de durée de support
et une adresse de notification : `docs/conformite.md` liste ce qu'il reste à
renseigner ici avant la mise sur le marché.
