#include "controle.h"
#include <math.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

const uint8_t ZONE_DE_TAPIS[NB_TAPIS] = { 0, 1 };

static float borne(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static uint16_t ecartCirculaire(uint16_t de, uint16_t vers) { return (uint16_t)((vers + 1440 - de) % 1440); }

const char* nomDefaut(Defaut d) {
  switch (d) {
    case DEF_SONDE:      return "SONDE";
    case DEF_SURCHAUFFE: return "SURCHAUFFE";
    case DEF_FIGE:       return "SONDE FIGEE";
    case DEF_INEFFICACE: return "CHAUFFE SANS EFFET";
    default:             return "OK";
  }
}

const char* nomNotification(TypeNotif t) {
  switch (t) {
    case NOTIF_DEFAUT:      return "DEFAUT";
    case NOTIF_RETABLI:     return "RETABLI";
    case NOTIF_DERIVE:      return "DERIVE";
    case NOTIF_DERIVE_FIN:  return "DERIVE_FIN";
    case NOTIF_SONDE_FIGEE: return "SONDE_FIGEE";
    case NOTIF_AUTOTUNE:    return "AUTOTUNE";
    case NOTIF_CHUTE:       return "CHUTE";
    case NOTIF_SANS_EFFET:  return "SANS_EFFET";
    case NOTIF_INFO:        return "INFO";
    default:                return "INCONNU";
  }
}

// ============================ RÉGLAGES =======================================

void reglagesParDefaut(ReglagesZone &r, uint8_t zone) {
  // memset volontaire, y compris sur les flottants : la structure est écrite
  // telle quelle en mémoire non volatile, et son remplissage doit être
  // déterministe jusque dans les octets de bourrage.
  memset(&r, 0, sizeof r);
  snprintf(r.nom, sizeof r.nom, "Zone %u", (unsigned)(zone + 1));
  r.consigneJour      = (zone == 0) ? 32.0f : 28.0f;
  r.consigneNuit      = (zone == 0) ? 26.0f : 24.0f;
  r.bande             = 2.0f;
  r.ki                = 0.0006f;
  r.tempMax           = 40.0f;
  r.offset            = 0.0f;
  r.debutJour         = 8 * 60;
  r.debutNuit         = 20 * 60;
  r.rampeMinutes      = 45;
  r.inefficaceMinutes = 20;
  r.inefficaceDelta   = 0.3f;    // hausse attendue sur la durée ci-dessus
  r.deriveSeuil       = 3.0f;
  r.deriveMinutes     = 15;   // volontairement plus court que inefficaceMinutes :
                              // on prévient avant de couper.
  r.chuteSeuil        = 2.0f;
  r.chuteSecondes     = 300;
}

bool reglagesValides(const ReglagesZone &r, char *erreur, size_t taille) {
  #define ECHEC(msg) do { if (erreur) snprintf(erreur, taille, msg); return false; } while (0)
  if (!(r.consigneJour >= CONSIGNE_MIN && r.consigneJour <= CONSIGNE_MAX)) ECHEC("Consigne de jour hors 10-45 C");
  if (!(r.consigneNuit >= CONSIGNE_MIN && r.consigneNuit <= CONSIGNE_MAX)) ECHEC("Consigne de nuit hors 10-45 C");
  if (!(r.bande >= BANDE_MIN && r.bande <= BANDE_MAX))                     ECHEC("Bande hors 0.2-10 C");
  if (!(r.ki >= 0.0f && r.ki <= 0.01f))                                    ECHEC("Gain integral hors 0-0.01");
  if (!(r.tempMax >= TEMPMAX_MIN && r.tempMax <= TEMPMAX_MAX))             ECHEC("Seuil max hors 20-55 C");
  if (r.tempMax <= r.consigneJour || r.tempMax <= r.consigneNuit)          ECHEC("Le seuil max doit rester au-dessus des consignes");
  if (!(fabsf(r.offset) <= OFFSET_ABS))                                    ECHEC("Offset de calibration hors +/-5 C");
  if (r.debutJour > 1439 || r.debutNuit > 1439)                            ECHEC("Heure invalide");
  if (r.debutJour == r.debutNuit)                                          ECHEC("Jour et nuit ne peuvent commencer a la meme heure");
  if (r.rampeMinutes > 240)                                                ECHEC("Rampe hors 0-240 min");
  if (r.inefficaceMinutes < 5 || r.inefficaceMinutes > 240)                ECHEC("Delai d'inefficacite hors 5-240 min");
  if (!(r.inefficaceDelta >= 0.1f && r.inefficaceDelta <= 5.0f))           ECHEC("Hausse attendue hors 0.1-5 C");
  if (!(r.deriveSeuil >= 0.5f && r.deriveSeuil <= 15.0f))                  ECHEC("Seuil de derive hors 0.5-15 C");
  if (r.deriveMinutes < 5 || r.deriveMinutes > 600)                        ECHEC("Delai de derive hors 5-600 min");
  if (!(r.chuteSeuil >= 0.5f && r.chuteSeuil <= 20.0f))                    ECHEC("Seuil de chute hors 0.5-20 C");
  if (r.chuteSecondes < 30 || r.chuteSecondes > 3600)                      ECHEC("Fenetre de chute hors 30-3600 s");
  #undef ECHEC
  return true;
}

// Réparation en place : une NVS corrompue ne doit jamais pouvoir appliquer une
// consigne aberrante. Chaque champ hors bornes revient à sa valeur par défaut.
bool assainirReglages(ReglagesZone &r, uint8_t zone, char *rapport, size_t taille) {
  ReglagesZone d; reglagesParDefaut(d, zone);
  bool corrige = false;
  char liste[160] = "";

  #define REPARE(champ, cond, nom)                                            \
    if (!(cond)) { r.champ = d.champ; corrige = true;                         \
      if (strlen(liste) < sizeof(liste) - 20) { strcat(liste, nom); strcat(liste, " "); } }

  r.nom[sizeof(r.nom) - 1] = '\0';
  bool nomOk = r.nom[0] != '\0';
  for (size_t i = 0; i < sizeof(r.nom) && r.nom[i]; i++)
    if ((unsigned char)r.nom[i] < 32) nomOk = false;
  if (!nomOk) { memcpy(r.nom, d.nom, sizeof r.nom); corrige = true; }

  REPARE(consigneJour, isfinite(r.consigneJour) && r.consigneJour >= CONSIGNE_MIN && r.consigneJour <= CONSIGNE_MAX, "jour")
  REPARE(consigneNuit, isfinite(r.consigneNuit) && r.consigneNuit >= CONSIGNE_MIN && r.consigneNuit <= CONSIGNE_MAX, "nuit")
  REPARE(bande,        isfinite(r.bande) && r.bande >= BANDE_MIN && r.bande <= BANDE_MAX, "bande")
  REPARE(ki,           isfinite(r.ki) && r.ki >= 0.0f && r.ki <= 0.01f, "ki")
  REPARE(tempMax,      isfinite(r.tempMax) && r.tempMax >= TEMPMAX_MIN && r.tempMax <= TEMPMAX_MAX, "max")
  REPARE(offset,       isfinite(r.offset) && fabsf(r.offset) <= OFFSET_ABS, "offset")
  REPARE(debutJour,    r.debutJour <= 1439, "debutJour")
  REPARE(debutNuit,    r.debutNuit <= 1439, "debutNuit")
  REPARE(rampeMinutes, r.rampeMinutes <= 240, "rampe")
  REPARE(inefficaceMinutes, r.inefficaceMinutes >= 5 && r.inefficaceMinutes <= 240, "inefficace")
  REPARE(inefficaceDelta,   isfinite(r.inefficaceDelta) && r.inefficaceDelta >= 0.1f && r.inefficaceDelta <= 5.0f, "delta")
  REPARE(deriveSeuil,       isfinite(r.deriveSeuil) && r.deriveSeuil >= 0.5f && r.deriveSeuil <= 15.0f, "derive")
  REPARE(deriveMinutes,     r.deriveMinutes >= 5 && r.deriveMinutes <= 600, "dureeDerive")
  REPARE(chuteSeuil,        isfinite(r.chuteSeuil) && r.chuteSeuil >= 0.5f && r.chuteSeuil <= 20.0f, "chute")
  REPARE(chuteSecondes,     r.chuteSecondes >= 30 && r.chuteSecondes <= 3600, "fenetreChute")
  #undef REPARE

  // Cohérences croisées, vérifiées après coup
  if (r.tempMax <= r.consigneJour || r.tempMax <= r.consigneNuit) {
    r.tempMax = d.tempMax;
    r.consigneJour = d.consigneJour;
    r.consigneNuit = d.consigneNuit;
    corrige = true;
    if (strlen(liste) < sizeof(liste) - 12) strcat(liste, "coherence ");
  }
  if (r.debutJour == r.debutNuit) {
    r.debutJour = d.debutJour; r.debutNuit = d.debutNuit; corrige = true;
    if (strlen(liste) < sizeof(liste) - 8) strcat(liste, "heures ");
  }

  if (corrige && rapport) snprintf(rapport, taille, "%s", liste);
  return corrige;
}

// ============================ CYCLE / CONSIGNE ===============================

float Controleur::consignePour(uint8_t z) const {
  const ReglagesZone &c = cfg[z];
  // Le décalage saisonnier s'ajoute à la consigne du moment, jour comme nuit.
  // Il est borné par les mêmes limites que les consignes elles-mêmes : un
  // cyclage mal réglé ne doit pas pouvoir descendre la zone n'importe où.
  const float saison = m_saison;
  if (!m_heureConnue) return borne(c.consigneJour + saison, CONSIGNE_MIN, CONSIGNE_MAX);

  const uint16_t depuisJour = ecartCirculaire(c.debutJour, m_minutes);
  const uint16_t depuisNuit = ecartCirculaire(c.debutNuit, m_minutes);

  float base;
  if (c.rampeMinutes > 0 && depuisJour < c.rampeMinutes) {
    const float k = (float)depuisJour / c.rampeMinutes;
    base = c.consigneNuit + k * (c.consigneJour - c.consigneNuit);
  } else if (c.rampeMinutes > 0 && depuisNuit < c.rampeMinutes) {
    const float k = (float)depuisNuit / c.rampeMinutes;
    base = c.consigneJour + k * (c.consigneNuit - c.consigneJour);
  } else {
    const bool estJour = depuisJour < ecartCirculaire(c.debutJour, c.debutNuit);
    base = estJour ? c.consigneJour : c.consigneNuit;
  }
  return borne(base + saison, CONSIGNE_MIN, CONSIGNE_MAX);
}

// ============================ NOTIFICATIONS ==================================

void Controleur::notifier(TypeNotif t, uint8_t z, const char *fmt, ...) {
  if (m_nbNotifs >= 10) return;               // file pleine : on ne bloque jamais
  Notification &n = m_file[m_nbNotifs++];
  n.type = t; n.zone = z;
  va_list ap; va_start(ap, fmt);
  vsnprintf(n.texte, sizeof n.texte, fmt, ap);
  va_end(ap);
}

bool Controleur::prendreNotification(Notification &n) {
  if (m_nbNotifs == 0) return false;
  n = m_file[0];
  for (uint8_t i = 1; i < m_nbNotifs; i++) m_file[i - 1] = m_file[i];
  m_nbNotifs--;
  return true;
}

// ============================ CYCLE DE VIE ===================================

bool Controleur::tapisAllume(uint8_t tapis) const {
  if (tapis >= NB_TAPIS) return false;
  return m_tapisDeZone[ZONE_DE_TAPIS[tapis]] == (int8_t)tapis;
}

uint8_t Controleur::masqueTapis() const {
  uint8_t m = 0;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (m_tapisDeZone[z] >= 0) m |= (uint8_t)(1u << m_tapisDeZone[z]);
  return m;
}

int8_t Controleur::tapisActif() const {
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (m_tapisDeZone[z] >= 0) return m_tapisDeZone[z];
  return -1;
}

void Controleur::limiterZones(uint8_t maxZones) {
  if (maxZones < 1) maxZones = 1;
  if (maxZones > NB_ZONES) maxZones = NB_ZONES;
  m_maxZones = maxZones;
}

void Controleur::maintenance(uint32_t nowMs, uint16_t minutes) {
  if (minutes == 0) { m_maintenanceFin = 0; notifier(NOTIF_INFO, 0xFF, "Maintenance terminee, regulation reprise."); return; }
  m_maintenanceFin = nowMs + (uint32_t)minutes * 60000UL;
  if (m_maintenanceFin == 0) m_maintenanceFin = 1;   // 0 signifie « inactif »
  notifier(NOTIF_INFO, 0xFF, "Maintenance : chauffage coupe pour %u min, reprise automatique.", (unsigned)minutes);
}

uint32_t Controleur::maintenanceRestanteMs(uint32_t nowMs) const {
  if (m_maintenanceFin == 0) return 0;
  const int32_t reste = (int32_t)(m_maintenanceFin - nowMs);
  return reste > 0 ? (uint32_t)reste : 0;
}

void Controleur::demarrer(uint32_t nowMs) {
  m_debutCreneau = m_dernierAvance = nowMs;
  for (uint8_t i = 0; i < NB_TAPIS; i++) m_dernierOff[i] = nowMs;
  for (uint8_t z = 0; z < NB_ZONES; z++) zone[z].integrale = zone[z].biais;
}

void Controleur::horloge(bool connue, uint16_t minutes) {
  m_heureConnue = connue;
  m_minutes = minutes;
  for (uint8_t z = 0; z < NB_ZONES; z++) zone[z].heureConnue = connue;
}

void Controleur::declencherDefaut(uint8_t z, Defaut d, uint32_t nowMs, bool compter) {
  if (zone[z].defaut != DEF_AUCUN) return;
  zone[z].defaut = d;
  zone[z].demande = 0.0f;
  zone[z].integrale = 0.0f;
  zone[z].credit = 0.0f;
  zone[z].autotune = AT_INACTIF;
  if (m_tapisDeZone[z] >= 0) {
    m_dernierOff[m_tapisDeZone[z]] = nowMs;   // son temps de repos démarre maintenant
    m_tapisDeZone[z] = -1;
  }
  if (compter && d <= DEF_INEFFICACE) zone[z].nbDefauts[d]++;
  notifier(NOTIF_DEFAUT, z, "%s en DEFAUT : %s (%.2f C). Chauffage coupe et verrouille.",
           cfg[z].nom, nomDefaut(d), (double)zone[z].temperature);
}

void Controleur::leverDefauts(uint32_t nowMs) {
  (void)nowMs;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (zone[z].defaut == DEF_AUCUN) continue;
    zone[z].defaut = DEF_AUCUN;
    zone[z].msFigee = 0; zone[z].figeSignale = false;
    zone[z].lecturesInvalides = 0;
    zone[z].episodeActif = false; zone[z].msChauffeEpisode = 0;
    zone[z].sansEffetSignale = false;
    zone[z].msDerive = 0; zone[z].deriveActive = false;
    zone[z].tempChute = NAN; zone[z].msChute = 0; zone[z].chuteSignalee = false;
    zone[z].integrale = zone[z].biais;       // reprise au point de fonctionnement appris
    notifier(NOTIF_RETABLI, z, "%s : defaut leve, regulation reprise.", cfg[z].nom);
  }
}

