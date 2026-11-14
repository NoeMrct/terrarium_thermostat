/* page_web.h — interface web embarquée, servie depuis la flash programme.
   Même langage visuel que l'application (app/style.css) : fond blanc, cartes
   grises sans ombre, noir pour les commandes, orange et bleu pour les zones,
   grands chiffres fins ; sombre automatique. Après toute modification :
   node outils/compresser-page.js (régénère page_web_gz.h). */
#ifndef PAGE_WEB_H
#define PAGE_WEB_H

#include <Arduino.h>

static const char PAGE_HTML[] PROGMEM = R"HTML(<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Terrarium</title><link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#f3f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icone.svg"><style>
:root{color-scheme:light dark;--f:#fff;--c:#f6f6f4;--k:#efefec;--l:#e6e6e3;--t:#121315;--g:#5f6368;--g3:#6b7075;--a:#121315;--at:#fff;--ad:#e8f3ed;--ok:#17683f;--w:#9a4a07;--wd:#fdf1df;--d:#b42318;--dd:#fbedeb;--z1:#e0661c;--z2:#2f6fdb}
@media(prefers-color-scheme:dark){:root{--f:#0d0e10;--c:#17181b;--k:#232428;--l:#2a2b30;--t:#f2f2f0;--g:#a7abb0;--g3:#93989e;--a:#f2f2f0;--at:#121315;--ad:#173327;--ok:#3ccf8e;--w:#fbbf24;--wd:#332a12;--d:#f97066;--dd:#3a1d1d;--z1:#f08a4b;--z2:#6c9cf0}}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:14px 16px 28px;background:var(--f);color:var(--t);font-size:15px;line-height:1.45;font-variant-numeric:tabular-nums;max-width:1040px;margin-inline:auto}
h1{font-size:26px;margin:4px 0 2px;font-weight:600;letter-spacing:-.01em}.sub{color:var(--g);font-size:12px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:4px}
.marque{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--g)}.marque b{height:24px;padding:0 10px;border-radius:12px;background:var(--a);color:var(--at);display:inline-flex;align-items:center;font-size:11.5px;font-weight:600;letter-spacing:.04em}
.card{background:var(--c);border-radius:20px;padding:16px;margin-bottom:14px}
.big{font-size:40px;font-weight:200;line-height:1.05;letter-spacing:-.03em;margin:4px 0}.et{font-size:13px;font-weight:500;color:var(--g)}.et.ch{color:var(--z1)}.z2 .et.ch,.et.ch.z2{color:var(--z2)}
.g{color:var(--g);font-size:12.5px}.bad{color:var(--d);font-weight:650}.warn{color:var(--w);font-weight:600}
canvas{width:100%;height:230px;background:var(--k);border-radius:14px;display:block}
label{display:block;margin:10px 0 4px;font-size:12.5px;font-weight:500;color:var(--g)}
input,select{width:110px;min-height:40px;background:var(--k);color:var(--t);border:1px solid transparent;border-radius:12px;padding:7px 11px;font-size:15px;font:inherit}
input:focus-visible,select:focus-visible{outline:none;border-color:#2f6fdb;box-shadow:0 0 0 3px rgba(47,111,219,.25)}
input.w{width:100%;box-sizing:border-box}
button{background:var(--a);color:var(--at);border:0;border-radius:999px;padding:10px 18px;font-weight:500;font-size:14px;margin:10px 6px 0 0;cursor:pointer;font-family:inherit;min-height:42px}
button:focus-visible{outline:3px solid #2f6fdb;outline-offset:2px}
button.s{background:var(--k);color:var(--t)}button.danger{background:var(--dd);color:var(--d)}
.row{display:flex;gap:9px;flex-wrap:wrap}
.tabs{display:inline-flex;gap:4px;padding:4px;margin-bottom:14px;background:var(--k);border-radius:16px;flex-wrap:wrap}
.tabs button{margin:0;background:transparent;color:var(--t);font-weight:500;border-radius:12px;padding:7px 14px;min-height:40px;font-size:14px}
.tabs button.on{background:var(--f);box-shadow:0 1px 3px rgba(18,19,21,.14)}
pre{background:var(--k);padding:10px;border-radius:12px;font-size:11.5px;overflow:auto;max-height:340px;white-space:pre-wrap;color:var(--t)}
.pill{display:inline-flex;align-items:center;gap:5px;background:var(--k);border-radius:999px;padding:5px 10px;font-size:12px;font-weight:600;color:var(--g)}
.pill.ok{background:var(--ad);color:var(--ok)}.pill.warn{background:var(--wd);color:var(--w)}
.avert{background:var(--wd);color:var(--w);border-radius:14px;padding:10px 12px;margin-bottom:12px;font-size:12.5px;line-height:1.45}
#connexion,#creation{position:fixed;inset:0;background:var(--f);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9}
#connexion .card,#creation .card{width:100%;max-width:360px}#connexion[hidden],#creation[hidden]{display:none}
h3{font-size:13px;margin:14px 0 2px;color:var(--g);font-weight:600}
progress{width:100%;height:9px}a{color:inherit}
.zone{display:flex;align-items:center;gap:6px;color:var(--g);font-size:13px;font-weight:500}
.zone::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--z1)}.zone.z2::before{background:var(--z2)}
.stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-top:8px}
.stat div{background:var(--k);border-radius:12px;padding:9px 10px}.stat b{display:block;font-size:16px;font-weight:650}.stat span{font-size:11.5px;color:var(--g)}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:6px;text-align:left;border-bottom:1px solid var(--l);vertical-align:top}th{color:var(--g);font-weight:600}
@media(min-width:760px){#zones{display:grid;grid-template-columns:1fr 1fr;gap:14px}#zones .card{margin:0}#zones+.card{margin-top:14px}}
</style></head><body>
<div id="connexion" hidden><form class="card" onsubmit="connecter(event)"><h3 style="margin-top:0">Connexion</h3>
<div class="g">Le mot de passe ne quitte pas ce navigateur : il sert à répondre à un défi du socle.</div>
<label>Utilisateur</label><input class="w" id="cu" autocomplete="username">
<label>Mot de passe</label><input class="w" id="cm" type="password" autocomplete="current-password">
<div class="bad" id="cerr"></div><button type="submit">Se connecter</button></form></div>
<div id="creation" hidden><form class="card" onsubmit="creer(event)"><h3 style="margin-top:0">Créer le mot de passe</h3>
<div class="g">Premier accès à ce socle : choisissez l'utilisateur et le mot de passe de son interface. Sans eux, personne sur le réseau ne peut le régler ni lire son code d'appairage. Le mot de passe ne quitte pas ce navigateur.</div>
<label>Utilisateur</label><input class="w" id="nu" value="admin" autocomplete="username">
<label>Mot de passe (8 caractères au moins)</label><input class="w" id="nm" type="password" autocomplete="new-password">
<label>Le même, encore une fois</label><input class="w" id="nm2" type="password" autocomplete="new-password">
<div class="bad" id="nerr"></div><button type="submit">Créer et se connecter</button></form></div>
<div class="marque"><b>PAGE LOCALE</b>sans Internet</div><h1>Socle chauffant</h1><div class="sub" id="entete">…</div>
<div id="avertissements"></div>
<div class="tabs">
<button class="on" onclick="onglet('vue',this)">Vue</button>
<button onclick="onglet('reg',this)">Réglages</button>
<button onclick="onglet('res',this)">Réseau</button>
<button onclick="onglet('sta',this)">Appareil</button>
<button onclick="onglet('log',this)">Journal</button>
</div>
<div id="vue"><div id="zones"></div><div class="card"><canvas id="g" width="760" height="230"></canvas>
<div class="g" style="margin-top:7px">Trait plein : température · pointillés : consigne
<select id="duree" onchange="trace()"></select>
<a href="/api/history.csv">export CSV</a></div></div></div>
<div id="sta" style="display:none"><div class="card" id="stxt">…</div>
<div class="card" id="sante">…</div>
<div class="card"><h3 style="margin-top:0">Résumés journaliers</h3><div class="tbl" id="jours">…</div></div>
<div class="card"><h3 style="margin-top:0">Sauvegarde de la configuration</h3>
<div class="g">Zones, réglages, sondes liées et alertes : de quoi remplacer une carte en une minute. Ni le Wi-Fi
ni les mots de passe ne sont dans le fichier, mais l'URL d'alerte y est (une URL ntfy vaut un mot de passe).</div>
<button class="s" onclick="location.href='/api/sauvegarde'">Télécharger</button>
<label>Restaurer depuis un fichier</label><input class="w" type="file" id="fSauv" accept=".json,application/json">
<button class="s" onclick="restaurer()">Restaurer</button></div>
<div class="card"><div class="g">Couper le chauffage le temps d'une intervention, avec reprise automatique.</div>
<button onclick="post('/api/maintenance?minutes=10')">Entretien 10 min</button>
<button class="s" onclick="post('/api/maintenance?minutes=0')">Annuler</button></div>
<div class="card"><div class="g">Actions sur l'appareil.</div>
<button class="s" onclick="redemarrer()">Redémarrer</button>
<button class="s" onclick="deconnecter()">Se déconnecter</button>
<button class="danger" onclick="effacerHistorique()">Effacer l'historique</button></div></div>
<div id="reg" style="display:none"></div>
<div id="res" style="display:none"></div>
<div id="log" style="display:none"><div class="card"><pre id="jtxt">…</pre>
<button class="s" onclick="fetch('/api/journal',{method:'DELETE',headers:{'X-Terrarium':'1'}}).then(charge)">Effacer le journal</button></div></div>
<script>
// Couleurs des zones, celles de la feuille de style (clair ou sombre).
const C=['--z1','--z2'].map(v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim()||'#e0661c');let S=null;
// Une décimale, virgule française : « 30,6 ».
const fr=(v,d=1)=>Number(v).toFixed(d).replace('.',',');
// Toutes les requêtes portent X-Terrarium (preuve qu'elles viennent de cette
// page, et non d'un site tiers) ; un 401 ouvre le formulaire de connexion.
function F(u,o={}){return fetch(u,Object.assign({},o,{headers:Object.assign({'X-Terrarium':'1'},o.headers||{})})).then(r=>{if(r.status===401)connexion();else if(r.status===428)creation();return r;});}
// Lecture JSON : null si la requête est refusée (session absente, erreur).
async function J(u){const r=await F(u);return r.ok?r.json():null;}
function connexion(){const c=document.getElementById('connexion');if(c.hidden){c.hidden=false;document.getElementById('cu').focus();}}
// 428 : aucun mot de passe encore (premier accès) ; le socle ne sert rien d'autre.
function creation(){const c=document.getElementById('creation');if(c.hidden){c.hidden=false;document.getElementById('nm').focus();}}
// SHA-256 (chaîne UTF-8 → hexadécimal). WebCrypto n'existe pas en HTTP clair :
// on le fait à la main, c'est ce qui permet de ne jamais envoyer le mot de passe.
function sha256(t){const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
 let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
 const b=unescape(encodeURIComponent(t)),l=b.length,n=((l+9+63)>>6)<<6,m=new Uint8Array(n);
 for(let i=0;i<l;i++)m[i]=b.charCodeAt(i);m[l]=0x80;const v=new DataView(m.buffer);v.setUint32(n-4,(l*8)>>>0);v.setUint32(n-8,Math.floor(l/536870912));
 const w=new Uint32Array(64),R=(x,k)=>(x>>>k)|(x<<(32-k));
 for(let i=0;i<n;i+=64){for(let t=0;t<16;t++)w[t]=v.getUint32(i+t*4);
  for(let t=16;t<64;t++){const a=w[t-15],c=w[t-2];w[t]=(w[t-16]+(R(a,7)^R(a,18)^(a>>>3))+w[t-7]+(R(c,17)^R(c,19)^(c>>>10)))>>>0;}
  let[a,c,d,e,f,g,h,k]=H;
  for(let t=0;t<64;t++){const t1=(k+(R(f,6)^R(f,11)^R(f,25))+((f&g)^(~f&h))+K[t]+w[t])>>>0,t2=((R(a,2)^R(a,13)^R(a,22))+((a&c)^(a&d)^(c&d)))>>>0;k=h;h=g;g=f;f=(e+t1)>>>0;e=d;d=c;c=a;a=(t1+t2)>>>0;}
  H=[a,c,d,e,f,g,h,k].map((x,i)=>(H[i]+x)>>>0);}
 return H.map(x=>x.toString(16).padStart(8,'0')).join('');}
async function connecter(ev){ev.preventDefault();const err=document.getElementById('cerr');err.textContent='';
 const d=await(await fetch('/api/defi',{headers:{'X-Terrarium':'1'}})).json();
 if(d.libre){document.getElementById('connexion').hidden=true;creation();return;}
 const u=document.getElementById('cu').value||d.utilisateur,p=document.getElementById('cm').value;
 const preuve=sha256(d.defi+':'+sha256(u+':'+p));
 const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:'defi='+encodeURIComponent(d.defi)+'&preuve='+preuve});
 if(r.ok){document.getElementById('connexion').hidden=true;document.getElementById('cm').value='';maj();}
 else err.textContent=await r.text();}
