#include "signature.h"
#include <string.h>

namespace {

const uint32_t K[64] = { 0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
                         0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
                         0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
                         0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
                         0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
                         0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
                         0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
                         0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
                         0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
                         0xc67178f2 };

uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

struct Sha256 {
  uint32_t h[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
  uint8_t bloc[64] = { 0 };
  size_t rempli = 0;
  uint64_t total = 0;

  void compresser() {
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
      w[i] = (uint32_t)bloc[i * 4] << 24 | (uint32_t)bloc[i * 4 + 1] << 16 | (uint32_t)bloc[i * 4 + 2] << 8 |
             (uint32_t)bloc[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
      const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (int i = 0; i < 64; i++) {
      const uint32_t t1 = k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      k = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }

  void ajouter(const uint8_t *p, size_t n) {
    total += n;
    while (n--) {
      bloc[rempli++] = *p++;
      if (rempli == 64) {
        compresser();
        rempli = 0;
      }
    }
  }

  void finir(uint8_t sortie[32]) {
    const uint64_t bits = total * 8;
    const uint8_t un = 0x80, zero = 0;
    ajouter(&un, 1);
    while (rempli != 56) ajouter(&zero, 1);
    uint8_t longueur[8];
    for (int i = 0; i < 8; i++) longueur[i] = (uint8_t)(bits >> (56 - 8 * i));
    ajouter(longueur, 8);
    for (int i = 0; i < 8; i++) {
      sortie[i * 4] = (uint8_t)(h[i] >> 24);
      sortie[i * 4 + 1] = (uint8_t)(h[i] >> 16);
      sortie[i * 4 + 2] = (uint8_t)(h[i] >> 8);
      sortie[i * 4 + 3] = (uint8_t)h[i];
    }
  }
};

}  // namespace

namespace Signature {

void sha256(const uint8_t *donnees, size_t taille, uint8_t sortie[32]) {
  Sha256 s;
  s.ajouter(donnees, taille);
  s.finir(sortie);
}

void hmacSha256(const uint8_t *cle, size_t tailleCle, const uint8_t *message, size_t tailleMessage,
                uint8_t sortie[32]) {
  uint8_t k[64] = { 0 };
  if (tailleCle > 64)
    sha256(cle, tailleCle, k);  // clé longue : son empreinte, complétée de zéros
  else
    memcpy(k, cle, tailleCle);
  uint8_t ipad[64], opad[64];
  for (int i = 0; i < 64; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  uint8_t interne[32];
  Sha256 a;
  a.ajouter(ipad, 64);
  a.ajouter(message, tailleMessage);
  a.finir(interne);
  Sha256 b;
  b.ajouter(opad, 64);
  b.ajouter(interne, 32);
  b.finir(sortie);
}

void hex(const uint8_t empreinte[32], char sortie[65]) {
  static const char chiffres[] = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    sortie[i * 2] = chiffres[empreinte[i] >> 4];
    sortie[i * 2 + 1] = chiffres[empreinte[i] & 0x0f];
  }
  sortie[64] = '\0';
}

bool verifier(const char *cle, const char *message, size_t tailleMessage, const char *sigHex) {
  if (!cle || !message || !sigHex || strlen(sigHex) != 64) return false;
  uint8_t mac[32];
  hmacSha256(reinterpret_cast<const uint8_t *>(cle), strlen(cle), reinterpret_cast<const uint8_t *>(message),
             tailleMessage, mac);
  char attendu[65];
  hex(mac, attendu);
  uint8_t ecart = 0;  // durée constante : on ne s'arrête pas au premier caractère faux
  for (int i = 0; i < 64; i++) ecart |= (uint8_t)(attendu[i] ^ sigHex[i]);
  return ecart == 0;
}

}  // namespace Signature