void Controleur::appliquerDefautsRestaures(const uint8_t d[NB_ZONES]) {
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (d[z] == DEF_AUCUN || d[z] > DEF_INEFFICACE) continue;
    zone[z].defaut = (Defaut)d[z];
    notifier(NOTIF_DEFAUT, z, "%s : defaut %s restaure au demarrage — il ne se leve pas tout seul.",
             cfg[z].nom, nomDefaut((Defaut)d[z]));
  }
}

// ============================ AUTOTUNE =======================================

bool Controleur::lancerAutotune(uint8_t z, uint32_t nowMs, char *erreur, size_t taille) {
  if (z >= NB_ZONES) { if (erreur) snprintf(erreur, taille, "Zone invalide"); return false; }
  if (zone[z].defaut != DEF_AUCUN) { if (erreur) snprintf(erreur, taille, "Zone en defaut"); return false; }
  if (!isfinite(zone[z].temperature)) { if (erreur) snprintf(erreur, taille, "Pas de mesure valide"); return false; }
  for (uint8_t k = 0; k < NB_ZONES; k++)
    if (zone[k].autotune == AT_ATTENTE || zone[k].autotune == AT_OSCILLE) {
      if (erreur) snprintf(erreur, taille, "Un autotune est deja en cours");
      return false;
    }
  ZoneEtat &s = zone[z];
  s.autotune = AT_ATTENTE;
  s.atDebut = nowMs; s.atDernierPassage = 0;
  s.atCycles = 0; s.atSommePeriodes = 0; s.atSommeAmplitudes = 0;
  s.atMax = s.temperature; s.atMin = s.temperature;
  s.relaisHaut = s.temperature < consignePour(z);
  s.integrale = 0.0f;
  notifier(NOTIF_AUTOTUNE, z, "%s : autotune demarre (oscillation volontaire autour de la consigne, ~1 h).",
           cfg[z].nom);
  return true;
}

