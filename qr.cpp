#include "qr.h"
#include <string.h>
#include <stdlib.h>
#ifdef QR_DEBUG
#include <stdio.h>
#endif

/* Version 2, niveau L : 44 mots de code, dont 34 de données et 10 de correction,
   un seul bloc. Tout ce qui suit est spécialisé pour cette taille : c'est ce qui
   permet de tenir en quelques centaines d'octets de flash et sans allocation. */
namespace {

const int N = QR_MODULES;  // 25
const int MOTS_DONNEES = 34;
const int MOTS_CORRECTION = 10;
const int MOTS_TOTAL = MOTS_DONNEES + MOTS_CORRECTION;

// Table de l'alphabet alphanumérique : renvoie -1 si le caractère est interdit.
int valeurAlnum(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
  const char *speciaux = " $%*+-./:";
  const char *p = strchr(speciaux, c);
  return (p && c != '\0') ? 36 + (int)(p - speciaux) : -1;
}

// ---- corps de Galois GF(256), polynôme 0x11D --------------------------------
uint8_t gfMul(uint8_t a, uint8_t b) {
  uint8_t r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = (uint8_t)((a << 1) ^ ((a & 0x80) ? 0x1D : 0));
    b >>= 1;
  }
  return r;
}

// Reste de la division de (données · x^10) par le polynôme générateur de degré 10.
void correction(const uint8_t *donnees, uint8_t *sortie) {
  uint8_t gen[MOTS_CORRECTION + 1];
  memset(gen, 0, sizeof gen);
  gen[0] = 1;
  uint8_t racine = 1;
  for (int i = 0; i < MOTS_CORRECTION; i++) {  // gen *= (x - α^i)
    for (int j = i + 1; j > 0; j--) gen[j] = (uint8_t)(gen[j] ^ gfMul(gen[j - 1], racine));
    racine = gfMul(racine, 2);
  }
  memset(sortie, 0, MOTS_CORRECTION);
  for (int i = 0; i < MOTS_DONNEES; i++) {
    const uint8_t facteur = (uint8_t)(donnees[i] ^ sortie[0]);
    memmove(sortie, sortie + 1, MOTS_CORRECTION - 1);
    sortie[MOTS_CORRECTION - 1] = 0;
    for (int j = 0; j < MOTS_CORRECTION; j++) sortie[j] ^= gfMul(gen[j + 1], facteur);
  }
}

// ---- grille ----------------------------------------------------------------
struct Grille {
  uint8_t m[N][N];  // modules
  uint8_t f[N][N];  // 1 = module de fonction (jamais masqué)
  void poser(int y, int x, bool sombre) {
    m[y][x] = sombre ? 1 : 0;
    f[y][x] = 1;
  }
};

void motifRepere(Grille &g, int y0, int x0) {
  for (int dy = -4; dy <= 4; dy++)
    for (int dx = -4; dx <= 4; dx++) {
      const int y = y0 + dy, x = x0 + dx;
      if (y < 0 || x < 0 || y >= N || x >= N) continue;
      const int d = abs(dx) > abs(dy) ? abs(dx) : abs(dy);
      g.poser(y, x, d != 2 && d != 4);
    }
}

void motifAlignement(Grille &g, int y0, int x0) {
  for (int dy = -2; dy <= 2; dy++)
    for (int dx = -2; dx <= 2; dx++) {
      const int d = abs(dx) > abs(dy) ? abs(dx) : abs(dy);
      g.poser(y0 + dy, x0 + dx, d != 1);
    }
}

// Les 15 bits d'information de format : niveau L (01) et masque, protégés par
// un code BCH, puis masqués par la constante du standard.
void information(Grille &g, int masque) {
  const int donnees = (1 << 3) | masque;  // 01 = niveau L
  int reste = donnees;
  for (int i = 0; i < 10; i++) reste = (reste << 1) ^ ((reste >> 9) * 0x537);
  const int bits = ((donnees << 10) | reste) ^ 0x5412;
  for (int i = 0; i < 15; i++) {
    const bool b = ((bits >> i) & 1) != 0;
    // Première copie, autour du repère haut-gauche : bits 0-7 en descendant la
    // colonne 8, bits 8-14 en remontant la ligne 8 vers la gauche.
    if (i < 6)
      g.poser(i, 8, b);
    else if (i == 6)
      g.poser(7, 8, b);
    else if (i == 7)
      g.poser(8, 8, b);
    else if (i == 8)
      g.poser(8, 7, b);
    else
      g.poser(8, 14 - i, b);
    // Seconde copie, partagée entre les deux autres repères.
    if (i < 8)
      g.poser(8, N - 1 - i, b);
    else
      g.poser(N - 15 + i, 8, b);
  }
  g.poser(N - 8, 8, true);  // module sombre fixe
}

void motifsFonction(Grille &g) {
  memset(&g, 0, sizeof g);
  for (int i = 0; i < N; i++) {
    g.poser(6, i, i % 2 == 0);
    g.poser(i, 6, i % 2 == 0);
  }
  motifRepere(g, 3, 3);
  motifRepere(g, 3, N - 4);
  motifRepere(g, N - 4, 3);
  motifAlignement(g, N - 7, N - 7);  // (18, 18) en version 2
  information(g, 0);                 // réserve les emplacements
}

bool masque(int masque, int y, int x) {
  switch (masque) {
    case 0: return (x + y) % 2 == 0;
    case 1: return y % 2 == 0;
    case 2: return x % 3 == 0;
    case 3: return (x + y) % 3 == 0;
    case 4: return (x / 3 + y / 2) % 2 == 0;
    case 5: return x * y % 2 + x * y % 3 == 0;
    case 6: return (x * y % 2 + x * y % 3) % 2 == 0;
    default: return ((x + y) % 2 + x * y % 3) % 2 == 0;
  }
}