async function creer(ev){ev.preventDefault();const err=document.getElementById('nerr');err.textContent='';
 const u=document.getElementById('nu').value.trim(),p=document.getElementById('nm').value;
 if(!u||u.length>16||u.includes(':')){err.textContent='Utilisateur : 1 à 16 caractères, sans « : ».';return;}
 if(p.length<8){err.textContent='Le mot de passe doit faire 8 caractères au moins.';return;}
 if(p!==document.getElementById('nm2').value){err.textContent='Les deux saisies diffèrent.';return;}
 const r=await fetch('/api/premier-acces',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:'utilisateur='+encodeURIComponent(u)+'&empreinte='+sha256(u+':'+p)});
 if(!r.ok){err.textContent=await r.text();return;}
 document.getElementById('creation').hidden=true;document.getElementById('nm').value=document.getElementById('nm2').value='';
 document.getElementById('cu').value=u;document.getElementById('cm').value=p;await connecter({preventDefault(){}});}
async function deconnecter(){await fetch('/api/deconnexion',{method:'POST',headers:{'X-Terrarium':'1'}});location.reload();}
function onglet(id,b){['vue','reg','res','sta','log'].forEach(x=>document.getElementById(x).style.display=x==id?'':'none');
document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));b.classList.add('on');
if(id=='log')charge();if(id=='sta')stats();}
async function stats(){
 const d=await J('/api/stats');if(!d)return;
 let h='<div class="g">Firmware '+esc(d.version)+' — compilé le '+esc(d.compile)+
  '<br>'+d.zonesSimultanees+' zone(s) peuvent chauffer en même temps'+
  (d.saison?' · décalage saisonnier '+d.saison.toFixed(1)+' °C':'')+
  (d.maintenanceRestanteS?' · <b>entretien : '+Math.ceil(d.maintenanceRestanteS/60)+' min restantes</b>':'')+'</div>';
 d.zones.forEach((z,i)=>{
  h+='<div class="zone'+(i?' z2':'')+'" style="margin-top:11px">'+esc(z.nom)+'</div><div class="g">';
  h+= z.points? 'Sur 24 h : min '+z.min.toFixed(1)+' °C · max '+z.max.toFixed(1)+' °C · moyenne '+
      z.moyenne.toFixed(1)+' °C · hors plage '+z.horsPlagePct+' % du temps<br>'
     :'Pas encore assez d\'historique.<br>';
  h+='Chauffe cumulée '+z.heuresChauffe.toFixed(1)+' h · '+z.kWh.toFixed(2)+' kWh'+(z.euros!==undefined?' · '+z.euros.toFixed(2)+' €':'')+'<br>';
  h+='Défauts : sonde '+z.defauts.sonde+' · surchauffe '+z.defauts.surchauffe+' · sonde figée '+z.defauts.figee+' · sans effet '+(z.defauts.inefficace||0);
  h+='</div>';});
 document.getElementById('stxt').innerHTML=h;sante();jours();}
