/* Page de flashage : charge ESP Web Tools (copie locale, voir installateur/LISEZMOI.md)
   et affiche quel firmware est publié. Le manifeste et les binaires sont écrits
   dans firmware/ au moment de la publication du site (outils/preparer-publication.js)
   à partir de la dernière release GitHub ; sans release, la page le dit. */
import './installateur/install-button.js';

const etat = document.getElementById('etat-firmware');
const bouton = document.getElementById('bouton-flash');

fetch('firmware/manifest.json', { cache: 'no-store' })
  .then(r => (r.ok ? r.json() : null))
  .then(m => {
    if (!m || !m.builds || !m.builds.length) {
      etat.textContent = 'Aucun firmware publié pour l\'instant : la première release GitHub le fera apparaître ici.';
      return;
    }
    const taille = (m.builds[0].parts || []).reduce((a, p) => a + (p.size || 0), 0);
    etat.textContent = `Firmware publié : version ${m.version}` +
      (m.date ? ` (${m.date})` : '') + (taille ? ` · ${Math.round(taille / 1024)} Ko` : '') + '.';
    bouton.hidden = false;
  })
  .catch(() => { etat.textContent = 'Impossible de lire la liste des firmwares publiés.'; });
