'use strict';
/* Comptes en libre-service : code par e-mail, clés d'accès (WebAuthn, avec un
   authentificateur logiciel qui signe comme un téléphone), sessions hachées et
   glissantes, export et effacement du compte, client SMTP contre un faux
   serveur. Ports éphémères, données dans un dossier temporaire.
     npm test  (node --test test/) */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur');
const { Comptes } = require('../lib/comptes');
const { Courriel } = require('../lib/courriel');
const webauthn = require('../lib/webauthn');

const ADMIN = 'jeton-admin-de-test';
const ORIGINE = 'https://app.exemple.fr';
const RP_ID = 'app.exemple.fr';
const b64u = b => Buffer.from(b).toString('base64url');
const sha256 = d => crypto.createHash('sha256').update(d).digest();
const dossierTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-comptes-'));

// Requête HTTP brute : fetch ne laisse pas toujours poser l'en-tête Origin.
function requete(port, methode, chemin, corps, { jeton, origine } = {}) {
  return new Promise((resoudre, rejeter) => {
    const donnees = corps === undefined ? null : Buffer.from(JSON.stringify(corps));
    const r = http.request({ host: '127.0.0.1', port, method: methode, path: chemin, headers: {
      ...(donnees ? { 'Content-Type': 'application/json', 'Content-Length': donnees.length } : {}),
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
      ...(origine ? { Origin: origine } : {})
    } }, rep => {
      const morceaux = [];
      rep.on('data', c => morceaux.push(c));
      rep.on('end', () => {
        let d = null;
        try { d = JSON.parse(Buffer.concat(morceaux).toString('utf8')); } catch (e) { /* vide */ }
        resoudre({ status: rep.statusCode, donnees: d, entetes: rep.headers });
      });
    });
    r.on('error', rejeter);
    if (donnees) r.write(donnees);
    r.end();
  });
}

function connexionMqtt(port, username, password) {
  return new Promise(res => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username, password, reconnectPeriod: 0, connectTimeout: 3000 });
    c.once('connect', () => { c.end(true); res(true); });
    c.once('error', () => { c.end(true); res(false); });
  });
}

