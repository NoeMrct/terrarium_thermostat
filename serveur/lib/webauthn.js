'use strict';
/* Clés d'accès (WebAuthn, passkeys) sans dépendance.
   -----------------------------------------------------------------------------
   Ce que le serveur doit vérifier, et rien de plus :
   - inscription : le navigateur a bien répondu à notre défi, depuis une
     origine acceptée, pour notre identifiant de partie prenante (RP ID), en
     présence de l'utilisateur ; on garde la clé publique (COSE → JWK). Aucune
     attestation n'est exigée (« none ») : on ne restreint pas les modèles
     d'authentificateur, comme les sites grand public.
   - connexion : mêmes contrôles, puis la signature de l'authentificateur sur
     authenticatorData ‖ SHA-256(clientDataJSON), et le compteur de
     signatures (une clé qui recule a pu être clonée ; 0 partout veut dire
     « pas de compteur », cas des clés synchronisées).
   Le CBOR lu ici est le sous-ensemble qu'emploie WebAuthn : entiers, chaînes
   d'octets et de texte, tableaux, tables, valeurs simples ; ni flottants ni
   longueurs indéfinies (refusés). */

const crypto = require('crypto');

const sha256 = d => crypto.createHash('sha256').update(d).digest();
const b64u = b => Buffer.from(b).toString('base64url');
const deB64u = s => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url attendu');
  return Buffer.from(s, 'base64url');
};

// --- CBOR (RFC 8949) ------------------------------------------------------------
function cbor(buf) {
  let i = 0;
  const lireOctets = n => {
    if (n < 0 || i + n > buf.length) throw new Error('CBOR tronqué');
    const v = buf.subarray(i, i + n); i += n; return v;
  };
  function longueur(info) {
    if (info < 24) return info;
    if (info === 24) return lireOctets(1)[0];
    if (info === 25) return lireOctets(2).readUInt16BE(0);
    if (info === 26) return lireOctets(4).readUInt32BE(0);
    if (info === 27) {
      const v = lireOctets(8).readBigUInt64BE(0);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR : entier trop grand');
      return Number(v);
    }
    throw new Error('CBOR : longueur indéfinie non prise en charge');
  }
  function lire(profondeur) {
    if (profondeur > 16) throw new Error('CBOR trop imbriqué');
    const o = lireOctets(1)[0], type = o >> 5, info = o & 31;
    switch (type) {
      case 0: return longueur(info);
      case 1: return -1 - longueur(info);
      case 2: return Buffer.from(lireOctets(longueur(info)));
      case 3: return lireOctets(longueur(info)).toString('utf8');
      case 4: { const n = longueur(info); if (n > 1000) throw new Error('CBOR : tableau trop long'); const a = []; for (let k = 0; k < n; k++) a.push(lire(profondeur + 1)); return a; }
      case 5: {
        const n = longueur(info); if (n > 1000) throw new Error('CBOR : table trop longue');
        const m = new Map();
        for (let k = 0; k < n; k++) { const cle = lire(profondeur + 1); m.set(cle, lire(profondeur + 1)); }
        return m;
      }
      case 6: longueur(info); return lire(profondeur + 1);          // étiquette : ignorée
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error('CBOR : valeur non prise en charge');
    }
  }
  const valeur = lire(0);
  return { valeur, fin: i };
}

// --- données d'authentificateur -------------------------------------------------
function lireAuthData(ad) {
  if (!Buffer.isBuffer(ad) || ad.length < 37) throw new Error('données d\'authentificateur trop courtes');
  const drapeaux = ad[32];
  const r = { rpIdHash: ad.subarray(0, 32), drapeaux, compteur: ad.readUInt32BE(33),
    up: !!(drapeaux & 0x01), uv: !!(drapeaux & 0x04), sauvegardable: !!(drapeaux & 0x08), sauvegardee: !!(drapeaux & 0x10), at: !!(drapeaux & 0x40) };
  if (r.at) {
    if (ad.length < 55) throw new Error('données de clé tronquées');
    const n = ad.readUInt16BE(53);
    if (n < 16 || n > 1023 || ad.length < 55 + n) throw new Error('identifiant de clé invalide');
    r.idCle = ad.subarray(55, 55 + n);
    r.cose = cbor(ad.subarray(55 + n)).valeur;
    if (!(r.cose instanceof Map)) throw new Error('clé COSE invalide');
  }
  return r;
}

