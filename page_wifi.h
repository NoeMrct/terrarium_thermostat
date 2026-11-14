/* page_wifi.h — page du portail captif : choisir le Wi-Fi de la maison.
   Servie à la racine tant que le socle est en point d'accès : c'est elle que le
   téléphone ouvre tout seul en rejoignant « terrarium-config-… ». Elle ne lit
   rien du socle hors la liste des réseaux alentour ; l'interface complète reste
   derrière son mot de passe, à /interface.
   Les noms de réseaux viennent du voisinage : ils ne passent jamais par
   innerHTML, seulement par textContent.
   Après toute modification : node outils/compresser-page.js (régénère
   page_wifi_gz.h). */
#ifndef PAGE_WIFI_H
#define PAGE_WIFI_H

#include <Arduino.h>

static const char PAGE_WIFI[] PROGMEM = R"HTML(<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Socle chauffant — Wi-Fi</title><style>
:root{color-scheme:light dark;--f:#fff;--k:#efefec;--l:#e6e6e3;--t:#121315;--g:#5f6368;--a:#121315;--at:#fff;--ok:#17683f;--okd:#e8f3ed;--d:#b42318;--dd:#fbedeb;--c:#8a8d92}
@media(prefers-color-scheme:dark){:root{--f:#0d0e10;--k:#232428;--l:#2a2b30;--t:#f2f2f0;--g:#a7abb0;--a:#f2f2f0;--at:#121315;--ok:#3ccf8e;--okd:#173327;--d:#f97066;--dd:#3a1d1d;--c:#5c6066}}
body{margin:0 auto;max-width:520px;padding:18px 20px 32px;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--f);color:var(--t)}
h1{font-size:28px;font-weight:500;letter-spacing:-.02em;line-height:1.15;margin:6px 0 8px}
p{margin:0 0 10px}.g{color:var(--g)}.s{font-size:13px}
ul{list-style:none;margin:14px -20px 0;padding:0;border-bottom:1px solid var(--l)}
li>button{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:0 20px;border:0;border-top:1px solid var(--l);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
li>button[aria-pressed=true]{font-weight:600;background:var(--k)}li.vide{padding:14px 20px;border-top:1px solid var(--l);color:var(--g);font-size:14px}
.n{flex:1;min-width:0;overflow-wrap:anywhere}.b{display:inline-flex;gap:2px;align-items:flex-end;height:15px}.b i{width:3px;border-radius:1px;background:var(--l)}.b i.on{background:var(--t)}
svg{width:16px;height:16px;fill:none;stroke:var(--g);stroke-width:1.8}
label{display:block;margin:18px 0 6px;font-size:13px;font-weight:500;color:var(--g)}
input{box-sizing:border-box;width:100%;min-height:52px;padding:0 14px;border:1px solid var(--c);border-radius:12px;background:var(--f);color:var(--t);font:inherit;font-size:17px}
input:focus-visible,button:focus-visible{outline:3px solid #2f6fdb;outline-offset:2px}
.v{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:14px;color:var(--g)}.v input{width:20px;min-height:20px;margin:0}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:54px;margin-top:18px;border:0;border-radius:28px;background:var(--a);color:var(--at);font:inherit;font-weight:500;cursor:pointer}
.btn:disabled{opacity:.55}.sec{background:var(--k);color:var(--t);margin-top:10px;min-height:48px}
.msg{margin-top:16px;padding:12px 14px;border-radius:14px;background:var(--k)}.msg.ok{background:var(--okd);color:var(--ok)}.msg.ko{background:var(--dd);color:var(--d)}
a{color:inherit}[hidden]{display:none!important}
</style></head><body>
<p class="g s">Socle chauffant · <span id="id">…</span></p>
<h1>Choisis le Wi-Fi de la maison</h1>
<p class="g">Le socle s’y connectera tout seul. Il ne voit que les réseaux en 2,4 GHz.</p>
<ul id="liste" aria-label="Réseaux trouvés par le socle" aria-busy="true"><li class="vide">Recherche des réseaux…</li></ul>
<button type="button" class="btn sec" id="actualiser">Actualiser la liste</button>
<form id="f" novalidate>
<label for="ssid">Nom du réseau</label><input id="ssid" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32">
<label for="mdp">Mot de passe du Wi-Fi</label><input id="mdp" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="63">
<label class="v"><input type="checkbox" id="voir"> Afficher le mot de passe</label>
<button class="btn" id="go">Connecter le socle</button>
</form>
<div id="msg" class="msg" role="status" aria-live="polite" hidden></div>
<p class="g s" style="margin-top:28px"><a href="/interface">Ouvrir l’interface complète du socle</a> : réglages, sans Internet. Son mot de passe est sur l’étiquette.</p>
<script>
const $=s=>document.querySelector(s),H={'X-Terrarium':'1'};let choix='';
function msg(t,c){const m=$('#msg');m.textContent=t;m.className='msg '+(c||'');m.hidden=!t;}
function barres(r){const n=r>=-60?4:r>=-70?3:r>=-80?2:1,s=document.createElement('span');s.className='b';s.setAttribute('role','img');
 s.setAttribute('aria-label','Signal '+['','faible','moyen','bon','excellent'][n]+', '+String(r).replace('-','−')+' dBm');
 for(let i=1;i<=4;i++){const b=document.createElement('i');b.className=i<=n?'on':'';b.style.height=(3+3*i)+'px';s.appendChild(b);}return s;}
function choisir(nom){choix=nom;$('#ssid').value=nom;document.querySelectorAll('#liste button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.ssid===nom)));$('#mdp').focus();}
async function lister(nouveau){
 const l=$('#liste');l.setAttribute('aria-busy','true');
 try{const d=await(await fetch('/api/wifi/reseaux'+(nouveau?'?nouveau=1':''),{headers:H})).json();
  if(d.enCours){setTimeout(lister,1500);return;}
  l.textContent='';l.setAttribute('aria-busy','false');
  if(!d.reseaux.length){const v=document.createElement('li');v.className='vide';v.textContent='Aucun réseau trouvé. Rapproche le socle de la box, ou saisis le nom du réseau ci-dessous.';l.appendChild(v);}
  d.reseaux.forEach(x=>{const li=document.createElement('li'),b=document.createElement('button'),n=document.createElement('span');
   b.type='button';b.dataset.ssid=x.ssid;b.setAttribute('aria-pressed',String(x.ssid===choix));n.className='n';n.textContent=x.ssid;b.appendChild(n);
   if(x.securise)b.insertAdjacentHTML('beforeend','<svg viewBox="0 0 24 24" aria-label="protégé par mot de passe" role="img"><rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>');
   b.appendChild(barres(x.rssi));b.onclick=()=>choisir(x.ssid);li.appendChild(b);l.appendChild(li);});
 }catch(e){setTimeout(lister,3000);}}
const RAISONS={mdp:s=>'La box a refusé le mot de passe de « '+s+' ». Vérifie-le, majuscules comprises.',
 introuvable:s=>'Le socle ne trouve pas « '+s+' ». Il ne voit que les réseaux en 2,4 GHz : si ta box sépare les bandes, choisis celle en 2,4 GHz.',
 delai:s=>'« '+s+' » ne répond pas. Rapproche le socle de la box le temps de l’installer, puis réessaie.'};
async function suivre(){
 try{const d=await(await fetch('/api/wifi/etat',{headers:H})).json();
  if(d.etat==='connecte'){$('#f').hidden=true;$('#liste').hidden=true;$('#actualiser').hidden=true;
   msg('C’est fait : le socle a rejoint « '+d.ssid+' » ('+String(d.rssi).replace('-','−')+' dBm). Il redémarre et rejoint ton serveur. Repasse le téléphone sur ton Wi-Fi et retourne dans l’application : la suite s’y fait toute seule.','ok');return;}
  if(d.etat==='echec'){msg((RAISONS[d.erreur]||(s=>'Le socle n’a pas pu rejoindre « '+s+' ». Réessaie.'))(d.ssid),'ko');$('#go').disabled=false;return;}
 }catch(e){/* le téléphone a pu perdre le point d’accès un instant : il y revient */}
 setTimeout(suivre,1500);}
async function connecter(ev){ev.preventDefault();const ssid=$('#ssid').value.trim(),mdp=$('#mdp').value;
 if(!ssid){msg('Choisis un réseau dans la liste, ou saisis son nom.','ko');return;}
 if(mdp&&mdp.length<8){msg('Un mot de passe Wi-Fi fait au moins 8 caractères.','ko');return;}
 $('#go').disabled=true;msg('Connexion à « '+ssid+' »…');
 try{const r=await fetch('/api/wifi',{method:'POST',headers:Object.assign({'Content-Type':'application/x-www-form-urlencoded'},H),body:new URLSearchParams({ssid,mdp}).toString()});
  if(!r.ok){const d=await r.json().catch(()=>({}));msg(d.erreur||'Refusé par le socle.','ko');$('#go').disabled=false;return;}}
 catch(e){/* réponse perdue : le suivi dira où en est le socle */}
 setTimeout(suivre,1500);}
$('#f').onsubmit=connecter;$('#actualiser').onclick=()=>lister(true);$('#voir').onchange=e=>{$('#mdp').type=e.target.checked?'text':'password';};
fetch('/api/wifi/etat',{headers:H}).then(r=>r.json()).then(d=>{$('#id').textContent=d.id||'';if(d.etat==='connecte'||d.etat==='essai')suivre();}).catch(()=>{});
lister();
</script></body></html>)HTML";

#endif  // PAGE_WIFI_H
