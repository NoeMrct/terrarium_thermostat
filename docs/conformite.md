# Conformité réglementaire — ce qu'il faut avant de vendre un socle

Ce document est une liste de travail, pas un avis juridique : la mise sur le
marché d'un appareil électrique connecté en Union européenne engage la
responsabilité du fabricant (celui qui appose sa marque). Faire relire par un
organisme ou un conseil spécialisé avant la première vente.

## Ce qui s'applique à un socle chauffant 12 V connecté

| Texte | Pourquoi il s'applique | Ce qu'il impose |
|---|---|---|
| **Directive CEM 2014/30/UE** (compatibilité électromagnétique) | électronique à découpage (LM2596), MOSFET commutés, Wi-Fi | essais d'émission et d'immunité (EN 55032/55035 ou EN IEC 61000-6-1/-3), dossier technique, déclaration UE de conformité, marquage CE |
| **Directive RED 2014/53/UE** (équipements radio) | module Wi-Fi ESP32 | le module ESP32-WROOM-32 est certifié, mais c'est le **produit fini** qui doit être conforme : réutiliser le rapport du module n'exempte que de la partie radio ; CEM et sécurité du produit fini restent à démontrer. Depuis août 2025, exigences de cybersécurité (art. 3.3 d/e/f : protection du réseau, des données, contre la fraude) — voir ci-dessous |
| **Directive basse tension 2014/35/UE** | **ne s'applique pas** : 12 V DC, sous les 75 V DC du champ d'application | mais la sécurité générale reste due (DSGP / règlement 2023/988 sur la sécurité générale des produits) |
| **RoHS 2011/65/UE** | tout équipement électrique | substances limitées : exiger les déclarations des fournisseurs de cartes et composants |
| **DEEE 2012/19/UE** | équipement électrique et électronique | pictogramme poubelle barrée, enregistrement au registre national (ADEME en France), éco-organisme, information de l'acheteur |
| **Règlement 2023/988 (sécurité générale des produits)** | produit grand public | évaluation des risques (brûlure, incendie, blessure de l'animal), avertissements, traçabilité (numéro de lot), procédure de rappel |
| **Cyber Resilience Act (règlement 2024/2847)** | produit avec éléments numériques | obligations progressives (notification des vulnérabilités dès septembre 2026, exigences complètes en décembre 2027) : mises à jour de sécurité pendant la durée de support, pas de mot de passe par défaut commun, SBOM — voir « ce que le projet fait déjà » |
| **RGPD** | données de température rattachées à un compte, adresse IP, courriel | registre des traitements, information des personnes (`app/confidentialite.html`), durée de conservation (RETENTION_JOURS du serveur), sous-traitants (hébergeur, broker) |

L'**alimentation 12 V** doit être un bloc du commerce déjà marqué CE (LVD +
CEM + ErP) : ne jamais vendre un adaptateur sans certificat.

## Ce que le projet fait déjà (à citer dans le dossier technique)

- Sécurité fonctionnelle : un seul tapis alimenté à la fois, puissance bornée
  par l'ampérage déclaré, coupure sur sonde absente/figée/surchauffe, bilame
  70 °C en série indépendant du logiciel, pull-down de grille, chien de garde,
  retour arrière automatique après une mise à jour défaillante
  (`docs/securite.md`).
- Cybersécurité (RED 3.3, CRA) : pas d'identifiant par défaut commun — chaque
  socle a son code d'appairage aléatoire ; interface locale authentifiée par
  défi/réponse, limitation des tentatives ; MQTT chiffré (TLS) avec
  vérification de certificat ; images de mise à jour signées (ECDSA P-256)
  quand `OTA_CLE_PUBLIQUE` est renseignée ; compilation reproductible et
  attestation de provenance des binaires ; politique de signalement des
  vulnérabilités (`SECURITY.md`) ; liste des composants logiciels
  (`NOTICE.md`, `outils/bibliotheques.txt`, `package-lock.json`).
- Traçabilité : identifiant dérivé de l'adresse MAC, version du firmware et
  commit affichés et publiés, journal persistant, fiche de provisionnement par
  socle (`outils/provisionner.js`).

## Ce qui reste à faire avant la mise sur le marché

1. Essais CEM sur le produit fini en laboratoire (émission rayonnée et
   conduite, immunité ESD/surtension/RF) — prévoir des retouches : ferrite sur
   le câble 12 V, condensateurs de découplage près du LM2596, boîtier.
2. Évaluation des risques écrite (brûlure du tapis, défaillance du bilame,
   surchauffe du boîtier, câble pincé) et notice avec avertissements.
3. Dossier technique : schémas (`docs/`), nomenclature, rapports d'essais,
   déclaration UE de conformité signée, marquage CE + DEEE + identifiant du
   fabricant et numéro de lot sur le produit.
4. Enregistrement DEEE et éco-organisme ; information de reprise.
5. Durée de support des mises à jour de sécurité annoncée (CRA) et procédure
   de notification des vulnérabilités (24 h / 72 h) : `SECURITY.md` à
   compléter d'une adresse et d'un délai d'engagement.
6. Secure boot v2 et chiffrement de la flash activés en production
   (`docs/securisation-serie.md`) : sans eux, le code d'appairage et les
   identifiants Wi-Fi sont lisibles par câble.
7. Pages légales (`app/mentions-legales.html`, `app/confidentialite.html`) :
   remplacer les passages « à compléter » ; conditions de vente ; registre
   RGPD si un serveur centralisé est exploité.
8. Marquage et notice en langue du pays de vente (le manuel existe en
   français et en anglais : `docs/manuel.md`, `docs/manuel.en.md`).