void Controleur::arreterAutotune(uint8_t z) {
  if (zone[z].autotune == AT_ATTENTE || zone[z].autotune == AT_OSCILLE) {
    zone[z].autotune = AT_INACTIF;
    notifier(NOTIF_AUTOTUNE, z, "%s : autotune interrompu.", cfg[z].nom);
  }
}

// Relais d'Åström-Hägglund : on fait osciller volontairement la zone autour de
// sa consigne en tout-ou-rien, on mesure amplitude et période de l'oscillation,
// on en déduit le gain ultime, puis Ziegler-Nichols donne bande et gain intégral.
void Controleur::majAutotune(uint8_t z, uint32_t nowMs) {
  ZoneEtat &s = zone[z];
  if (s.autotune != AT_ATTENTE && s.autotune != AT_OSCILLE) return;

  const float consigne = consignePour(z);
  const float t = s.temperature;

  // Garde-fous : jamais d'autotune qui s'approche du seuil de coupure, ni qui
  // s'éternise.
  if (t >= cfg[z].tempMax - 1.0f) {
    s.autotune = AT_ECHEC;
    notifier(NOTIF_AUTOTUNE, z, "%s : autotune abandonne (temperature trop proche du seuil max).", cfg[z].nom);
    return;
  }
  if (nowMs - s.atDebut > 7200000UL) {         // 2 h
    s.autotune = AT_ECHEC;
    notifier(NOTIF_AUTOTUNE, z, "%s : autotune abandonne (aucune oscillation exploitable en 2 h).", cfg[z].nom);
    return;
  }

  if (t > s.atMax) s.atMax = t;
  if (t < s.atMin) s.atMin = t;

  // Relais à hystérésis : on ne commute qu'après un écart franc à la consigne,
  // sinon la quantification de la sonde suffirait à faire basculer le relais.
  if (s.relaisHaut && t >= consigne + AUTOTUNE_HYST) {
    s.relaisHaut = false;
    if (s.atDernierPassage != 0) {
      const float periode = (nowMs - s.atDernierPassage) / 1000.0f;
      const float amplitude = (s.atMax - s.atMin) / 2.0f;
      s.autotune = AT_OSCILLE;
      if (s.atCycles > 0 || periode > 60.0f) {   // le tout premier cycle est ignoré
        s.atSommePeriodes += periode;
        s.atSommeAmplitudes += amplitude;
        s.atCycles++;
      }
      s.atMax = t; s.atMin = t;
    }
    s.atDernierPassage = nowMs;
  } else if (!s.relaisHaut && t <= consigne - AUTOTUNE_HYST) {
    s.relaisHaut = true;
  }

  if (s.atCycles >= 3) {
    const float Tu = s.atSommePeriodes / s.atCycles;
    const float a  = s.atSommeAmplitudes / s.atCycles;
    // L'amplitude doit dépasser franchement l'hystérésis, sinon ce qu'on a
    // mesuré est la commutation du relais lui-même et non la dynamique du
    // terrarium — un résultat pareil donnerait des gains délirants.
    if (a < AUTOTUNE_HYST * 1.3f || Tu < 60.0f) {
      s.autotune = AT_ECHEC;
      notifier(NOTIF_AUTOTUNE, z,
               "%s : autotune non concluant (oscillation trop faible : %.2f C sur %.0f s).",
               cfg[z].nom, (double)a, (double)Tu);
      return;
    }
    const float d  = 0.5f;                        // demi-amplitude du relais (0..1)
    // Formule d'Åström-Hägglund corrigée de l'hystérésis du relais.
    const float racine = sqrtf(a * a - AUTOTUNE_HYST * AUTOTUNE_HYST);
    const float Ku = 4.0f * d / (3.14159265f * racine);
    const float Kp = AUTOTUNE_MARGE_KP * Ku;
    const float Ti = Tu / 1.2f;

    cfg[z].bande = borne(1.0f / Kp, AUTOTUNE_BANDE_MIN, BANDE_MAX);
    cfg[z].ki    = borne(Kp / Ti, 0.0f, AUTOTUNE_KI_MAX);
    s.autotune   = AT_FINI;
    s.cfgModifie = true;      // l'appelant doit écrire ces gains en mémoire non
                              // volatile, sinon une heure d'oscillation est
                              // perdue au premier redémarrage
    s.integrale  = s.biais;
    notifier(NOTIF_AUTOTUNE, z,
             "%s : autotune termine. Periode %.0f s, amplitude %.2f C -> bande %.2f C, ki %.5f.",
             cfg[z].nom, (double)Tu, (double)a, (double)cfg[z].bande, (double)cfg[z].ki);
  }
}

