'use strict';
/* Port série sans module natif : le port est ouvert comme un fichier après
   réglage par stty (Linux, macOS) ou mode (Windows). Suffisant pour parler à
   la console du socle (115200 bauds, lignes de texte). Partagé par
   test-materiel.js (banc) et provisionner.js (production). */

const fs = require('fs');
const { execFileSync } = require('child_process');

// Le nom du port vient de la ligne de commande : il est passé tel quel à stty
// ou mode comme argument (jamais à travers un interpréteur de commandes), et
// seul un nom plausible de port est accepté.
function configurerPort(port) {
  if (process.platform === 'win32') {
    const com = port.replace(/^\\\\.\\/, '');
    if (!/^COM\d{1,3}$/i.test(com)) throw new Error(`port série inattendu : ${port} (attendu COMn)`);
    execFileSync('mode.com', [com, 'BAUD=115200', 'PARITY=n', 'DATA=8', 'STOP=1', 'dtr=on', 'rts=on'], { stdio: 'ignore' });
    return `\\\\.\\${com}`;
  }
  if (!/^\/dev\/[\w.-]+$/.test(port)) throw new Error(`port série inattendu : ${port} (attendu /dev/…)`);
  // stty désigne le port par -F sous Linux, -f sous macOS (BSD).
  execFileSync('stty', [process.platform === 'darwin' ? '-f' : '-F', port, '115200', 'raw', '-echo', '-hupcl', 'cs8', '-cstopb', '-parenb'], { stdio: 'ignore' });
  return port;
}

const attendre = ms => new Promise(r => setTimeout(r, ms));

class Serie {
  constructor(chemin) {
    this.sortie = fs.openSync(chemin, 'r+');
    this.tampon = '';
    this.flux = fs.createReadStream(chemin, { fd: this.sortie, autoClose: false, highWaterMark: 1024 });
    this.flux.on('data', d => { this.tampon += d.toString('utf8'); if (this.tampon.length > 200000) this.tampon = this.tampon.slice(-100000); });
    this.flux.on('error', () => {});
  }
  ecrire(ligne) { fs.writeSync(this.sortie, ligne + '\n'); }
  // Attend un motif dans ce qui arrive après `depuis`.
  async attendre(motif, delaiMs = 10000, depuis = 0) {
    const fin = Date.now() + delaiMs;
    while (Date.now() < fin) {
      const m = motif.exec(this.tampon.slice(depuis));
      if (m) return m;
      await attendre(100);
    }
    return null;
  }
  position() { return this.tampon.length; }
  async commande(texte, motif, delaiMs = 8000) {
    const depuis = this.position();
    this.ecrire(texte);
    return this.attendre(motif, delaiMs, depuis);
  }
  fermer() { try { this.flux.destroy(); fs.closeSync(this.sortie); } catch (e) { /* déjà fermé */ } }
}

function ouvrirSerie(port) { return new Serie(configurerPort(port)); }

module.exports = { ouvrirSerie, Serie };