// Santé du socle : signal, mémoire, dernier redémarrage, plantage éventuel.
function sante(){
 const s=S&&S.sante;const el=document.getElementById('sante');
 if(!s){el.innerHTML='<div class="g">Santé indisponible.</div>';return;}
 const q=s.rssi>=-60?'excellent':s.rssi>=-70?'bon':s.rssi>=-80?'faible':'très faible';
 let h='<h3 style="margin-top:0">Santé du socle</h3><div class="stat">'+
  '<div><b>'+(s.rssi?q+' · '+s.rssi+' dBm':'—')+'</b><span>signal Wi-Fi</span></div>'+
  '<div><b>'+Math.round(s.heap/1024)+' Ko</b><span>mémoire libre · min '+Math.round(s.heapMin/1024)+' Ko · bloc '+Math.round(s.blocMax/1024)+' Ko</span></div>'+
  '<div><b>'+Math.floor(s.uptime/3600)+' h</b><span>de service</span></div>'+
  '<div><b>'+esc(s.reset)+'</b><span>dernier redémarrage</span></div>'+
  (s.courantA!==undefined?'<div><b>'+s.courantA.toFixed(2)+' A</b><span>courant mesuré · '+(s.energieWh/1000).toFixed(3)+' kWh réels'+(s.anomalieCourant?' · <span class="bad">'+esc(s.anomalieCourant)+'</span>':'')+'</span></div>':'')+
  '</div>';
 if(s.otaEnAttente)h+='<div class="g" style="margin-top:8px"><span class="pill warn">mise à jour en cours de validation</span> — elle sera confirmée après 90 s sans plantage, sinon le socle revient à la version précédente.</div>';
 if(s.maj){const m=s.maj,cl=m.etape==='echec'||m.etape==='retour arriere'?'bad':m.etape==='validee'?'ok':'warn';
  h+='<div class="g" style="margin-top:8px">Dernière mise à jour : <span class="pill '+cl+'">'+esc(m.etape)+'</span> '+esc(m.version)+' — '+esc(m.detail)+'</div>';}
 h+='<div class="g" style="margin-top:8px">Interface locale : <code>http://'+esc(s.hote||'')+'/</code>'+(s.ip?' ou <code>http://'+esc(s.ip)+'/</code>':'')+'</div>';
 if(s.mqtt)h+='<div class="g" style="margin-top:8px">MQTT : <span class="pill '+(s.mqtt==='connecte'?'ok':s.mqtt==='desactive'?'':'warn')+'">'+esc(s.mqtt)+'</span></div>';
 h+='<div class="g" style="margin-top:8px">Images de mise à jour signées : '+(s.signatureOta?'<b>exigées</b>':'non exigées')+' · protocole '+s.proto+'</div>';
 if(s.plantage)h+='<div class="avert" style="margin-top:10px"><b>Dernier plantage :</b> '+esc(s.plantage)+
  '<br><a href="/api/coredump">Télécharger le coredump</a> · <a href="#" onclick="effacerCoredump();return false">effacer</a></div>';
 el.innerHTML=h;}
