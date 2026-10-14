# Sécuriser les cartes de série (secure boot, chiffrement de flash)

Hors dépôt et **irréversible** : ces opérations brûlent des fusibles de l'ESP32.
Elles ne se font pas sur la carte de développement, et pas avant que le firmware
soit stable, parce qu'elles rendent le débogage et le reflashage plus lourds.
Elles concernent des socles vendus : chez soi, le mot de passe Wi-Fi en clair
dans la flash est un risque acceptable ; chez un client, non.

## Ce que ça apporte

| Mesure | Contre quoi |
|---|---|
| **Chiffrement de flash** | lecture de la mémoire (mots de passe Wi-Fi/MQTT, code d'appairage) par USB ou en dessoudant la puce |
| **Secure boot v2** | démarrage d'un firmware non signé par la clé du fabricant, même flashé par USB |
| **Signature des images OTA** (déjà dans le firmware, `OTA_CLE_PUBLIQUE` ; vaut pour `/api/maj` et pour la mise à jour tirée depuis GitHub) | installation d'un firmware étranger par le réseau |

## Avec le cœur Arduino ESP32

Le cœur Arduino ne gère pas lui-même ces options : on utilise `espsecure.py` et
`espefuse.py` (fournis avec esptool) après compilation.

1. Générer les clés, une fois, et les mettre à l'abri (jamais dans le dépôt) :
   ```
   espsecure.py generate_signing_key --version 2 secure_boot_signing_key.pem
   espsecure.py generate_flash_encryption_key flash_encryption_key.bin
   ```
2. Signer le bootloader et l'application :
   ```
   espsecure.py sign_data --version 2 --keyfile secure_boot_signing_key.pem --output bootloader.signed.bin bootloader.bin
   espsecure.py sign_data --version 2 --keyfile secure_boot_signing_key.pem --output firmware.signed.bin firmware.bin
   ```
   Le bootloader doit avoir été compilé avec secure boot v2 activé (option
   `CONFIG_SECURE_BOOT` d'un bootloader ESP-IDF) : c'est l'étape qui fait sortir
   d'Arduino pur, à préparer avec ESP-IDF.
3. Brûler les fusibles **en mode développement d'abord** (`FLASH_CRYPT_CNT` à 1,
   réglages réversibles) pour vérifier qu'un socle démarre chiffré ; puis en mode
   « release » sur la série (`espefuse.py burn_efuse ...`, voir la documentation
   Espressif « Flash Encryption » et « Secure Boot V2 »).
4. Flasher les images chiffrées (`espsecure.py encrypt_flash_data` ou
   `esptool.py write_flash --encrypt`).

## Conséquences à connaître

- Plus de mise à jour par la page web de flashage ni par l'IDE sans la clé :
  les mises à jour passent par l'OTA (le socle chiffre lui-même ce qu'il écrit).
- Les coredumps en flash sont chiffrés eux aussi : `/api/coredump` les renvoie
  déchiffrés, c'est voulu.
- Un socle dont le secure boot est activé ne charge **que** des images signées
  avec la clé de série : la clé de développement ne suffit plus. Deux clés,
  deux usages, un coffre.
- Prévoir dans le processus de fabrication : flashage, brûlage, test de
  démarrage, étiquette d'appairage (`outils/qr-appairage.js`), et enregistrement
  de l'identifiant `terraXXXXXX` produit.
