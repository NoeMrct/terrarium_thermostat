/* =============================================================================
   Encodeur QR minimal, pour les étiquettes imprimées depuis l'atelier.
   -----------------------------------------------------------------------------
   Mode octet (UTF-8), correction M (15 % de la surface peut manquer), versions
   1 à 10 (jusqu'à 213 octets : une adresse d'application et un code
   d'appairage tiennent en version 4 ou 5). Le masque est choisi par les quatre
   pénalités de la norme ISO 18004. outils/test-qr.js relit le résultat avec
   jsQR, un décodeur qui ne partage pas une ligne avec celui-ci.

     QR.matrice('https://…')  -> { taille, version, sombre(x, y) }
     QR.chemin('https://…', { marge: 4 })  -> { cote, d }   (tracé SVG, pour createElementNS)
     QR.svg('https://…', { marge: 4, taille: 260 })  -> '<svg …>'
   ============================================================================= */
/* global module */
(function (racine) {
  'use strict';

  // Versions 1 à 10, correction M : [codes de correction par bloc, [blocs de données]].
  const BLOCS = [null,
    [10, [16]], [16, [28]], [26, [44]], [18, [32, 32]], [24, [43, 43]],
    [16, [27, 27, 27, 27]], [18, [31, 31, 31, 31]], [22, [38, 38, 39, 39]],
    [22, [36, 36, 36, 37, 37]], [26, [43, 43, 43, 43, 44]]];
  const ALIGNEMENTS = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const RESTE = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

  // Corps de Galois GF(256), polynôme 0x11D.
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function generateur(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const suivant = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { suivant[j] ^= g[j]; suivant[j + 1] ^= mul(g[j], EXP[i]); }
      g = suivant;
    }
    return g;
  }

  function correction(donnees, n) {
    const g = generateur(n);
    const reste = donnees.concat(new Array(n).fill(0));
    for (let i = 0; i < donnees.length; i++) {
      const c = reste[i];
      if (c) for (let j = 0; j < g.length; j++) reste[i + j] ^= mul(g[j], c);
    }
    return reste.slice(donnees.length);
  }

  function utf8(texte) {
    const o = [];
    for (const car of String(texte)) {
      const p = car.codePointAt(0);
      if (p < 0x80) o.push(p);
      else if (p < 0x800) o.push(0xC0 | (p >> 6), 0x80 | (p & 63));
      else if (p < 0x10000) o.push(0xE0 | (p >> 12), 0x80 | ((p >> 6) & 63), 0x80 | (p & 63));
      else o.push(0xF0 | (p >> 18), 0x80 | ((p >> 12) & 63), 0x80 | ((p >> 6) & 63), 0x80 | (p & 63));
    }
    return o;
  }

  // Suite de codes : mode octet, longueur, données, terminateur, remplissage.
  function codes(octets, version) {
    const capacite = BLOCS[version][1].reduce((a, b) => a + b, 0);
    const bits = [];
    const pousser = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    pousser(4, 4);
    pousser(octets.length, version < 10 ? 8 : 16);
    octets.forEach(o => pousser(o, 8));
    for (let i = 0; i < 4 && bits.length < capacite * 8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const sortie = [];
    for (let i = 0; i < bits.length; i += 8) sortie.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let p = 0; sortie.length < capacite; p++) sortie.push(p % 2 ? 0x11 : 0xEC);
    return sortie;
  }

  // Blocs de données et leurs corrections, entrelacés.
  function entrelacer(donnees, version) {
    const [n, tailles] = BLOCS[version];
    const blocs = [], corrections = [];
    let k = 0;
    tailles.forEach(t => { const b = donnees.slice(k, k + t); k += t; blocs.push(b); corrections.push(correction(b, n)); });
    const sortie = [];
    for (let i = 0; i < Math.max(...tailles); i++) blocs.forEach(b => { if (i < b.length) sortie.push(b[i]); });
    for (let i = 0; i < n; i++) corrections.forEach(c => sortie.push(c[i]));
    return sortie;
  }

  const MASQUES = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];

  // Information de format (correction M = 00) et de version (BCH).
  function bch(valeur, poly, degre) {
    let v = valeur << degre;
    const longueur = p => 32 - Math.clz32(p);
    while (longueur(v) > degre) v ^= poly << (longueur(v) - longueur(poly));
    return (valeur << degre) | v;
  }
  const format = masque => bch((0 << 3) | masque, 0x537, 10) ^ 0x5412;
  const versionInfo = version => bch(version, 0x1F25, 12);

  function construire(version, flux, masque) {
    const taille = 17 + 4 * version;
    const m = Array.from({ length: taille }, () => new Array(taille).fill(null));
    const fixe = Array.from({ length: taille }, () => new Array(taille).fill(false));
    const poser = (x, y, v) => { if (x >= 0 && y >= 0 && x < taille && y < taille) { m[y][x] = v; fixe[y][x] = true; } };
    // Repères de position, séparateurs compris.
    [[0, 0], [taille - 7, 0], [0, taille - 7]].forEach(([cx, cy]) => {
      for (let dy = -1; dy <= 7; dy++)
        for (let dx = -1; dx <= 7; dx++) {
          const dans = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          const anneau = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const coeur = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          poser(cx + dx, cy + dy, dans && (anneau || coeur));
        }
    });
    // Motifs d'alignement.
    const a = ALIGNEMENTS[version];
    a.forEach(cy => a.forEach(cx => {
      if (fixe[cy][cx]) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) poser(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    // Lignes de synchronisation.
    for (let i = 8; i < taille - 8; i++) { if (!fixe[6][i]) poser(i, 6, i % 2 === 0); if (!fixe[i][6]) poser(6, i, i % 2 === 0); }
    // Module toujours sombre, zones de format et de version réservées.
    poser(8, taille - 8, true);
    const f = format(masque);
    for (let i = 0; i < 15; i++) {
      const b = ((f >> i) & 1) === 1;
      // Autour du repère haut gauche…
      if (i < 6) poser(8, i, b); else if (i < 8) poser(8, i + 1, b); else if (i === 8) poser(7, 8, b); else poser(14 - i, 8, b);
      // …et le long des deux autres.
      if (i < 8) poser(taille - 1 - i, 8, b); else poser(8, taille - 15 + i, b);
    }
    if (version >= 7) {
      const v = versionInfo(version);
      for (let i = 0; i < 18; i++) {
        const b = ((v >> i) & 1) === 1;
        poser(Math.floor(i / 3), taille - 11 + (i % 3), b);
        poser(taille - 11 + (i % 3), Math.floor(i / 3), b);
      }
    }
    // Données en zigzag, de deux colonnes en deux colonnes, depuis le coin bas droit.
    const bits = [];
    flux.forEach(o => { for (let i = 7; i >= 0; i--) bits.push((o >> i) & 1); });
    for (let i = 0; i < RESTE[version]; i++) bits.push(0);
    let k = 0, montee = true;
    for (let x = taille - 1; x > 0; x -= 2) {
      if (x === 6) x--;
      for (let n = 0; n < taille; n++) {
        const y = montee ? taille - 1 - n : n;
        for (const xx of [x, x - 1]) {
          if (fixe[y][xx]) continue;
          const bit = k < bits.length ? bits[k++] === 1 : false;
          m[y][xx] = bit !== MASQUES[masque](xx, y);
        }
      }
      montee = !montee;
    }
    return m;
  }

  // Les quatre pénalités : suites, blocs 2×2, motifs de repère, déséquilibre.
  function penalite(m) {
    const n = m.length;
    let p = 0;
    for (let sens = 0; sens < 2; sens++)
      for (let i = 0; i < n; i++) {
        let suite = 1;
        for (let j = 1; j < n; j++) {
          const a = sens ? m[j][i] : m[i][j], b = sens ? m[j - 1][i] : m[i][j - 1];
          if (a === b) { suite++; if (j === n - 1 && suite >= 5) p += suite - 2; }
          else { if (suite >= 5) p += suite - 2; suite = 1; }
        }
      }
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++)
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    const motif = [true, false, true, true, true, false, true];
    for (let sens = 0; sens < 2; sens++)
      for (let i = 0; i < n; i++)
        for (let j = 0; j + 7 <= n; j++) {
          const lire = k => (sens ? m[j + k][i] : m[i][j + k]);
          if (!motif.every((v, k) => lire(k) === v)) continue;
          const clair = (debut, fin) => { for (let k = debut; k < fin; k++) { if (k < 0 || k >= n) continue; if (sens ? m[k][i] : m[i][k]) return false; } return true; };
          if (clair(j - 4, j) || clair(j + 7, j + 11)) p += 40;
        }
    let sombres = 0;
    m.forEach(l => l.forEach(v => { if (v) sombres++; }));
    p += Math.floor(Math.abs(sombres * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  function matrice(texte) {
    const octets = utf8(texte);
    let version = 1;
    while (version <= 10 && BLOCS[version][1].reduce((a, b) => a + b, 0) < octets.length + (version < 10 ? 2 : 3)) version++;
    if (version > 10) throw new Error('QR : texte trop long (213 octets au plus)');
    const flux = entrelacer(codes(octets, version), version);
    let meilleure = null, score = Infinity;
    for (let masque = 0; masque < 8; masque++) {
      const m = construire(version, flux, masque);
      const s = penalite(m);
      if (s < score) { score = s; meilleure = m; }
    }
    return { taille: meilleure.length, version, sombre: (x, y) => meilleure[y][x] === true };
  }

  // Un seul chemin pour tous les modules sombres : un SVG léger et net à l'impression.
  // Un carré par module sombre, dans un seul tracé : c'est le plus compact à
  // imprimer, et il se pose sans HTML (createElementNS, setAttribute('d')).
  function chemin(texte, options = {}) {
    const q = matrice(texte);
    const marge = options.marge === undefined ? 4 : options.marge;
    let d = '';
    for (let y = 0; y < q.taille; y++)
      for (let x = 0; x < q.taille; x++) if (q.sombre(x, y)) d += `M${x + marge} ${y + marge}h1v1h-1z`;
    return { cote: q.taille + 2 * marge, d, version: q.version };
  }

  function svg(texte, options = {}) {
    const { cote, d } = chemin(texte, options);
    const px = options.taille ? ` width="${options.taille}" height="${options.taille}"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cote} ${cote}"${px} shape-rendering="crispEdges"><rect width="${cote}" height="${cote}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  const QR = { matrice, chemin, svg };
  if (typeof module === 'object' && module.exports) module.exports = QR;
  else racine.QR = QR;
})(typeof self !== 'undefined' ? self : this);