async function effacerCoredump(){if(!confirm('Effacer le coredump enregistré ?'))return;await supprimer('/api/coredump');}
const esc=s=>String(s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
async function maj(){
 const r=await F('/api/status');if(!r.ok)return;S=await r.json();
 document.getElementById('connexion').hidden=true;
 document.getElementById('entete').innerHTML=
  `<span class="pill">${esc(S.heure)}</span><span class="pill${S.tapisActif<0?'':' ok'}">${S.tapisActif<0?'aucun tapis':'tapis '+(S.tapisActif+1)+' allumé'}</span>`+
  `<span class="pill">${Math.floor(S.uptime/3600)} h de service</span>`+
  (S.maintenanceS?`<span class="pill warn">entretien : ${Math.ceil(S.maintenanceS/60)} min</span>`:'')+
  (S.alertesEnAttente?`<span class="pill warn">${S.alertesEnAttente} alerte(s) en attente</span>`:'')+
  (S.sante&&S.sante.otaEnAttente?`<span class="pill warn">mise à jour à valider</span>`:'')+
  `<span class="pill">v${esc(S.version||'?')}</span>`;
 document.getElementById('zones').innerHTML=S.zones.map((z,i)=>
  `<div class="card"><div class="zone${i?' z2':''}">${esc(z.nom)}${z.autotune?' · AUTOTUNE':''}</div>
   <div class="big">${z.defaut?'—':fr(z.temp)+'°'}</div>
   ${z.defaut?`<div class="bad">DÉFAUT : ${esc(z.defaut)}</div><button onclick="post('/api/reset')">Lever</button>`
    :`<div class="et${z.chauffe?' ch':''}${i?' z2':''}">${z.chauffe?'CHAUFFE':'Au repos'} · cible ${fr(z.consigne)}°</div>
      <div class="g">demande ${z.demande} % · charge ${z.duty} %${z.derive?' · <span class="warn">dérive</span>':''}${z.tropChaud?' · <span class="warn">trop chaud</span>':''}</div>`}
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
 if(S.sante&&S.sante.webProtege===false)av.push(`<b>Interface locale sans mot de passe.</b> Tout appareil de ton réseau Wi-Fi peut
   changer les consignes. Définis un utilisateur et un mot de passe dans l'onglet Réseau.`);
 if(S.sante&&S.sante.plantage)av.push(`<b>Le socle a redémarré après un plantage.</b> Le résumé est dans l'onglet Appareil, le fichier complet est téléchargeable : joins-le à un rapport de bogue.`);
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
  `<div class="card"><div class="zone${i?' z2':''}">${esc(z.nom)}</div>
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
  +`<div class="card"><h3 style="margin-top:0">Sondes</h3>
    <div class="g">Chaque zone suit l'adresse de sa sonde. Pour savoir laquelle est laquelle : « Identifier »,
     puis serrer la sonde voulue dans la main.</div><div id="sondes">…</div>
    <button class="s" onclick="scan(1)">Relire le bus</button>
    <button class="s" onclick="calibrer()">Calibrer (sondes côte à côte)</button></div>
    <div class="card"><h3 style="margin-top:0">Essai de chauffe</h3>
    <div class="g">Mise en service d'un tapis : la zone chauffe seule, 10 min au plus, et l'essai dit si c'est
     bien sa sonde qui monte. Sécurités actives.</div><div id="essai">…</div>
    ${S.zones.map((z,i)=>`<button class="s" onclick="essai(${i})">Essai ${esc(z.nom)}</button>`).join('')}
    <button class="danger" onclick="arreterEssai()">Arrêter l'essai</button></div>
    <div class="card"><h3 style="margin-top:0">Réglages généraux</h3>
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
     <div><label>Écran la nuit</label><select id="gEN"><option value="0">atténué</option><option value="1">normal</option><option value="2">éteint</option></select></div>
     <div><label>LED de la carte</label><select id="gL"><option value="0">allumée</option><option value="1">éteinte</option></select></div>
    </div>
    <h3>Rapport quotidien et coût</h3>
    <div class="g">Un résumé par jour (températures, chauffe, kWh, euros, défauts) vers l'URL d'alerte et le sujet MQTT « rapport ».</div>
    <div class="row">
     <div><label>Rapport</label><select id="gRA"><option value="0">non</option><option value="1">oui</option></select></div>
     <div><label>Heure (HH:MM)</label><input id="gRH"></div>
     <div><label>Prix du kWh (€)</label><input id="gP"></div>
    </div>
    <button class="s" onclick="voirRapport()">Voir le rapport</button>
    <button class="s" onclick="post('/api/rapport')">Envoyer maintenant</button>
    <pre id="rapport" hidden></pre>
    <h3>Jour et nuit calés sur le soleil</h3>
    <div class="g">Les horaires suivent le lever et le coucher du soleil au lieu des heures fixes de chaque zone.
     Deux décimales de latitude et de longitude suffisent.</div>
    <div class="row">
     <div><label>Actif</label><select id="gSo"><option value="0">non</option><option value="1">oui</option></select></div>
     <div><label>Latitude</label><input id="gLa"></div>
     <div><label>Longitude</label><input id="gLo"></div>
     <div><label>Décalage (min)</label><input id="gSM"></div>
    </div>
    <div class="g" id="gEtatSoleil" style="margin-top:6px"></div>
    <h3>Priorité</h3>
    <div class="g">Quand l'alimentation ne suffit pas aux deux tapis à la fois, la zone prioritaire reçoit la plus grande part du temps de chauffe.</div>
    <div class="row"><div><label>Zone prioritaire</label><select id="gZP"><option value="0">aucune</option>${S.zones.map((z,i)=>`<option value="${i+1}">${esc(z.nom)}</option>`).join('')}</select></div></div>
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
   <label>Réseau de secours (SSID, vide = aucun)</label><input class="w" id="ssid2">
   <label>Mot de passe du réseau de secours (vide = inchangé)</label><input class="w" id="wpass2" type="password">
   <div class="g">Essayé en alternance quand le premier ne répond pas (box en panne, répéteur…).</div>
   <label>Utilisateur de cette interface (ne change qu'avec un nouveau mot de passe)</label><input class="w" id="wu">
   <label>Mot de passe de cette interface (vide = inchangé)</label><input class="w" id="wp" type="password">
   <label>Mot de passe OTA (vide = inchangé)</label><input class="w" id="op" type="password">
   <label>Mot de passe du point d'accès de secours (8 car. min, vide = inchangé)</label><input class="w" id="ap" type="password">
   <h3>Alertes et surveillance</h3>
   <label>URL d'alerte (https accepté)</label><input class="w" id="ua">
   <label>Format des alertes</label><select id="fa"><option value="0">JSON (serveur, domotique)</option><option value="1">texte lisible (ntfy, notification sur le téléphone)</option></select>
   <div class="g">Texte : le socle envoie « [zone] message » avec un titre et une priorité, ce que ntfy affiche tel quel sur le téléphone. Détails dans docs/alertes-telephone.md.</div>
   <label>Jeton envoyé avec les alertes (« Authorization: Bearer », vide = inchangé)</label><input class="w" id="aj" type="password">
   <label>URL de heartbeat (GET périodique — healthchecks.io prévient quand le socle se tait)</label><input class="w" id="uh">
   <label>Période de heartbeat (min)</label><input id="hm">
   <h3>MQTT</h3>
   <label>Serveur MQTT (vide = désactivé)</label><input class="w" id="mh">
   <div class="row"><div><label>Port</label><input id="mp"></div>
   <div><label>Préfixe</label><input id="mx"></div></div>
   <label>Utilisateur MQTT</label><input class="w" id="mu">
   <label>Mot de passe MQTT (vide = inchangé)</label><input class="w" id="mw" type="password">
   <label>MQTT chiffré (TLS)</label><select id="mt"><option value="1">oui</option><option value="0">non</option></select>
   <label>Vérifier les certificats</label><select id="vt"><option value="1">oui</option><option value="0">non</option></select>
   <label>Découverte Home Assistant</label><select id="ha"><option value="1">activée</option><option value="0">désactivée</option></select>
   <h3>Heure</h3>
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
   <div class="card"><h3 style="margin-top:0">Mise à jour du firmware</h3>
   <div class="g">Envoie le fichier <code>.ino.bin</code> produit par « Croquis → Exporter les binaires »
   (ou le fichier signé de la release). Le chauffage est coupé pendant l'écriture, et l'appareil
   redémarre ensuite. Ne coupe pas l'alimentation. <span id="sig"></span></div>
   <input class="w" type="file" id="binaire" accept=".bin">
   <progress id="progMaj" value="0" max="100" hidden></progress>
   <div class="g" id="etatMaj"></div>
   <button onclick="envoyerMaj()">Téléverser et redémarrer</button>
   <h3>Mise à jour depuis GitHub</h3>
   <div class="g">Le socle télécharge lui-même l'image de la release (HTTPS, signature vérifiée si exigée),
   l'installe et redémarre ; elle n'est validée qu'après 90 s de fonctionnement, sinon il revient
   à cette version. Version actuelle : <b id="vact">?</b>.</div>
   <label>Version à installer (X.Y.Z) ou URL https</label><input class="w" id="majCible" placeholder="3.4.1">
   <button onclick="majDistante()">Télécharger et installer</button></div>`;
 chargeRes();
 chargeGlobaux();
 scan();
 etatEssai();
}
async function chargeGlobaux(){
 const g=await J('/api/globaux');if(!g)return;
 for(const [k,v] of Object.entries({gA:g.courantAlimA,gW:g.puissanceTapisW,gV:g.tensionV,
  gE:g.maintenanceMin,gS:g.ecranVeilleMin,gSD:g.saisonDelta,gS1:g.saisonDescenteJ,
  gS2:g.saisonPlateauJ,gS3:g.saisonRemonteeJ,gRH:hm(g.rapportMinutes),gP:g.prixKwh||'',gEN:g.ecranNuit,
  gL:g.ledEteinte?'1':'0',gRA:g.rapportActif?'1':'0',gSo:g.soleilActif?'1':'0',gZP:g.zonePrioritaire,
  gLa:g.latitude||g.longitude?g.latitude:'',gLo:g.latitude||g.longitude?g.longitude:'',gSM:g.soleilDecalageMin})) {const el=document.getElementById(k);if(el)el.value=v;}
 document.getElementById('gSA').value=g.saisonActive?'1':'0';
 document.getElementById('gEtatSoleil').textContent=g.soleilJour!==undefined
  ?'Aujourd\'hui : jour à '+hm(g.soleilJour)+', nuit à '+hm(g.soleilNuit)+'.'
  :g.soleilActif?'Enregistré : appliqué dès que l\'heure sera connue.':'Horaires fixes de chaque zone.';
 document.getElementById('gZones').textContent=
  g.zonesSimultanees+' zone(s) peuvent chauffer en même temps avec cette alimentation.';
 document.getElementById('gEtatSaison').textContent=
  g.saisonActive?('Cycle en cours · décalage appliqué : '+g.decalageActuel.toFixed(2)+' °C')
   :(g.heureFiable?'Cycle inactif.':'Cycle inactif — et l\'heure est inconnue, il ne peut pas démarrer.');}
async function envoyerGlobaux(redemarrerCycle){
 // Virgule décimale acceptée : « 0,25 » ne doit pas devenir 0.
 const v=id=>encodeURIComponent(document.getElementById(id).value.trim().replace(',','.'));
 let q=`courantAlimA=${v('gA')}&puissanceTapisW=${v('gW')}&tensionV=${v('gV')}`
  +`&maintenanceMin=${v('gE')}&ecranVeilleMin=${v('gS')}&saisonActive=${v('gSA')}`
  +`&saisonDelta=${v('gSD')}&saisonDescenteJ=${v('gS1')}&saisonPlateauJ=${v('gS2')}&saisonRemonteeJ=${v('gS3')}`
  +`&rapportActif=${v('gRA')}&rapportHeure=${v('gRH')}&prixKwh=${v('gP')}&ledEteinte=${v('gL')}&ecranNuit=${v('gEN')}`
  +`&soleilActif=${v('gSo')}&latitude=${v('gLa')}&longitude=${v('gLo')}&soleilDecalageMin=${v('gSM')}&zonePrioritaire=${v('gZP')}`;
 if(redemarrerCycle)q+='&saisonRedemarrer=1';
 const r=await F('/api/globaux',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:q});
 alert(await r.text());chargeGlobaux();maj();}
async function chargeRes(){const c=await J('/api/reseau');if(!c)return;
 for(const [k,v] of Object.entries({ssid:c.ssid,ssid2:c.ssid2||'',wu:c.webUtilisateur,ua:c.urlAlertes,uh:c.urlHeartbeat,
  hm:c.heartbeatMinutes,mh:c.mqttHote,mp:c.mqttPort,mx:c.mqttPrefixe,mu:c.mqttUtilisateur,tz:c.fuseau,ntp:c.ntp}))
  document.getElementById(k).value=v;
 document.getElementById('ha').value=c.decouverteHA?'1':'0';
 document.getElementById('mt').value=c.mqttTls?'1':'0';
 document.getElementById('vt').value=c.verifierTls?'1':'0';
 document.getElementById('fa').value=c.formatAlertes?'1':'0';
 document.getElementById('sig').textContent=c.signatureOta?'Ce socle n\'accepte que des images signées.':'';
 document.getElementById('vact').textContent=(S&&S.version)||'?';
 document.getElementById('jet').textContent=c.jeton||'—';
 document.getElementById('app').textContent=c.appareil||'—';}
const H={'X-Terrarium':'1'};
async function post(u){const r=await F(u,{method:'POST',headers:H});alert(await r.text());maj();}
async function supprimer(u){const r=await F(u,{method:'DELETE',headers:H});alert(await r.text());maj();}
async function effacerHistorique(){
 if(!confirm('Effacer tout l\'historique ? Les courbes repartent de zéro.'))return;
 await supprimer('/api/history');trace();}
async function redemarrer(){
 if(!confirm('Redémarrer le socle ? Le chauffage est coupé une quinzaine de secondes.'))return;
 await post('/api/redemarrer');}
async function effacerJetonAlerte(){
 if(!confirm('Retirer le jeton envoyé avec les alertes ?'))return;
 const r=await F('/api/reseau',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:'alerteJetonVide=1'});
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
async function majDistante(){
 const c=document.getElementById('majCible').value.trim();
 if(!c){alert('Indique une version (3.4.1) ou une URL https.');return;}
 if(!confirm('Télécharger et installer « '+c+' » ? Le chauffage est coupé pendant l\'écriture, le socle redémarre ensuite.'))return;
 const r=await F('/api/maj-distante',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},
  body:(c.startsWith('https://')?'url=':'version=')+encodeURIComponent(c)});
 document.getElementById('etatMaj').textContent=await r.text();
 if(r.status===200)setTimeout(()=>location.reload(),60000);}
const hm=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
const noms=()=>S?S.zones.map(z=>z.nom):['Zone 1','Zone 2'];
let tIdent=0,tEssai=0;
// Sondes : la liaison de chaque zone (et si sa sonde est là), puis le bus.
async function scan(relire){
 const d=await J('/api/sondes'+(relire?'?relire=1':''));const el=document.getElementById('sondes');if(!d||!el)return;
 let h='';
 (d.liaisons||[]).forEach((l,z)=>{h+='<div class="g" style="margin:6px 0"><b>'+esc(noms()[z])+'</b> : '+
  (l?esc(l.rom)+(l.presente?'':' <span class="bad">absente du bus</span>'):'<span class="warn">aucune sonde liée</span>')+
  ' <button class="s" onclick="identifier('+z+')">Identifier</button></div>';});
 h+='<h3>Sur le bus</h3>';
 d.sondes.forEach(s=>{
  h+='<div class="g" style="margin:6px 0">'+esc(s.rom)+' — '+(s.temp===null?'--':s.temp.toFixed(2)+' °C')+' '+
     (s.zone>=0?'(zone '+(s.zone+1)+')':'(libre)');
  noms().forEach((n,z)=>{if(s.zone!==z)h+=' <button class="s" onclick="lier(\''+esc(s.rom)+'\','+z+')">vers '+esc(n)+'</button>';});
  h+='</div>';});
 if(!d.sondes.length)h+='<div class="g">Aucune sonde détectée : câblage, résistance de 4,7 kΩ ?</div>';
 if(d.identification)h+='<div class="avert" style="margin-top:8px">Zone '+d.identification.zone+' : serre la sonde voulue dans la main ('+
  d.identification.restantS+' s). Chauffage suspendu. <a href="#" onclick="annulerIdent();return false">Annuler</a></div>';
 else if(d.resultat)h+='<div class="g" style="margin-top:8px">'+esc(d.resultat)+'</div>';
 el.innerHTML=h;
 clearTimeout(tIdent);if(d.identification)tIdent=setTimeout(scan,3000);}
async function identifier(z){
 if(!confirm('Identifier la sonde de « '+noms()[z]+' » ? Le chauffage est suspendu 2 min au plus : serre ensuite la sonde voulue dans la main.'))return;
 const r=await F('/api/identifier?z='+z,{method:'POST',headers:H});if(!r.ok)alert(await r.text());scan();}
async function annulerIdent(){await F('/api/identifier',{method:'DELETE',headers:H});scan();}
async function calibrer(){
 if(!confirm('Les sondes sont-elles côte à côte depuis quelques minutes ? Leurs calibrations seront alignées sur la zone 1.'))return;
 const r=await F('/api/calibrer',{method:'POST',headers:H});alert(await r.text());
 // Le champ « Calibration » doit montrer la nouvelle valeur : l'enregistrer tel
 // quel ensuite effacerait la calibration.
 await maj();if(S)S.zones.forEach((z,i)=>{const o=document.getElementById('o'+i);if(o)o.value=z.offset;});}
async function etatEssai(){
 const e=await J('/api/essai');const el=document.getElementById('essai');if(!e||!el)return;
 el.innerHTML=e.zone?'<div class="avert" style="margin-top:8px">Essai en cours sur « '+esc(noms()[e.zone-1])+' » : '+Math.ceil(e.restantS/60)+' min au plus.</div>'
  :'<div class="g" style="margin-top:8px">'+(e.resultat?esc(e.resultat):'Aucun essai depuis le démarrage.')+'</div>';
 clearTimeout(tEssai);if(e.zone)tEssai=setTimeout(etatEssai,5000);}
async function essai(z){
 if(!confirm('Essai de chauffe sur « '+noms()[z]+' » : 10 min au plus, l\'autre zone attend. Lancer ?'))return;
 const r=await F('/api/essai?z='+z,{method:'POST',headers:H});if(!r.ok)alert(await r.text());etatEssai();}
async function arreterEssai(){await F('/api/essai',{method:'DELETE',headers:H});etatEssai();}
async function voirRapport(){const r=await F('/api/rapport');const p=document.getElementById('rapport');
 p.hidden=false;p.textContent=r.ok?await r.text():'Rapport indisponible.';}
// Résumés journaliers : un an au plus en flash, le dernier mois ici.
async function jours(){
 const d=await J('/api/jours?n=31');const el=document.getElementById('jours');if(!d||!el||!d.jours)return;
 if(!d.jours.length){el.innerHTML='<div class="g">Le premier résumé s\'écrit à minuit, une fois l\'heure connue.</div>';return;}
 const f=(v,n)=>v===null||v===undefined?'—':v.toFixed(n);
 let h='<table><tr><th>Jour</th>'+noms().map(n=>'<th>'+esc(n)+'</th>').join('')+'</tr>';
 d.jours.forEach(j=>{h+='<tr><td>'+esc(j.date)+'</td>'+j.zones.map(z=>'<td>'+f(z.min,1)+' à '+f(z.max,1)+' °C<br>'+
  f(z.heures,1)+' h · '+f(z.kWh,2)+' kWh'+(d.prixKwh>0&&z.euros!==null?' · '+z.euros.toFixed(2)+' €':'')+
  (z.defauts?' · <span class="bad">'+z.defauts+' défaut(s)</span>':'')+'</td>').join('')+'</tr>';});
 el.innerHTML=h+'</table>';}
async function restaurer(){
 const f=document.getElementById('fSauv').files[0];if(!f){alert('Choisis d\'abord un fichier de sauvegarde.');return;}
 if(!confirm('Remplacer la configuration de ce socle par celle de '+f.name+' ?'))return;
 const r=await F('/api/sauvegarde',{method:'POST',headers:{'Content-Type':'application/json'},body:await f.text()});
 alert(await r.text());if(r.ok)location.reload();}
async function lier(rom,z){const r=await F('/api/sondes?rom='+rom+'&z='+z,{method:'POST',headers:H});alert(await r.text());scan();}
async function envoyer(i){
 const v=id=>encodeURIComponent(document.getElementById(id+i).value);
 const q=`z=${i}&nom=${v('nom')}&jour=${v('j')}&nuit=${v('n')}&bande=${v('b')}&ki=${v('k')}&max=${v('m')}`+
   `&offset=${v('o')}&debutJour=${v('H')}&debutNuit=${v('N')}&rampe=${v('R')}&inefficaceMin=${v('I')}`+
   `&inefficaceDelta=${v('D')}&deriveSeuil=${v('d')}&deriveMin=${v('E')}`+
   `&chuteSeuil=${v('C')}&chuteSecondes=${v('F')}`;
 const r=await F('/api/config',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:q});
 alert(await r.text());maj();}
async function envoyerRes(){
 const v=id=>encodeURIComponent(document.getElementById(id).value);
 const q=`ssid=${v('ssid')}&wifiPass=${v('wpass')}&ssid2=${v('ssid2')}&wifiPass2=${v('wpass2')}&webUser=${v('wu')}&webPass=${v('wp')}&otaPass=${v('op')}&apPass=${v('ap')}`+
  `&urlAlertes=${v('ua')}&formatAlertes=${v('fa')}&alerteJeton=${v('aj')}&urlHeartbeat=${v('uh')}&heartbeatMin=${v('hm')}&mqttHote=${v('mh')}&mqttPort=${v('mp')}`+
  `&mqttPrefixe=${v('mx')}&mqttUser=${v('mu')}&mqttPass=${v('mw')}&ha=${v('ha')}&mqttTls=${v('mt')}&verifierTls=${v('vt')}&fuseau=${v('tz')}&ntp=${v('ntp')}`;
 if(!confirm("Enregistrer et redémarrer ? Le chauffage est coupé pendant le redémarrage."))return;
 const r=await F('/api/reseau',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Terrarium':'1'},body:q});
 alert(await r.text());}
async function charge(){const r=await F('/api/journal');if(r.ok)document.getElementById('jtxt').textContent=await r.text();}
async function trace(){
 const h=await J('/api/history?heures='+document.getElementById('duree').value);if(!h)return;
 dessiner(h.points);}
function dessiner(p){
 const c=document.getElementById('g'),x=c.getContext('2d');
 const sombre=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
 x.clearRect(0,0,c.width,c.height);if(!p.length)return;
 let lo=99,hi=-99;
 p.forEach(q=>[q.t0,q.t1,q.c0,q.c1].forEach(v=>{if(v>-300){lo=Math.min(lo,v);hi=Math.max(hi,v)}}));
 if(hi<lo){return}lo-=1;hi+=1;
 const t0=p[0].e,t1=p[p.length-1].e||t0+1;
 const X=e=>(e-t0)/Math.max(1,t1-t0)*(c.width-4)+2,Y=v=>c.height-14-(v-lo)/(hi-lo)*(c.height-24);
 // Memorise pour le survol et le glisser-zoomer : sans cette ligne, PTS restait
 // nul et les deux fonctionnalites ne faisaient rien du tout.
 PTS=p;GX=X;GY=Y;GLO=lo;GHI=hi;
 x.strokeStyle=sombre?'#2a2f38':'#e4e8ed';x.lineWidth=1;x.beginPath();
 for(let k=0;k<=4;k++){const y=Y(lo+(hi-lo)*k/4);x.moveTo(0,y);x.lineTo(c.width,y)}x.stroke();
 x.fillStyle=sombre?'#8d96a3':'#5f6975';x.font='10px sans-serif';
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

#endif  // PAGE_WEB_H