// ============================ MESURE ET PI ===================================

void Controleur::mesure(uint8_t z, float brute, uint32_t nowMs, float dtSec) {
  ZoneEtat &s = zone[z];
  const ReglagesZone &c = cfg[z];

  if (s.defaut != DEF_AUCUN) { s.demande = 0.0f; return; }

  // --- 1. Lectures non exploitables --------------------------------------
  // 85,00 °C est la valeur du registre du DS18B20 quand aucune conversion n'a
  // abouti : ce n'est pas une mesure. On l'ignore, et seules des répétitions
  // font conclure à une panne.
  const bool valeurReset = fabsf(brute - VALEUR_RESET_DS18B20) < 0.01f;
  const bool horsPlage   = !isfinite(brute) || brute < TEMP_MIN_PLAUSIBLE || brute > TEMP_MAX_PLAUSIBLE;
  if (valeurReset || horsPlage) {
    if (++s.lecturesInvalides >= MAX_LECTURES_INVALIDES) declencherDefaut(z, DEF_SONDE, nowMs);
    return;
  }
  s.lecturesInvalides = 0;

  s.brute = brute;
  s.temperature = brute + c.offset;         // calibration
  s.consigneEff = consignePour(z);

  // --- 2. Coupure absolue, hors de la boucle de régulation ----------------
  if (s.temperature >= c.tempMax) { declencherDefaut(z, DEF_SURCHAUFFE, nowMs); return; }

  const float erreur = s.consigneEff - s.temperature;

  // --- 3. Sonde figée -----------------------------------------------------
  // Une valeur strictement identique pendant très longtemps trahit un capteur
  // bloqué. C'est dangereux : figée bas, la coupure de surchauffe ne se
  // déclencherait jamais non plus.
  // Le compteur n'avance QUE si le système essaie de faire bouger la
  // température (chauffe demandée, ou écart notable à la consigne). Sans cette
  // condition, une zone parfaitement à l'équilibre — qui ne chauffe pas et ne
  // bouge donc plus d'un LSB — serait déclarée en panne à tort. Contrepartie
  // assumée : une sonde bloquée pile sur une consigne déjà atteinte, sans
  // chauffe, reste indétectable — il n'y a alors aucune information à exploiter.
  if (isfinite(s.derniereBrute) && fabsf(brute - s.derniereBrute) < 0.001f) {
    const bool onTenteDeBouger = (s.demande > 0.05f) || (fabsf(erreur) > 0.3f);
    if (onTenteDeBouger) {
      s.msFigee += (uint32_t)(dtSec * 1000.0f);
      if (s.msFigee >= FIGE_DEFAUT_MS) { declencherDefaut(z, DEF_FIGE, nowMs); return; }
      if (s.msFigee >= FIGE_ALERTE_MS && !s.figeSignale) {
        s.figeSignale = true;
        notifier(NOTIF_SONDE_FIGEE, z, "%s : sonde figee a %.2f C depuis %lu min — a verifier.",
                 c.nom, (double)brute, (unsigned long)(s.msFigee / 60000));
      }
    }
  } else {
    s.msFigee = 0; s.figeSignale = false; s.derniereBrute = brute;
  }

  // --- 4. Autotune ou PI --------------------------------------------------
  majAutotune(z, nowMs);
  if (s.autotune == AT_ATTENTE || s.autotune == AT_OSCILLE) {
    s.demande = s.relaisHaut ? 1.0f : 0.0f;
    return;
  }

  const float p = erreur / c.bande;
  float brut = p + s.integrale;

  // Anti-emballement : pas d'accumulation quand la sortie sature déjà dans le
  // même sens. Couvre aussi la zone privée de créneaux par l'arbitrage.
  const bool sature = (brut >= 1.0f && erreur > 0) || (brut <= 0.0f && erreur < 0);
  if (!sature) {
    s.integrale = borne(s.integrale + c.ki * erreur * dtSec, -1.0f, 1.0f);
    brut = p + s.integrale;
  }
  s.demande = borne(brut, 0.0f, 1.0f);

  // Point de fonctionnement appris : moyenne glissante de la demande à
  // l'équilibre. Sert à repartir au bon niveau après un défaut ou un
  // changement de consigne, au lieu de laisser l'intégrale tout refaire.
  if (fabsf(erreur) < 0.3f) {
    const float tau = 3600.0f;                       // ~1 h
    const float k = dtSec / (tau + dtSec);
    s.biais = borne(s.biais + k * (s.demande - s.biais), 0.0f, 1.0f);
  }

  // --- 5. Chauffe sans effet ---------------------------------------------
  // Constat : on demande de la chaleur depuis longtemps et la température ne
  // gagne rien. Les causes possibles sont un tapis grillé, un MOSFET mort, une
  // sonde qui a quitté la source de chaleur — ou tout simplement une puissance
  // insuffisante pour la pièce du jour.
  //
  // Ces causes sont indissociables avec une seule sonde et sans mesure de
  // courant : le tapis met deux minutes à se faire sentir sur la sonde, ce qui
  // interdit de conclure en comparant les périodes de chauffe et de repos.
  //
  // C'est pourquoi ce diagnostic ALERTE mais ne coupe pas. Couper le chauffage
  // d'un terrarium déjà trop froid ne protège de rien : dans l'hypothèse la
  // plus fréquente — une nuit exceptionnellement froide — la coupure aggrave
  // exactement le problème qu'elle prétend traiter. Les coupures restent
  // réservées aux cas où arrêter de chauffer protège vraiment : surchauffe,
  // sonde absente, sonde bloquée.
  if (s.demande > 0.05f && erreur > 1.0f) {
    if (!s.episodeActif) {
      s.episodeActif = true; s.tempRefEpisode = s.temperature;
      s.msChauffeEpisode = 0; s.sansEffetSignale = false;
    } else if (s.temperature >= s.tempRefEpisode + c.inefficaceDelta) {
      s.tempRefEpisode = s.temperature;         // ça monte : le tapis agit
      s.msChauffeEpisode = 0; s.sansEffetSignale = false;
    } else if (!s.sansEffetSignale &&
               s.msChauffeEpisode >= (uint32_t)c.inefficaceMinutes * 60000UL) {
      s.sansEffetSignale = true;
      notifier(NOTIF_SANS_EFFET, z,
               "%s : %u min de chauffe sans gagner %.1f C (%.2f C, consigne %.2f). "
               "Tapis, MOSFET, bilame ouvert, sonde deplacee ou puissance insuffisante.",
               c.nom, (unsigned)c.inefficaceMinutes, (double)c.inefficaceDelta,
               (double)s.temperature, (double)s.consigneEff);
    }
  } else {
    s.episodeActif = false; s.msChauffeEpisode = 0; s.sansEffetSignale = false;
  }

  // --- 6. Chute brutale : porte restée ouverte, tapis débranché, courant
  //        d'air. Bien plus rapide que le diagnostic « chauffe sans effet »,
  //        qui met vingt minutes à conclure.
  if (!isfinite(s.tempChute)) { s.tempChute = s.temperature; s.msChute = 0; }
  s.msChute += (uint32_t)(dtSec * 1000.0f);
  if (s.msChute >= (uint32_t)c.chuteSecondes * 1000UL) {
    const float chute = s.tempChute - s.temperature;
    if (chute >= c.chuteSeuil && !s.chuteSignalee) {
      s.chuteSignalee = true;
      notifier(NOTIF_CHUTE, z, "%s : chute de %.1f C en %u s (%.2f -> %.2f) — terrarium ouvert ?",
               c.nom, (double)chute, (unsigned)c.chuteSecondes,
               (double)s.tempChute, (double)s.temperature);
    } else if (chute < c.chuteSeuil * 0.5f) {
      s.chuteSignalee = false;
    }
    s.tempChute = s.temperature;
    s.msChute = 0;
  }

  // --- 7. Dérive douce : on prévient avant le défaut franc ----------------
  if (erreur > c.deriveSeuil) {
    s.msDerive += (uint32_t)(dtSec * 1000.0f);
    if (!s.deriveActive && s.msDerive >= (uint32_t)c.deriveMinutes * 60000UL) {
      s.deriveActive = true;
      notifier(NOTIF_DERIVE, z, "%s : %.1f C sous la consigne depuis %u min (%.2f au lieu de %.2f).",
               c.nom, (double)erreur, (unsigned)c.deriveMinutes,
               (double)s.temperature, (double)s.consigneEff);
    }
  } else {
    if (s.deriveActive && erreur < c.deriveSeuil * 0.5f) {
      s.deriveActive = false;
      notifier(NOTIF_DERIVE_FIN, z, "%s : temperature revenue a %.2f C (consigne %.2f).",
               c.nom, (double)s.temperature, (double)s.consigneEff);
    }
    s.msDerive = 0;
  }
}