// Pénalité du standard : séries, blocs 2×2, faux motifs de repère, équilibre.
int penalite(const Grille &g) {
  int p = 0;
  for (int passe = 0; passe < 2; passe++) {  // 0 : lignes, 1 : colonnes
    for (int a = 0; a < N; a++) {
      int serie = 0;
      uint8_t prec = 2;
      int fenetre = 0;  // 11 derniers modules
      for (int b = 0; b < N; b++) {
        const uint8_t v = passe ? g.m[b][a] : g.m[a][b];
        if (v == prec) {
          if (++serie == 5)
            p += 3;
          else if (serie > 5)
            p++;
        } else {
          serie = 1;
          prec = v;
        }
        fenetre = ((fenetre << 1) | v) & 0x7FF;
        if (b >= 10 && (fenetre == 0x5D0 || fenetre == 0x05D)) p += 40;  // 10111010000 / 00001011101
      }
    }
  }
  for (int y = 0; y < N - 1; y++)
    for (int x = 0; x < N - 1; x++) {
      const uint8_t v = g.m[y][x];
      if (v == g.m[y][x + 1] && v == g.m[y + 1][x] && v == g.m[y + 1][x + 1]) p += 3;
    }
  int sombres = 0;
  for (int y = 0; y < N; y++)
    for (int x = 0; x < N; x++) sombres += g.m[y][x];
  const int total = N * N;
  const int k = (abs(sombres * 20 - total * 10) + total - 1) / total - 1;
  return p + k * 10;
}

}  // namespace

bool qrEncoder(const char *texte, uint8_t modules[QR_MODULES * QR_MODULES]) {
  const size_t n = strlen(texte);
  if (n == 0 || n > 47) return false;

  // ---- flux de bits : mode (0010), longueur sur 9 bits, paires sur 11 bits ---
  uint8_t octets[MOTS_TOTAL];
  memset(octets, 0, sizeof octets);
  int nb = 0;
  auto pousser = [&](uint32_t valeur, int bits) {
    for (int i = bits - 1; i >= 0; i--, nb++)
      if ((valeur >> i) & 1) octets[nb >> 3] |= (uint8_t)(0x80 >> (nb & 7));
  };
  pousser(2, 4);
  pousser((uint32_t)n, 9);
  for (size_t i = 0; i < n; i += 2) {
    const int a = valeurAlnum(texte[i]);
    if (a < 0) return false;
    if (i + 1 < n) {
      const int b = valeurAlnum(texte[i + 1]);
      if (b < 0) return false;
      pousser((uint32_t)(a * 45 + b), 11);
    } else
      pousser((uint32_t)a, 6);
  }
  const int capacite = MOTS_DONNEES * 8;
  if (nb > capacite) return false;
  int terminateur = capacite - nb;
  if (terminateur > 4) terminateur = 4;
  pousser(0, terminateur);
  if (nb & 7) pousser(0, 8 - (nb & 7));
  for (uint8_t bourrage = 0xEC; nb < capacite; bourrage ^= (0xEC ^ 0x11)) pousser(bourrage, 8);

  correction(octets, octets + MOTS_DONNEES);
#ifdef QR_DEBUG
  for (int i = 0; i < MOTS_TOTAL; i++) fprintf(stderr, "%d%c", octets[i], i == MOTS_TOTAL - 1 ? '\n' : ' ');
#endif

  // ---- placement en zigzag, de droite à gauche, deux colonnes à la fois ------
  static Grille g;
  motifsFonction(g);
  int bit = 0;
  for (int droite = N - 1; droite >= 1; droite -= 2) {
    if (droite == 6) droite = 5;
    for (int v = 0; v < N; v++)
      for (int j = 0; j < 2; j++) {
        const int x = droite - j;
        const bool montee = ((droite + 1) & 2) == 0;
        const int y = montee ? N - 1 - v : v;
        // cppcheck-suppress negativeIndex ; v < N, donc y est dans [0, N[
        if (g.f[y][x]) continue;
        if (bit < MOTS_TOTAL * 8) {
          g.m[y][x] = (octets[bit >> 3] >> (7 - (bit & 7))) & 1;
          bit++;
        } else
          g.m[y][x] = 0;
      }
  }

  // ---- choix du masque : le moins pénalisé -----------------------------------
  int meilleur = 0, meilleurePenalite = -1;
  for (int k = 0; k < 8; k++) {
    for (int y = 0; y < N; y++)
      for (int x = 0; x < N; x++)
        if (!g.f[y][x] && masque(k, y, x)) g.m[y][x] ^= 1;
    information(g, k);
    const int p = penalite(g);
    if (meilleurePenalite < 0 || p < meilleurePenalite) {
      meilleurePenalite = p;
      meilleur = k;
    }
    for (int y = 0; y < N; y++)
      for (int x = 0; x < N; x++)
        if (!g.f[y][x] && masque(k, y, x)) g.m[y][x] ^= 1;
  }
  for (int y = 0; y < N; y++)
    for (int x = 0; x < N; x++)
      if (!g.f[y][x] && masque(meilleur, y, x)) g.m[y][x] ^= 1;
  information(g, meilleur);

  for (int y = 0; y < N; y++)
    for (int x = 0; x < N; x++) modules[y * N + x] = g.m[y][x];
  return true;
}
