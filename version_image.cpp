/* =============================================================================
   version_image.cpp — CE QUE L'IMAGE DIT D'ELLE-MÊME
   -----------------------------------------------------------------------------
   Toute image ESP32 porte, juste après ses en-têtes, un descripteur
   d'application (esp_app_desc_t) : version, nom du projet, version d'ESP-IDF.
   Celui que fournit le cœur Arduino est générique (« arduino-lib-builder »,
   version = commit de la bibliothèque) et déclaré faible : celui-ci le
   remplace. Chaque image dit ainsi ce qu'elle est (FW_VERSION,
   « terrarium_thermostat »). Le socle le lit dans l'en-tête d'une image avant
   d'en écrire le moindre octet, pour refuser une version plus ancienne
   (anti-retour, majauto.h) ; esptool image_info et esp_app_get_description()
   le montrent aussi.

   Le reste reprend les valeurs du descripteur d'origine (révisions d'eFuse,
   page MMU) ; l'empreinte de l'ELF est écrite après coup par esptool
   (--elf-sha256-offset 0xb0). Pas d'heure de compilation : deux compilations
   du même commit restent identiques octet pour octet.
   ============================================================================= */
#include <esp_app_desc.h>
#include <sdkconfig.h>

#include "config.h"
#include "majauto.h"

static_assert(sizeof(FW_VERSION) <= 32, "FW_VERSION doit tenir dans esp_app_desc_t.version");

extern "C" const __attribute__((section(".rodata_desc"))) esp_app_desc_t esp_app_desc = {
  .magic_word = ESP_APP_DESC_MAGIC_WORD,
  .secure_version = 0,
  .reserv1 = { 0, 0 },
  .version = FW_VERSION,
  .project_name = MAJAUTO_PROJET,
  .time = "",
  .date = "",
  .idf_ver = IDF_VER,
  .app_elf_sha256 = { 0 },
  .min_efuse_blk_rev_full = CONFIG_ESP_EFUSE_BLOCK_REV_MIN_FULL,
  .max_efuse_blk_rev_full = CONFIG_ESP_EFUSE_BLOCK_REV_MAX_FULL,
  .mmu_page_size = 31 - __builtin_clz(CONFIG_MMU_PAGE_SIZE),
  .reserv3 = { 0, 0, 0 },
  .reserv2 = { 0 },
};