// Clé publique COSE → JWK, pour crypto.createPublicKey. Trois algorithmes :
// ES256 (presque tous), RS256 (Windows Hello ancien), EdDSA (clés matérielles).
function coseVersJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  else if (kty === 1 && alg === -8 && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: b64u(cose.get(-2)) };
  else throw new Error('type de clé non pris en charge');
  crypto.createPublicKey({ key: jwk, format: 'jwk' });            // refuse une clé mal formée tout de suite
  return { jwk, alg };
}

function lireClientData(brut, type, defi, origineAcceptee) {
  let c;
  try { c = JSON.parse(Buffer.from(brut).toString('utf8')); } catch (e) { throw new Error('clientDataJSON illisible', { cause: e }); }
  if (!c || c.type !== type) throw new Error('cérémonie inattendue');
  if (typeof c.challenge !== 'string' || c.challenge !== defi) throw new Error('défi inattendu ou expiré');
  if (typeof c.origin !== 'string' || !origineAcceptee(c.origin)) throw new Error(`origine refusée (${String(c.origin).slice(0, 80)})`);
  if (c.crossOrigin === true) throw new Error('cérémonie depuis un cadre tiers refusée');
  return c;
}

/** Vérifie une inscription. `r` : { clientDataJSON, attestationObject } en base64url. */
function verifierInscription(r, { defi, rpId, origineAcceptee }) {
  const clientData = deB64u(r.clientDataJSON), attestation = deB64u(r.attestationObject);
  lireClientData(clientData, 'webauthn.create', defi, origineAcceptee);
  const att = cbor(attestation).valeur;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('attestation illisible');
  const ad = lireAuthData(att.get('authData'));
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('identifiant de partie prenante (RP ID) inattendu');
  if (!ad.up) throw new Error('présence de l\'utilisateur non attestée');
  if (!ad.at) throw new Error('aucune clé dans la réponse');
  const { jwk, alg } = coseVersJwk(ad.cose);
  return { id: b64u(ad.idCle), jwk, alg, compteur: ad.compteur, uv: ad.uv, synchronisee: ad.sauvegardee, format: String(att.get('fmt') || '') };
}

/** Vérifie une connexion avec une clé enregistrée { jwk, alg, compteur }. */
function verifierConnexion(r, cle, { defi, rpId, origineAcceptee }) {
  const clientData = deB64u(r.clientDataJSON), authData = deB64u(r.authenticatorData), signature = deB64u(r.signature);
  lireClientData(clientData, 'webauthn.get', defi, origineAcceptee);
  const ad = lireAuthData(authData);
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('identifiant de partie prenante (RP ID) inattendu');
  if (!ad.up) throw new Error('présence de l\'utilisateur non attestée');
  const donnees = Buffer.concat([authData, sha256(clientData)]);
  const pub = crypto.createPublicKey({ key: cle.jwk, format: 'jwk' });
  let ok;
  try {
    ok = cle.alg === -8 ? crypto.verify(null, donnees, pub, signature)
      : cle.alg === -257 ? crypto.verify('sha256', donnees, { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, signature)
        : crypto.verify('sha256', donnees, pub, signature);           // ES256 : signature DER, le format par défaut
  } catch (e) { ok = false; }
  if (!ok) throw new Error('signature invalide');
  if ((ad.compteur || cle.compteur) && ad.compteur <= cle.compteur) throw new Error('compteur de signatures en arrière : clé clonée ?');
  return { compteur: ad.compteur, uv: ad.uv };
}

module.exports = { cbor, lireAuthData, coseVersJwk, verifierInscription, verifierConnexion, b64u, deB64u, sha256 };