// ============================ COMPTABILITÉ ET ORDONNANCEMENT =================

float Controleur::duty(uint8_t z) const {
  uint32_t total = 0;
  for (uint8_t i = 0; i < NB_SEAUX; i++) total += zone[z].seaux[i];
  return 100.0f * (float)total / (float)(NB_SEAUX * SEAU_MS);
}

void Controleur::comptabiliser(uint32_t nowMs, uint32_t delta) {
  const uint32_t seauCourant = nowMs / SEAU_MS;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    ZoneEtat &s = zone[z];
    if (s.indexSeau == 0) s.indexSeau = seauCourant;
    // Fenêtre réellement glissante : on efface les seaux traversés depuis la
    // dernière visite, au lieu de tout remettre à zéro périodiquement.
    uint32_t saut = seauCourant - s.indexSeau;
    if (saut > NB_SEAUX) saut = NB_SEAUX;
    for (uint32_t k = 1; k <= saut; k++) s.seaux[(s.indexSeau + k) % NB_SEAUX] = 0;
    s.indexSeau = seauCourant;
  }
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (m_tapisDeZone[z] < 0) continue;
    ZoneEtat &s = zone[z];
    s.seaux[seauCourant % NB_SEAUX] += delta;
    // Cumul pour le calcul d'energie. `delta` est la duree d'UN tour de boucle :
    // quelques millisecondes sur la carte reelle. Une division entiere par 1000
    // rendrait donc zero a chaque fois et le compteur ne bougerait jamais — le
    // banc d'essai ne le voyait pas, lui qui avance par pas de 2000 ms. On
    // conserve le reste d'une visite a l'autre.
    s.msChauffeReste += delta;
    s.secondesChauffe += s.msChauffeReste / 1000;
    s.msChauffeReste %= 1000;
    if (s.episodeActif) s.msChauffeEpisode += delta;
  }
}

