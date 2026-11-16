'use strict';
/* =============================================================================
   Essai MQTT de bout en bout, lancé par essai-bout-en-bout.sh dans l'image du
   serveur, sur le réseau de la machine. Deux connexions avec le compte
   d'appareil d'essai : MQTT chiffré sur 8883, puis MQTT sur WebSocket
   (wss://<domaine>/mqtt). Chacune vise Traefik en local (127.0.0.1) sous le
   nom du serveur (SNI) : le certificat est donc vérifié comme le ferait un
   socle. Le compte s'abonne à son sujet cmd, y publie et doit relire son
   message.

   Variables : DOMAINE, ESSAI_ID, ESSAI_MDP (jamais affiché). ESSAI_SANS_TLS=1
   vise un serveur local sans Traefik (mqtt://…:1883, ws://…:8080), pour
   essayer le script lui-même.
   ============================================================================= */

const mqtt = require('mqtt');

const DOMAINE = process.env.DOMAINE || 'localhost';
const ID = process.env.ESSAI_ID;
const MDP = process.env.ESSAI_MDP;
const SANS_TLS = process.env.ESSAI_SANS_TLS === '1';
const LOCAL = '127.0.0.1';
const DELAI_MS = 15000;

function essai(nom, url, options) {
  return new Promise(resolve => {
    const sujet = `terrarium/${ID}/cmd`;
    const marque = `essai-${process.pid}-${Date.now()}`;
    let fini = false;
    const client = mqtt.connect(url, {
      ...options, username: ID, password: MDP, clientId: `${ID}-essai-${process.pid}`,
      reconnectPeriod: 0, connectTimeout: DELAI_MS
    });
    const minuteur = setTimeout(() => fin(false, 'délai dépassé'), DELAI_MS);
    function fin(ok, raison) {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      client.end(true);
      console.log(`  ${ok ? 'OK    ' : 'ÉCHEC '}  ${nom}${raison ? ` : ${raison}` : ''}`);
      resolve(ok);
    }
    client.on('error', e => fin(false, e.message));
    client.on('close', () => fin(false, 'connexion fermée par le serveur'));
    client.on('connect', () => {
      client.subscribe(sujet, { qos: 1 }, (e, accords) => {
        if (e || !accords || !accords.length || accords[0].qos === 128) return fin(false, 'abonnement refusé');
        client.publish(sujet, JSON.stringify({ essai: marque }), { qos: 1 });
      });
    });
    client.on('message', (t, m) => { if (t === sujet && String(m).includes(marque)) fin(true); });
  });
}

(async () => {
  if (!ID || !MDP) { console.error('ESSAI_ID et ESSAI_MDP sont requis'); process.exit(2); }
  const tls = { servername: DOMAINE, rejectUnauthorized: true };
  const resultats = SANS_TLS ? [
    await essai('MQTT local (1883)', `mqtt://${LOCAL}:1883`, {}),
    await essai('MQTT sur WebSocket local (8080)', `ws://${LOCAL}:8080/mqtt`, {})
  ] : [
    await essai(`MQTT chiffré sur ${DOMAINE}:8883`, `mqtts://${LOCAL}:8883`, tls),
    await essai(`MQTT sur WebSocket, wss://${DOMAINE}/mqtt`, `wss://${LOCAL}:443/mqtt`,
      { wsOptions: { ...tls, headers: { Host: DOMAINE } } })
  ];
  process.exit(resultats.every(Boolean) ? 0 : 1);
})();