// --- encodeur CBOR minimal, pour fabriquer des réponses d'authentificateur ---------
function cbor(v) {
  const tete = (type, n) => {
    if (n < 24) return Buffer.from([(type << 5) | n]);
    if (n < 256) return Buffer.from([(type << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (type << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? tete(0, v) : tete(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([tete(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([tete(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([tete(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('type CBOR non prévu');
}

// Authentificateur logiciel ES256 : ce que fait un téléphone, sans l'écran.
function authentificateur(rpId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const idCle = crypto.randomBytes(32);
  let compteur = 0, userHandle = null;
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const entier = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return {
    id: b64u(idCle),
    creer(options, origine, rp = rpId) {
      userHandle = options.user.id;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: origine, crossOrigin: false }));
      const lg = Buffer.alloc(2); lg.writeUInt16BE(idCle.length);
      const authData = Buffer.concat([sha256(rp), Buffer.from([0x01 | 0x04 | 0x40]), entier(compteur), Buffer.alloc(16), lg, idCle, cbor(cose)]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(idCle), defi: options.challenge, clientDataJSON: b64u(clientData), attestationObject: b64u(att), nom: 'Téléphone de test' };
    },
    signer(options, origine, { pas = 1, rp = rpId, alterer = false } = {}) {
      compteur += pas;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: origine }));
      const authData = Buffer.concat([sha256(rp), Buffer.from([0x01 | 0x04]), entier(Math.max(0, compteur))]);
      const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), privateKey);
      if (alterer) sig[sig.length - 1] ^= 1;
      return { id: b64u(idCle), defi: options.challenge, clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle };
    },
    reculer(n) { compteur -= n; }
  };
}

// --- faux serveur SMTP (texte en clair, sur 127.0.0.1) -----------------------------
function fauxSmtp() {
  const recus = [];
  const serveur = net.createServer(s => {
    let tampon = '', donnees = false, message = '';
    const courant = {};
    s.write('220 faux.smtp ESMTP\r\n');
    s.on('data', d => {
      tampon += d.toString('utf8');
      let i;
      while ((i = tampon.indexOf('\r\n')) >= 0) {
        const ligne = tampon.slice(0, i); tampon = tampon.slice(i + 2);
        if (donnees) {
          if (ligne === '.') { donnees = false; recus.push({ ...courant, message }); message = ''; s.write('250 2.0.0 ok\r\n'); }
          else message += ligne.replace(/^\.\./, '.') + '\r\n';
          continue;
        }
        if (/^EHLO/i.test(ligne)) s.write('250-faux.smtp\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(ligne)) { courant.auth = Buffer.from(ligne.slice(11), 'base64').toString('utf8'); s.write('235 ok\r\n'); }
        else if (/^MAIL FROM:/.test(ligne)) { courant.de = ligne.slice(10); s.write('250 ok\r\n'); }
        else if (/^RCPT TO:/.test(ligne)) { courant.a = ligne.slice(8); s.write('250 ok\r\n'); }
        else if (ligne === 'DATA') { donnees = true; s.write('354 vas-y\r\n'); }
        else if (ligne === 'QUIT') { s.write('221 au revoir\r\n'); s.end(); }
        else s.write('500 inconnu\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise(r => serveur.listen(0, '127.0.0.1', () => r({ serveur, recus, port: serveur.address().port })));
}

test('client SMTP : authentification, en-têtes, sujet et corps encodés', async () => {
  const f = await fauxSmtp();
  try {
    const c = new Courriel(`smtp://monappli:secret%40smtp@127.0.0.1:${f.port}`, { de: 'Terrariums <ne-pas-repondre@exemple.fr>' });
    await c.envoyer({ a: 'noe@exemple.fr', sujet: 'Votre code de connexion : 123456 — à saisir', texte: 'Bonjour,\n.ligne qui commence par un point\nCode : 123456' });
    assert.equal(f.recus.length, 1);
    const m = f.recus[0];
    assert.equal(m.auth, '\0monappli\0secret@smtp', 'identifiants décodés de l\'URL, AUTH PLAIN');
    assert.equal(m.de, '<ne-pas-repondre@exemple.fr>');
    assert.equal(m.a, '<noe@exemple.fr>');
    assert.match(m.message, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m, 'sujet non ASCII encodé (RFC 2047)');
    const corps = Buffer.from(m.message.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8');
    assert.equal(corps, 'Bonjour,\n.ligne qui commence par un point\nCode : 123456');
    await assert.rejects(c.envoyer({ a: 'pas une adresse', sujet: 'x', texte: 'y' }), /destinataire invalide/);
  } finally { f.serveur.close(); }
});

test('client SMTP : pas de texte en clair vers un relais distant sans STARTTLS', async () => {
  // Le faux serveur écoute sur 127.0.0.1 mais on le joint par un nom non local.
  const f = await fauxSmtp();
  try {
    const c = new Courriel(`smtp://u:m@localhost.:${f.port}`, { delaiMs: 3000 });
    await assert.rejects(c.envoyer({ a: 'noe@exemple.fr', sujet: 'x', texte: 'y' }), /STARTTLS|ENOTFOUND|EAI_AGAIN|connexion/);
    assert.equal(f.recus.length, 0, 'rien n\'est parti en clair');
  } finally { f.serveur.close(); }
});

test('WebAuthn : CBOR, données d\'authentificateur, clé COSE', () => {
  const a = authentificateur(RP_ID);
  const r = a.creer({ challenge: 'defi', user: { id: 'u' } }, ORIGINE);
  const v = webauthn.verifierInscription(r, { defi: 'defi', rpId: RP_ID, origineAcceptee: o => o === ORIGINE });
  assert.equal(v.id, a.id);
  assert.equal(v.alg, -7);
  assert.equal(v.jwk.kty, 'EC');
  assert.throws(() => webauthn.verifierInscription(r, { defi: 'autre', rpId: RP_ID, origineAcceptee: () => true }), /défi/);
  assert.throws(() => webauthn.verifierInscription(r, { defi: 'defi', rpId: 'pirate.fr', origineAcceptee: () => true }), /RP ID/);
  assert.throws(() => webauthn.verifierInscription(r, { defi: 'defi', rpId: RP_ID, origineAcceptee: () => false }), /origine refusée/);
  assert.throws(() => webauthn.cbor(Buffer.from([0x9f])), /indéfinie/, 'longueur indéfinie refusée');
  assert.throws(() => webauthn.cbor(Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff])), /tronqué/, 'chaîne plus longue que le tampon');
  assert.throws(() => webauthn.cbor(Buffer.from([0xfa, 0, 0, 0, 0])), /non prise en charge/, 'flottant refusé');
});

test('comptes en libre-service : e-mail, clés d\'accès, sessions, export, effacement', async t => {
  const donnees = dossierTemp();
  const boite = [];
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: ADMIN, journal: () => {}, pushActif: false,
    origines: [ORIGINE], rpId: RP_ID, courriel: { envoyer: async m => { boite.push(m); } } });
  t.after(async () => { await s.arreter(); fs.rmSync(donnees, { recursive: true, force: true }); });
  const codeRecu = email => { const m = boite.filter(x => x.a === email).pop(); return m && /(\d{6})/.exec(m.sujet)[1]; };

  await t.test('infos : comptes par e-mail et clés d\'accès annoncés', async () => {
    const r = await requete(s.port, 'GET', '/api/infos');
    assert.deepEqual(r.donnees.comptes, { email: true, clesAcces: true, carnet: true });
  });

  let jeton = null;
  await t.test('code par e-mail : envoi, refus, ouverture du compte', async () => {
    assert.equal((await requete(s.port, 'POST', '/api/compte/code', { email: 'pas-une-adresse' })).status, 400);
    const r = await requete(s.port, 'POST', '/api/compte/code', { email: 'Noe@Exemple.fr ' });
    assert.equal(r.status, 200);
    assert.equal(r.donnees.valideMinutes, 10);
    const code = codeRecu('noe@exemple.fr');
    assert.match(code, /^\d{6}$/, 'le code part par e-mail, adresse en minuscules');
    assert.ok(boite[0].texte.includes(code) && /10 minutes/.test(boite[0].texte));
    const faux = String((+code + 1) % 1000000).padStart(6, '0');
    assert.equal((await requete(s.port, 'POST', '/api/compte/verifier', { email: 'noe@exemple.fr', code: faux })).status, 401);
    const ok = await requete(s.port, 'POST', '/api/compte/verifier', { email: 'noe@exemple.fr', code: code.slice(0, 3) + ' ' + code.slice(3) });
    assert.equal(ok.status, 200);
    assert.equal(ok.donnees.nouveau, true);
    assert.equal(ok.donnees.login, 'noe@exemple.fr');
    jeton = ok.donnees.jeton;
    assert.equal((await requete(s.port, 'POST', '/api/compte/verifier', { email: 'noe@exemple.fr', code })).status, 401, 'un code ne sert qu\'une fois');
    const moi = await requete(s.port, 'GET', '/api/moi', undefined, { jeton });
    assert.deepEqual([moi.donnees.email, moi.donnees.motDePasse, moi.donnees.clesAcces], ['noe@exemple.fr', false, 0]);
  });

  await t.test('code par e-mail : cinq essais, puis le code ne vaut plus', async () => {
    await requete(s.port, 'POST', '/api/compte/code', { email: 'emma@exemple.fr' });
    const code = codeRecu('emma@exemple.fr');
    const faux = String((+code + 7) % 1000000).padStart(6, '0');
    for (let i = 0; i < 5; i++) await requete(s.port, 'POST', '/api/compte/verifier', { email: 'emma@exemple.fr', code: faux });
    assert.equal((await requete(s.port, 'POST', '/api/compte/verifier', { email: 'emma@exemple.fr', code })).status, 401, 'le bon code arrive trop tard');
  });

  await t.test('code par e-mail : trois demandes par adresse et par quart d\'heure', async () => {
    const r = [];
    for (let i = 0; i < 4; i++) r.push((await requete(s.port, 'POST', '/api/compte/code', { email: 'bombarde@exemple.fr' })).status);
    assert.deepEqual(r, [200, 200, 200, 429]);
  });

  await t.test('broker : le jeton de session sert de mot de passe, sans mot de passe de compte', async () => {
    assert.equal(await connexionMqtt(s.portMqtt, 'noe@exemple.fr', jeton), true);
    assert.equal(await connexionMqtt(s.portMqtt, 'noe@exemple.fr', 'n-importe-quoi-de-long'), false);
    assert.equal((await requete(s.port, 'POST', '/api/session', { login: 'noe@exemple.fr', motDePasse: '' })).status, 401, 'pas de connexion sans mot de passe');
  });

  await t.test('sessions : hachées sur le disque', async () => {
    const disque = fs.readFileSync(path.join(donnees, 'comptes.json'), 'utf8');
    assert.ok(!disque.includes(jeton), 'le jeton n\'est pas écrit en clair');
    assert.ok(disque.includes('h:' + crypto.createHash('sha256').update(jeton).digest('hex')));
  });

  const cle = authentificateur(RP_ID);
  await t.test('clé d\'accès : inscription', async () => {
    assert.equal((await requete(s.port, 'POST', '/api/cles/options-creation', {}, { jeton, origine: 'https://pirate.exemple' })).status, 400, 'origine hors ORIGINES');
    const o = await requete(s.port, 'POST', '/api/cles/options-creation', {}, { jeton, origine: ORIGINE });
    assert.equal(o.status, 200);
    assert.equal(o.donnees.rp.id, RP_ID);
    assert.equal(o.donnees.user.name, 'noe@exemple.fr');
    assert.ok(!o.donnees.user.id.includes('noe'), 'identifiant WebAuthn aléatoire, pas l\'e-mail');
    assert.equal(o.donnees.authenticatorSelection.residentKey, 'required');
    // Réponse signée pour une autre origine : refusée.
    const autre = cle.creer(o.donnees, 'https://pirate.exemple');
    assert.equal((await requete(s.port, 'POST', '/api/cles', autre, { jeton, origine: ORIGINE })).status, 400);
    const o2 = await requete(s.port, 'POST', '/api/cles/options-creation', {}, { jeton, origine: ORIGINE });
    const r = await requete(s.port, 'POST', '/api/cles', cle.creer(o2.donnees, ORIGINE), { jeton, origine: ORIGINE });
    assert.equal(r.status, 201, JSON.stringify(r.donnees));
    assert.equal((await requete(s.port, 'POST', '/api/cles', cle.creer(o2.donnees, ORIGINE), { jeton, origine: ORIGINE })).status, 400, 'défi à usage unique');
    const liste = await requete(s.port, 'GET', '/api/cles', undefined, { jeton });
    assert.equal(liste.donnees.cles.length, 1);
    assert.equal(liste.donnees.cles[0].nom, 'Téléphone de test');
  });

  let jetonCle = null;
  await t.test('clé d\'accès : connexion, signature, compteur', async () => {
    s.api.tentatives.clear();      // les codes faux d'avant ont rempli la limite par adresse
    const opt = async () => (await requete(s.port, 'POST', '/api/cles/options-connexion', {}, { origine: ORIGINE })).donnees;
    const o = await opt();
    assert.deepEqual(o.allowCredentials, [], 'aucune liste de clés : rien ne dit quelles adresses ont un compte');
    const r = await requete(s.port, 'POST', '/api/cles/connexion', cle.signer(o, ORIGINE), { origine: ORIGINE });
    assert.equal(r.status, 200, JSON.stringify(r.donnees));
    assert.equal(r.donnees.login, 'noe@exemple.fr');
    jetonCle = r.donnees.jeton;
    assert.equal(await connexionMqtt(s.portMqtt, 'noe@exemple.fr', jetonCle), true);
    assert.equal((await requete(s.port, 'POST', '/api/cles/connexion', cle.signer(await opt(), ORIGINE, { alterer: true }), { origine: ORIGINE })).status, 401, 'signature altérée');
    assert.equal((await requete(s.port, 'POST', '/api/cles/connexion', cle.signer(await opt(), ORIGINE, { rp: 'pirate.fr' }), { origine: ORIGINE })).status, 401, 'autre RP ID');
    const rejeu = cle.signer(await opt(), ORIGINE);
    assert.equal((await requete(s.port, 'POST', '/api/cles/connexion', rejeu, { origine: ORIGINE })).status, 200);
    assert.equal((await requete(s.port, 'POST', '/api/cles/connexion', rejeu, { origine: ORIGINE })).status, 401, 'défi rejoué');
    // Les refus d'avant comptent pour la limite par adresse (10 par quart
    // d'heure) : on la remet à zéro pour voir le refus du compteur lui-même.
    s.api.tentatives.clear();
    cle.reculer(5);
    assert.equal((await requete(s.port, 'POST', '/api/cles/connexion', cle.signer(await opt(), ORIGINE), { origine: ORIGINE })).status, 401, 'compteur en arrière');
  });

  await t.test('export : tout le compte, aucun secret', async () => {
    const r = await requete(s.port, 'GET', '/api/moi/export', undefined, { jeton });
    assert.equal(r.status, 200);
    assert.match(r.entetes['content-disposition'], /attachment/);
    const texte = JSON.stringify(r.donnees);
    assert.equal(r.donnees.compte.email, 'noe@exemple.fr');
    assert.equal(r.donnees.clesAcces.length, 1);
    assert.ok(r.donnees.sessions.length >= 2);
    for (const secret of [jeton, jetonCle, 'empreinte', '"sel"', '"jwk"', 'idWebauthn']) assert.ok(!texte.includes(secret), `pas de ${secret.slice(0, 12)} dans l'export`);
  });

  await t.test('effacement : confirmation exigée, compte, sessions et historique orphelin effacés', async () => {
    // Un socle rattaché à ce seul compte, avec un historique sur le disque.
    s.comptes.attribuerSocle('noe@exemple.fr', 'terraA1B2C3');
    fs.mkdirSync(path.join(donnees, 'historique', 'terraA1B2C3'), { recursive: true });
    fs.writeFileSync(path.join(donnees, 'historique', 'terraA1B2C3', '2026-11-14.ndjson'), '[1,2400,3000,null,null]\n');
    // Ses rapports de diagnostic partent avec lui, pas ceux d'un autre compte.
    const rapports = path.join(donnees, 'rapports');
    fs.mkdirSync(rapports, { recursive: true });
    fs.writeFileSync(path.join(rapports, '2026-11-14T10-00-00-000Z-noe_exemple_fr.txt'), 'diagnostic\n');
    fs.writeFileSync(path.join(rapports, '2026-11-14T10-00-00-000Z-jean_noe_exemple_fr.txt'), 'diagnostic\n');
    assert.equal((await requete(s.port, 'DELETE', '/api/moi', { confirmation: 'autre@exemple.fr' }, { jeton })).status, 400);
    const r = await requete(s.port, 'DELETE', '/api/moi', { confirmation: 'NOE@exemple.fr' }, { jeton });
    assert.equal(r.status, 200);
    assert.equal(r.donnees.historiquesEffaces, 1);
    assert.equal((await requete(s.port, 'GET', '/api/moi', undefined, { jeton: jetonCle })).status, 401, 'toutes les sessions tombent');
    assert.equal(await connexionMqtt(s.portMqtt, 'noe@exemple.fr', jetonCle), false);
    assert.ok(!fs.existsSync(path.join(donnees, 'historique', 'terraA1B2C3')));
    assert.ok(!fs.readFileSync(path.join(donnees, 'comptes.json'), 'utf8').includes('noe@exemple.fr'));
    assert.deepEqual(fs.readdirSync(rapports), ['2026-11-14T10-00-00-000Z-jean_noe_exemple_fr.txt'], 'les rapports du compte effacé partent, pas les autres');
  });

  await t.test('rapports de diagnostic : effacés au bout d\'un an', () => {
    const rapports = path.join(donnees, 'rapports');
    const vieux = path.join(rapports, '2025-10-01T10-00-00-000Z-ancien_exemple_fr.txt');
    fs.writeFileSync(vieux, 'diagnostic\n');
    const ilYA = (Date.now() - 366 * 86400000) / 1000;
    fs.utimesSync(vieux, ilYA, ilYA);
    assert.equal(s.api.purgerRapports(), 1);
    assert.ok(!fs.existsSync(vieux));
    assert.equal(fs.readdirSync(rapports).length, 1, 'le rapport récent reste');
  });
});

test('sessions : glissantes, et migrées depuis l\'ancien format en clair', () => {
  const donnees = dossierTemp();
  try {
    const ancien = 'a'.repeat(48);
    fs.writeFileSync(path.join(donnees, 'comptes.json'), JSON.stringify({
      utilisateurs: { noe: { login: 'noe', sel: 'x', empreinte: 'y', socles: [], admin: false } },
      appareils: {}, abonnementsPush: {},
      sessions: { [ancien]: { login: 'noe', expire: new Date(Date.now() + 2 * 86400000).toISOString() } }
    }));
    const c = new Comptes(donnees);
    assert.ok(c.utilisateurDeSession(ancien), 'une session d\'avant le hachage reste valable');
    const disque = fs.readFileSync(path.join(donnees, 'comptes.json'), 'utf8');
    assert.ok(!disque.includes(ancien), 'et elle n\'est plus écrite en clair');
    const s_ = c.session(ancien);
    assert.ok(Date.parse(s_.expire) > Date.now() + 29 * 86400000, 'utilisée, elle repart pour 30 jours');
    assert.equal(c.utilisateurDeSession('b'.repeat(48)), null);
  } finally { fs.rmSync(donnees, { recursive: true, force: true }); }
});
