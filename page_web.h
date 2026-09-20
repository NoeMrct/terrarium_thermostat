/* page_web.h — interface web embarquée, servie depuis la flash programme. */
#ifndef PAGE_WEB_H
#define PAGE_WEB_H

#include <Arduino.h>

static const char PAGE_HTML[] PROGMEM = R"HTML(<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terrarium</title><link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#111"><link rel="icon" href="/icone.svg"><style>
:root{--f:#111;--c:#1c1c1c;--t:#eee;--g:#8a9;--a:#2a6}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:14px;background:var(--f);color:var(--t)}
h1{font-size:17px;margin:0 0 4px}.sub{color:var(--g);font-size:12px;margin-bottom:12px}
.card{background:var(--c);border-radius:12px;padding:13px;margin-bottom:11px}
.big{font-size:32px;font-weight:600;line-height:1.1}
.g{color:var(--g);font-size:12.5px}.bad{color:#f66;font-weight:600}.warn{color:#fb4}
canvas{width:100%;height:210px;background:#181818;border-radius:12px;display:block}
label{display:block;margin:7px 0 2px;font-size:11.5px;color:var(--g)}
input,select{width:92px;background:#222;color:var(--t);border:1px solid #3a3a3a;border-radius:7px;padding:6px;font-size:14px}
input.w{width:100%;box-sizing:border-box}
button{background:var(--a);color:#04140c;border:0;border-radius:9px;padding:9px 15px;font-weight:600;font-size:14px;margin:9px 6px 0 0;cursor:pointer}
button.s{background:#333;color:var(--t)}
.row{display:flex;gap:9px;flex-wrap:wrap}
.tabs{display:flex;gap:6px;margin-bottom:11px;flex-wrap:wrap}
.tabs button{margin:0;background:#242424;color:var(--t);font-weight:500}
.tabs button.on{background:var(--a);color:#04140c}
pre{background:#0d0d0d;padding:9px;border-radius:8px;font-size:11px;overflow:auto;max-height:340px;white-space:pre-wrap}
.pill{display:inline-block;background:#242424;border-radius:20px;padding:2px 9px;font-size:11px;color:var(--g);margin-right:5px}
button.danger{background:#5a2222;color:#fdd}
.avert{background:#3a2c14;border:1px solid #6a5320;color:#fd9;border-radius:10px;padding:9px 12px;margin-bottom:11px;font-size:12.5px;line-height:1.45}
.avert b{color:#fec}
h3{font-size:13px;margin:14px 0 2px;color:var(--t)}
progress{width:100%;height:9px}
</style></head><body>
<h1>Thermostat terrarium</h1><div class="sub" id="entete">…</div>
<div id="avertissements"></div>
<div class="tabs">
<button class="on" onclick="onglet('vue',this)">Vue</button>
<button onclick="onglet('reg',this)">Réglages</button>
<button onclick="onglet('res',this)">Réseau</button>
<button onclick="onglet('sta',this)">Stats</button>
<button onclick="onglet('log',this)">Journal</button>
</div>
<div id="vue"><div id="zones"></div><div class="card"><canvas id="g" width="760" height="210"></canvas>
<div class="g" style="margin-top:7px">Trait plein : température · pointillés : consigne
<select id="duree" onchange="trace()"></select>
<a href="/api/history.csv" style="color:var(--a)">export CSV</a></div></div></div>
<div id="sta" style="display:none"><div class="card" id="stxt">…</div>
<div class="card"><div class="g">Couper le chauffage le temps d'une intervention, avec reprise automatique.</div>
<button onclick="post('/api/maintenance?minutes=10')">Entretien 10 min</button>
<button class="s" onclick="post('/api/maintenance?minutes=0')">Annuler</button></div>
<div class="card"><div class="g">Actions sur l'appareil.</div>
<button class="s" onclick="redemarrer()">Redémarrer</button>
<button class="danger" onclick="effacerHistorique()">Effacer l'historique</button></div></div>
<div id="reg" style="display:none"></div>
<div id="res" style="display:none"></div>
<div id="log" style="display:none"><div class="card"><pre id="jtxt">…</pre>
<button class="s" onclick="fetch('/api/journal',{method:'DELETE',headers:{'X-Terrarium':'1'}}).then(charge)">Effacer le journal</button></div></div>
<script>
const C=['#5cf','#fa6'];let S=null;
function onglet(id,b){['vue','reg','res','sta','log'].forEach(x=>document.getElementById(x).style.display=x==id?'':'none');
document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));b.classList.add('on');
if(id=='log')charge();if(id=='sta')stats();}
async function stats(){
 const d=await(await fetch('/api/stats')).json();
 let h='<div class="g">Firmware '+esc(d.version)+' — compilé le '+esc(d.compile)+
  '<br>'+d.zonesSimultanees+' zone(s) peuvent chauffer en même temps'+
  (d.saison?' · décalage saisonnier '+d.saison.toFixed(1)+' °C':'')+
  (d.maintenanceRestanteS?' · <b>entretien : '+Math.ceil(d.maintenanceRestanteS/60)+' min restantes</b>':'')+'</div>';
 d.zones.forEach((z,i)=>{
  h+='<div style="margin-top:11px"><b style="color:'+C[i]+'">'+esc(z.nom)+'</b><div class="g">';
  h+= z.points? 'Sur 24 h : min '+z.min.toFixed(1)+' °C · max '+z.max.toFixed(1)+' °C · moyenne '+
      z.moyenne.toFixed(1)+' °C · hors plage '+z.horsPlagePct+' % du temps<br>'
     :'Pas encore assez d\'historique.<br>';
  h+='Chauffe cumulée '+z.heuresChauffe.toFixed(1)+' h · '+z.kWh.toFixed(2)+' kWh<br>';
  h+='Défauts : sonde '+z.defauts.sonde+' · surchauffe '+z.defauts.surchauffe+' · sonde figée '+z.defauts.figee;
  h+='</div></div>';});
 document.getElementById('stxt').innerHTML=h;}
const esc=s=>String(s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
async function maj(){
 const r=await fetch('/api/status');if(!r.ok)return;S=await r.json();
 document.getElementById('entete').innerHTML=
  `<span class="pill">${esc(S.heure)}</span><span class="pill">actif : ${S.tapisActif<0?'aucun':'tapis '+(S.tapisActif+1)}</span>`+
  `<span class="pill">${Math.floor(S.uptime/3600)} h de service</span>`+
  (S.maintenanceS?`<span class="pill warn">entretien : ${Math.ceil(S.maintenanceS/60)} min</span>`:'')+
  (S.alertesEnAttente?`<span class="pill warn">${S.alertesEnAttente} alerte(s) en attente</span>`:'')+
  `<span class="pill">v${esc(S.version||'?')}</span>`;
 document.getElementById('zones').innerHTML=S.zones.map((z,i)=>
  `<div class="card"><div class="g">${esc(z.nom)} — cible ${z.consigne.toFixed(1)} °C${z.autotune?' · AUTOTUNE':''}</div>
   <div class="big" style="color:${C[i]}">${z.defaut?'—':z.temp.toFixed(2)+' °C'}</div>
   ${z.defaut?`<div class="bad">DÉFAUT : ${esc(z.defaut)}</div><button onclick="post('/api/reset')">Lever</button>`
    :`<div class="g">demande ${z.demande} % · charge ${z.duty} % ${z.chauffe?'· <b style="color:'+C[i]+'">CHAUFFE</b>':''}${z.derive?' · <span class="warn">dérive</span>':''}</div>`}
   </div>`).join('');
 durees(S.histHeures||24);
 // L'OTA ouverte est le defaut de configuration le plus couteux : n'importe qui
 // sur le reseau local peut alors reecrire le firmware. Elle est desormais
 // desactivee tant qu'aucun mot de passe n'est defini — on le dit franchement,
 // plutot que de laisser croire que la mise a jour sans fil fonctionne.
 const av=[];
 if(S.otaProtegee===false)av.push(
  `<b>Mise à jour sans fil désactivée.</b> Aucun mot de passe OTA n'est défini, donc
   ArduinoOTA n'est pas démarrée — sans quoi n'importe quel appareil du réseau local
   pourrait réécrire ce firmware. Définis-en un dans l'onglet Réseau pour l'activer ;
   le téléversement depuis cette page reste disponible entre-temps.`);
 document.getElementById('avertissements').innerHTML=
  av.map(t=>`<div class="avert">${t}</div>`).join('');
 if(!document.getElementById('j0'))formulaires();
 // Les formulaires ne sont construits qu'une fois — les reconstruire effacerait
 // une saisie en cours. Seul l'etat des boutons d'autotune est rafraichi ici.
 S.zones.forEach((z,i)=>{
  const a=document.getElementById('at'+i),b=document.getElementById('sat'+i);
  if(a&&b){a.hidden=!!z.autotune;b.hidden=!z.autotune;}});
}
function formulaires(){
 document.getElementById('reg').innerHTML=S.zones.map((z,i)=>
  `<div class="card"><div class="g">${esc(z.nom)}</div>
   <label>Nom</label><input class="w" id="nom${i}" value="${esc(z.nom)}">
   <div class="row">
   <div><label>Jour °C</label><input id="j${i}" value="${z.jour}"></div>
   <div><label>Nuit °C</label><input id="n${i}" value="${z.nuit}"></div>
   <div><label>Début jour</label><input id="H${i}" value="${z.debutJour}"></div>
   <div><label>Début nuit</label><input id="N${i}" value="${z.debutNuit}"></div>
   <div><label>Rampe (min)</label><input id="R${i}" value="${z.rampe}"></div>
   <div><label>Bande °C</label><input id="b${i}" value="${z.bande}"></div>
   <div><label>Gain intégral</label><input id="k${i}" value="${z.ki}"></div>
   <div><label>Coupure max °C</label><input id="m${i}" value="${z.max}"></div>
   <div><label>Calibration °C</label><input id="o${i}" value="${z.offset}"></div>
   <div><label>Sans effet (min)</label><input id="I${i}" value="${z.inefficaceMin}"></div>
   <div><label>Hausse mini °C</label><input id="D${i}" value="${z.inefficaceDelta}"></div>
   <div><label>Dérive °C</label><input id="d${i}" value="${z.deriveSeuil}"></div>
   <div><label>Dérive (min)</label><input id="E${i}" value="${z.deriveMin}"></div>
   <div><label>Chute brutale °C</label><input id="C${i}" value="${z.chuteSeuil}"></div>
   <div><label>Fenêtre chute (s)</label><input id="F${i}" value="${z.chuteSecondes}"></div>
   </div>
   <button onclick="envoyer(${i})">Enregistrer</button>
   <button class="s" id="at${i}" onclick="post('/api/autotune?z=${i}')">Lancer l'autotune</button>
   <button class="danger" id="sat${i}" hidden onclick="supprimer('/api/autotune?z=${i}')">Arrêter l'autotune</button></div>`).join('')
  +`<div class="card"><div class="g">Sondes 1-Wire détectées</div><div id="sondes">…</div>
    <button class="s" onclick="scan()">Scanner</button></div>
    <div class="card"><h3>Réglages généraux</h3>
    <div class="g">Ces réglages valent pour l'appareil entier, pas pour une zone.</div>
    <h3>Alimentation</h3>
    <div class="g">C'est elle qui décide combien de zones peuvent chauffer en même temps.</div>
    <div class="row">
     <div><label>Ampérage (A)</label><input id="gA"></div>
     <div><label>Tapis (W)</label><input id="gW"></div>
     <div><label>Tension (V)</label><input id="gV"></div>
    </div>
    <div class="g" id="gZones" style="margin-top:6px"></div>
    <h3>Confort</h3>
    <div class="row">
     <div><label>Entretien par défaut (min)</label><input id="gE"></div>
     <div><label>Veille écran (min, 0 = jamais)</label><input id="gS"></div>
    </div>
    <h3>Cyclage saisonnier</h3>
    <div class="g">Descente progressive des consignes, plateau, puis remontée —
     la période de repos hivernal de beaucoup d'espèces.</div>
    <div class="row">
     <div><label>Actif</label><select id="gSA"><option value="0">non</option><option value="1">oui</option></select></div>
     <div><label>Abaissement (°C)</label><input id="gSD"></div>
     <div><label>Descente (j)</label><input id="gS1"></div>
     <div><label>Plateau (j)</label><input id="gS2"></div>
     <div><label>Remontée (j)</label><input id="gS3"></div>
    </div>
    <div class="g" id="gEtatSaison" style="margin-top:6px"></div>
    <button onclick="envoyerGlobaux()">Enregistrer</button>
    <button class="s" onclick="envoyerGlobaux(1)">Enregistrer et repartir du jour 1</button></div>`;
 document.getElementById('res').innerHTML=
  `<div class="card"><div class="g">Ces réglages sont enregistrés dans la flash : aucune recompilation nécessaire.
   Laisser un champ vide désactive la fonction correspondante.</div>
   <label>SSID WiFi</label><input class="w" id="ssid">
   <label>Mot de passe WiFi (vide = inchangé)</label><input class="w" id="wpass" type="password">
   <label>Utilisateur de cette interface (vide = accès libre)</label><input class="w" id="wu">
   <label>Mot de passe de cette interface (vide = inchangé)</label><input class="w" id="wp" type="password">
   <label>Mot de passe OTA (vide = inchangé)</label><input class="w" id="op" type="password">
   <label>Mot de passe du point d'accès de secours (8 car. min, vide = inchangé)</label><input class="w" id="ap" type="password">
   <label>URL d'alerte (POST JSON, https accepté)</label><input class="w" id="ua">
   <label>Jeton envoyé avec les alertes (« Authorization: Bearer », vide = inchangé)</label><input class="w" id="aj" type="password">
   <label>URL de heartbeat (GET périodique)</label><input class="w" id="uh">
   <label>Période de heartbeat (min)</label><input id="hm">
   <label>Serveur MQTT (vide = désactivé)</label><input class="w" id="mh">
   <div class="row"><div><label>Port</label><input id="mp"></div>
   <div><label>Préfixe</label><input id="mx"></div></div>
   <label>Utilisateur MQTT</label><input class="w" id="mu">
   <label>Mot de passe MQTT (vide = inchangé)</label><input class="w" id="mw" type="password">
   <label>MQTT chiffré (TLS)</label><select id="mt"><option value="1">oui</option><option value="0">non</option></select>
   <label>Vérifier les certificats</label><select id="vt"><option value="1">oui</option><option value="0">non</option></select>
   <label>Découverte Home Assistant</label><select id="ha"><option value="1">activée</option><option value="0">désactivée</option></select>
   <label>Fuseau horaire (chaîne TZ)</label><input class="w" id="tz">
   <label>Serveur NTP</label><input class="w" id="ntp">
   <button onclick="envoyerRes()">Enregistrer et redémarrer</button>
   <button class="s" onclick="effacerJetonAlerte()">Retirer le jeton d'alerte</button></div>
   <div class="card"><div class="g">Ce qu'il faut saisir dans l'application pour rattacher ce socle.
   Le code d'appairage vaut preuve de propriété : ne le communique à personne d'autre.</div>
   <label>Identifiant de l'appareil</label>
   <div style="font-family:monospace;font-size:19px;letter-spacing:2px;margin:9px 0" id="app">…</div>
   <label>Code d'appairage</label>
   <div style="font-family:monospace;font-size:19px;letter-spacing:2px;margin:9px 0;word-break:break-all"
        id="jet">…</div></div>
   <div class="card"><h3>Mise à jour du firmware</h3>
   <div class="g">Envoie le fichier <code>.ino.bin</code> produit par « Croquis → Exporter les binaires ».
   Le chauffage est coupé pendant l'écriture, et l'appareil redémarre ensuite.
   Ne coupe pas l'alimentation.</div>
   <input class="w" type="file" id="binaire" accept=".bin">
   <progress id="progMaj" value="0" max="100" hidden></progress>
   <div class="g" id="etatMaj"></div>
   <button onclick="envoyerMaj()">Téléverser et redémarrer</button></div>`;
 chargeRes();
 chargeGlobaux();
}
async function chargeGlobaux(){
 const g=await(await fetch('/api/globaux')).json();
 for(const [k,v] of Object.entries({gA:g.courantAlimA,gW:g.puissanceTapisW,gV:g.tensionV,
  gE:g.maintenanceMin,gS:g.ecranVeilleMin,gSD:g.saisonDelta,gS1:g.saisonDescenteJ,
  gS2:g.saisonPlateauJ,gS3:g.saisonRemonteeJ})) {const el=document.getElementById(k);if(el)el.value=v;}
 document.getElementById('gSA').value=g.saisonActive?'1':'0';
 document.getElementById('gZones').textContent=
  g.zonesSimultanees+' zone(s) peuvent chauffer en même temps avec cette alimentation.';
 document.getElementById('gEtatSaison').textContent=
  g.saisonActive?('Cycle en cours · décalage appliqué : '+g.decalageActuel.toFixed(2)+' °C')
   :(g.heureFiable?'Cycle inactif.':'Cycle inactif — et l\'heure est inconnue, il ne peut pas démarrer.');}
async function envoyerGlobaux(redemarrerCycle){
 const v=id=>encodeURIComponent(document.getElementById(id).value);
 let q=`courantAlimA=${v('gA')}&puissanceTapisW=${v('gW')}&tensionV=${v('gV')}`
  +`&maintenanceMin=${v('gE')}&ecranVeilleMin=${v('gS')}&saisonActive=${v('gSA')}`
  +`&saisonDelta=${v('gSD')}&saisonDescenteJ=${v('gS1')}&saisonPlateauJ=${v('gS2')}&saisonRemonteeJ=${v('gS3')}`;
 if(redemarrerCycle)q+='&saisonRedemarrer=1';
 const r=await fetch('/api/globaux',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:q});
 alert(await r.text());chargeGlobaux();maj();}
async function chargeRes(){const c=await(await fetch('/api/reseau')).json();
 for(const [k,v] of Object.entries({ssid:c.ssid,wu:c.webUtilisateur,ua:c.urlAlertes,uh:c.urlHeartbeat,
  hm:c.heartbeatMinutes,mh:c.mqttHote,mp:c.mqttPort,mx:c.mqttPrefixe,mu:c.mqttUtilisateur,tz:c.fuseau,ntp:c.ntp}))
  document.getElementById(k).value=v;
 document.getElementById('ha').value=c.decouverteHA?'1':'0';
 document.getElementById('mt').value=c.mqttTls?'1':'0';
 document.getElementById('vt').value=c.verifierTls?'1':'0';
 document.getElementById('jet').textContent=c.jeton||'—';
 document.getElementById('app').textContent=c.appareil||'—';}
const H={'X-Terrarium':'1'};
async function post(u){const r=await fetch(u,{method:'POST',headers:H});alert(await r.text());maj();}
async function supprimer(u){const r=await fetch(u,{method:'DELETE',headers:H});alert(await r.text());maj();}
async function effacerHistorique(){
 if(!confirm('Effacer tout l\'historique ? Les courbes repartent de zéro.'))return;
 await supprimer('/api/history');trace();}
async function redemarrer(){
 if(!confirm('Redémarrer le socle ? Le chauffage est coupé une quinzaine de secondes.'))return;
 await post('/api/redemarrer');}
async function effacerJetonAlerte(){
 if(!confirm('Retirer le jeton envoyé avec les alertes ?'))return;
 const r=await fetch('/api/reseau',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:'alerteJetonVide=1'});
 alert(await r.text());}
// Téléversement du firmware : XMLHttpRequest et non fetch, pour la barre de
// progression — un binaire d'1,4 Mo met une bonne dizaine de secondes.
function envoyerMaj(){
 const f=document.getElementById('binaire').files[0];
 if(!f){alert('Choisis d\'abord un fichier .bin');return;}
 if(!confirm('Téléverser '+f.name+' ('+Math.round(f.size/1024)+' Ko) ? Le chauffage est coupé pendant l\'écriture.'))return;
 const p=document.getElementById('progMaj'),e=document.getElementById('etatMaj');
 p.hidden=false;p.value=0;e.textContent='Envoi…';
 const d=new FormData();d.append('firmware',f);
 const x=new XMLHttpRequest();
 x.open('POST','/api/maj');
 x.setRequestHeader('X-Terrarium','1');
 x.upload.onprogress=ev=>{if(ev.lengthComputable){p.value=Math.round(ev.loaded/ev.total*100);
  e.textContent='Envoi : '+p.value+' %';}};
 x.onload=()=>{e.textContent=x.responseText;p.hidden=true;
  if(x.status===200)setTimeout(()=>location.reload(),20000);};
 x.onerror=()=>{e.textContent='Envoi interrompu — vérifie la liaison, puis recommence.';p.hidden=true;};
 x.send(d);}
async function scan(){
 const d=await(await fetch('/api/sondes')).json();let h='';
 d.sondes.forEach(s=>{
  h+='<div class="g" style="margin:6px 0">'+esc(s.rom)+' — '+s.temp.toFixed(2)+' °C '+
     (s.zone>=0?'(liee a la zone '+(s.zone+1)+')':'(non liee)');
  for(let z=0;z<2;z++)h+=' <button class="s" onclick="lier(\''+esc(s.rom)+'\','+z+')">vers zone '+(z+1)+'</button>';
  h+='</div>';});
 document.getElementById('sondes').innerHTML=h||'<div class="g">aucune sonde detectee</div>';}
async function lier(rom,z){const r=await fetch('/api/sondes?rom='+rom+'&z='+z,{method:'POST',headers:H});alert(await r.text());scan();}
async function envoyer(i){
 const v=id=>encodeURIComponent(document.getElementById(id+i).value);
 const q=`z=${i}&nom=${v('nom')}&jour=${v('j')}&nuit=${v('n')}&bande=${v('b')}&ki=${v('k')}&max=${v('m')}`+
   `&offset=${v('o')}&debutJour=${v('H')}&debutNuit=${v('N')}&rampe=${v('R')}&inefficaceMin=${v('I')}`+
   `&inefficaceDelta=${v('D')}&deriveSeuil=${v('d')}&deriveMin=${v('E')}`+
   `&chuteSeuil=${v('C')}&chuteSecondes=${v('F')}`;
 const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:q});
 alert(await r.text());maj();}
async function envoyerRes(){
 const v=id=>encodeURIComponent(document.getElementById(id).value);
 const q=`ssid=${v('ssid')}&wifiPass=${v('wpass')}&webUser=${v('wu')}&webPass=${v('wp')}&otaPass=${v('op')}&apPass=${v('ap')}`+
  `&urlAlertes=${v('ua')}&alerteJeton=${v('aj')}&urlHeartbeat=${v('uh')}&heartbeatMin=${v('hm')}&mqttHote=${v('mh')}&mqttPort=${v('mp')}`+
  `&mqttPrefixe=${v('mx')}&mqttUser=${v('mu')}&mqttPass=${v('mw')}&ha=${v('ha')}&mqttTls=${v('mt')}&verifierTls=${v('vt')}&fuseau=${v('tz')}&ntp=${v('ntp')}`;
 if(!confirm("Enregistrer et redémarrer ? Le chauffage est coupé pendant le redémarrage."))return;
 const r=await fetch('/api/reseau',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:q});
 alert(await r.text());}
async function charge(){document.getElementById('jtxt').textContent=await(await fetch('/api/journal')).text();}
async function trace(){
 const h=await(await fetch('/api/history?heures='+document.getElementById('duree').value)).json();
 dessiner(h.points);}
function dessiner(p){
 const c=document.getElementById('g'),x=c.getContext('2d');
 x.clearRect(0,0,c.width,c.height);if(!p.length)return;
 let lo=99,hi=-99;
 p.forEach(q=>[q.t0,q.t1,q.c0,q.c1].forEach(v=>{if(v>-300){lo=Math.min(lo,v);hi=Math.max(hi,v)}}));
 if(hi<lo){return}lo-=1;hi+=1;
 const t0=p[0].e,t1=p[p.length-1].e||t0+1;
 const X=e=>(e-t0)/Math.max(1,t1-t0)*(c.width-4)+2,Y=v=>c.height-14-(v-lo)/(hi-lo)*(c.height-24);
 // Memorise pour le survol et le glisser-zoomer : sans cette ligne, PTS restait
 // nul et les deux fonctionnalites ne faisaient rien du tout.
 PTS=p;GX=X;GY=Y;GLO=lo;GHI=hi;
 x.strokeStyle='#2c2c2c';x.lineWidth=1;x.beginPath();
 for(let k=0;k<=4;k++){const y=Y(lo+(hi-lo)*k/4);x.moveTo(0,y);x.lineTo(c.width,y)}x.stroke();
 x.fillStyle='#777';x.font='10px sans-serif';
 for(let k=0;k<=4;k++)x.fillText((lo+(hi-lo)*k/4).toFixed(1),3,Y(lo+(hi-lo)*k/4)-2);
 for(let k=0;k<=4;k++){const e=t0+(t1-t0)*k/4,d=new Date(e*1000);
  x.fillText(('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2),Math.min(c.width-28,Math.max(0,X(e)-14)),c.height-3)}
 for(let z=0;z<2;z++){
  const T=z?'t1':'t0',K=z?'c1':'c0';
  x.strokeStyle=C[z];x.lineWidth=1.8;x.beginPath();let n=0;
  p.forEach(q=>{const v=q[T];if(v<-300){n=0;return}n++?x.lineTo(X(q.e),Y(v)):x.moveTo(X(q.e),Y(v))});x.stroke();
  x.setLineDash([4,4]);x.lineWidth=1;x.beginPath();n=0;
  p.forEach(q=>{const v=q[K];if(v<-300){n=0;return}n++?x.lineTo(X(q.e),Y(v)):x.moveTo(X(q.e),Y(v))});x.stroke();x.setLineDash([])}
}
function durees(h){const sel=document.getElementById('duree');if(sel.options.length)return;
 const dispo=[[6,'6 h'],[24,'24 h'],[72,'3 j'],[168,'7 j'],[336,'14 j']].filter(o=>o[0]<=Math.max(6,h));
 dispo.forEach(o=>sel.add(new Option(o[1],o[0])));
 // La valeur choisie doit exister dans la liste : avec une petite partition
 // (moins de 24 h d'historique) l'ancien calcul laissait le selecteur vide, et
 // la requete partait sans duree.
 const par_defaut=dispo.filter(o=>o[0]<=24).pop()||dispo[0];
 if(par_defaut)sel.value=par_defaut[0];}
let PTS=null,GX=null,GY=null,GLO=0,GHI=0,ZA=null,ZB=null;
// Survol : lecture des valeurs exactes sous le curseur, et selection par
// glisser pour zoomer sur une periode.
(function(){const c=document.getElementById('g');
 const info=document.createElement('div');info.className='g';info.style.minHeight='16px';
 c.parentNode.appendChild(info);
 function pt(ev){const r=c.getBoundingClientRect();
  const xx=(ev.touches?ev.touches[0].clientX:ev.clientX)-r.left;
  return xx/r.width*c.width;}
 c.addEventListener('mousemove',e=>{if(!PTS||!PTS.length)return;
  const px=pt(e);let best=null,bd=1e9;
  PTS.forEach(q=>{const d=Math.abs(GX(q.e)-px);if(d<bd){bd=d;best=q;}});
  if(!best)return;const dt=new Date(best.e*1000);
  info.textContent=dt.toLocaleString()+'  —  Z1 '+(best.t0>-300?best.t0.toFixed(2)+' °C':'—')+
    '  ·  Z2 '+(best.t1>-300?best.t1.toFixed(2)+' °C':'—');});
 c.addEventListener('mouseleave',()=>info.textContent='');
 c.addEventListener('mousedown',e=>{ZA=pt(e);});
 c.addEventListener('mouseup',e=>{if(ZA===null)return;const b=pt(e);
  if(Math.abs(b-ZA)<10){ZA=null;return;}
  const lo=Math.min(ZA,b),hi=Math.max(ZA,b);
  ZB=PTS.filter(q=>GX(q.e)>=lo&&GX(q.e)<=hi);ZA=null;
  if(ZB.length>1)dessiner(ZB);else ZB=null;});
 c.addEventListener('dblclick',()=>{ZB=null;trace();});
})();
maj();trace();setInterval(maj,10000);setInterval(()=>{if(!ZB)trace();},60000);
</script></body></html>)HTML";

#endif // PAGE_WEB_H