int8_t Controleur::choisirTapis(uint8_t z, uint32_t nowMs) {
  int8_t candidat = -1, repli = -1;
  uint32_t meilleurRepos = 0;
  for (uint8_t k = 0; k < NB_TAPIS; k++) {
    const uint8_t i = (uint8_t)((zone[z].prochainTapis + k) % NB_TAPIS);
    if (ZONE_DE_TAPIS[i] != z) continue;
    const uint32_t repos = nowMs - m_dernierOff[i];
    if (repli < 0 || repos > meilleurRepos) { repli = (int8_t)i; meilleurRepos = repos; }
    if (repos >= MIN_OFF_MS && candidat < 0) candidat = (int8_t)i;
  }
  // Le temps de repos est une préférence de répartition, jamais un blocage :
  // une zone à un seul tapis doit pouvoir chauffer en continu.
  const int8_t choix = (candidat >= 0) ? candidat : repli;
  if (choix >= 0) zone[z].prochainTapis = (uint8_t)((choix + 1) % NB_TAPIS);
  return choix;
}

/*  Ordonnancement par crédits : à chaque créneau, chaque zone gagne
    demande × durée_créneau de crédit et paie le créneau qu'elle obtient.
    Une zone à 30 % prend donc un créneau sur trois environ, deux zones à 100 %
    alternent, et le crédit est plafonné pour qu'une zone longtemps inactive ne
    monopolise pas ensuite le chauffage.                                       */
void Controleur::ordonnancer(uint32_t nowMs) {
  // Maintenance : coupure temporaire avec reprise automatique à l'échéance.
  if (m_maintenanceFin != 0 && (int32_t)(nowMs - m_maintenanceFin) >= 0) {
    m_maintenanceFin = 0;
    notifier(NOTIF_INFO, 0xFF, "Fin de maintenance, regulation reprise.");
  }

  if (m_suspendu || m_maintenanceFin != 0) {
    for (uint8_t z = 0; z < NB_ZONES; z++)
      if (m_tapisDeZone[z] >= 0) { m_dernierOff[m_tapisDeZone[z]] = nowMs; m_tapisDeZone[z] = -1; }
    return;
  }

  // Une zone en autotune passe avant tout : son relais doit délivrer la pleine
  // puissance quand il commute, sinon l'amplitude et la période mesurées ne
  // décrivent plus le terrarium mais l'arbitrage entre zones.
  int8_t prioritaire = -1;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (zone[z].defaut == DEF_AUCUN &&
        (zone[z].autotune == AT_ATTENTE || zone[z].autotune == AT_OSCILLE))
      prioritaire = (int8_t)z;

  // Une zone qui n'a plus lieu de chauffer libère sa place immédiatement,
  // sans attendre la fin du créneau.
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (m_tapisDeZone[z] < 0) continue;
    if (zone[z].demande <= 0.01f || zone[z].defaut != DEF_AUCUN) {
      m_dernierOff[m_tapisDeZone[z]] = nowMs;
      m_tapisDeZone[z] = -1;
    }
  }

  bool renouveler = (nowMs - m_debutCreneau >= CRENEAU_MS);
  // Préemption : le relais de l'autotune ne doit pas attendre la fin du créneau.
  if (!renouveler && prioritaire >= 0 &&
      zone[prioritaire].demande > 0.01f && m_tapisDeZone[prioritaire] < 0)
    renouveler = true;
  // Une place libérée pendant le créneau peut être reprise tout de suite.
  if (!renouveler) {
    uint8_t occupees = 0;
    for (uint8_t z = 0; z < NB_ZONES; z++) if (m_tapisDeZone[z] >= 0) occupees++;
    if (occupees < m_maxZones)
      for (uint8_t z = 0; z < NB_ZONES; z++)
        if (m_tapisDeZone[z] < 0 && zone[z].defaut == DEF_AUCUN &&
            zone[z].demande > 0.01f && zone[z].credit > 0.5f * CRENEAU_MS)
          renouveler = true;
  }
  if (!renouveler) return;

  // Distribution des crédits du créneau écoulé
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (zone[z].defaut != DEF_AUCUN) { zone[z].credit = 0; continue; }
    zone[z].credit += zone[z].demande * (float)CRENEAU_MS;
    const float plafond = 1.5f * CRENEAU_MS;
    if (zone[z].credit > plafond) zone[z].credit = plafond;
  }

  // Attribution : jusqu'à m_maxZones zones, par crédit décroissant. Avec la
  // limite à 1, on retrouve exactement le comportement d'origine.
  bool retenue[NB_ZONES] = { false, false };
  uint8_t places = m_maxZones;

  if (prioritaire >= 0 && zone[prioritaire].demande > 0.01f && places > 0) {
    retenue[prioritaire] = true;
    zone[prioritaire].credit -= (float)CRENEAU_MS;
    places--;
  }
  while (places > 0) {
    int8_t gagnante = -1;
    float meilleur = 0.5f * CRENEAU_MS;
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      if (retenue[z] || zone[z].defaut != DEF_AUCUN || zone[z].demande <= 0.01f) continue;
      if (zone[z].credit > meilleur) { meilleur = zone[z].credit; gagnante = (int8_t)z; }
    }
    if (gagnante < 0) break;
    retenue[gagnante] = true;
    zone[gagnante].credit -= (float)CRENEAU_MS;
    places--;
  }

  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (zone[z].credit < -(float)CRENEAU_MS) zone[z].credit = -(float)CRENEAU_MS;
    if (retenue[z]) {
      if (m_tapisDeZone[z] < 0) m_tapisDeZone[z] = choisirTapis(z, nowMs);
    } else if (m_tapisDeZone[z] >= 0) {
      m_dernierOff[m_tapisDeZone[z]] = nowMs;
      m_tapisDeZone[z] = -1;
    }
  }
  m_debutCreneau = nowMs;
}

void Controleur::avancer(uint32_t nowMs) {
  const uint32_t delta = nowMs - m_dernierAvance;
  m_dernierAvance = nowMs;
  comptabiliser(nowMs, delta);
  ordonnancer(nowMs);
}
