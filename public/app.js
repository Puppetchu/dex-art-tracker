(function(){
var RO=!!window.DEX_READONLY, HIDEV=!!window.DEX_HIDE_VALUE, LOGIN=!!window.DEX_LOGIN, AUTH=!!window.DEX_AUTH;
var ADMINPATH=!!window.DEX_ADMINPATH; // the /admin/ address: the admin logs in here, trainers on the normal address
var CFG=window.DEX_CFG||{dex:null,accounts:[],me:null};
var DEX=CFG.dex, ME=CFG.me, ADMIN=!!(ME&&ME.admin);
function accName(id){ for(var i=0;i<CFG.accounts.length;i++) if(CFG.accounts[i].id===id) return CFG.accounts[i].name; return id; }
var DEXNAME=DEX?accName(DEX):'Nobody';
if(!ADMIN) document.body.classList.add('no-admin');
// The admin has no dex: it looks at every dex as a visitor would, with the admin tools and the settings page.
// Inside the Android app (it adds "DexArtApp" to every request) the page is one trainer's dex only:
// a closed Pokédex to log in, no switching to other dexes. The web page itself is unchanged.
var APP=/\bDexArtApp\//.test(navigator.userAgent), LOCKED=false;
// "View dex" on the closed Pokédex: someone's dex without logging in (?look=1). The lens leads back to the Pokédex.
var LOOK=APP&&!ME&&!!DEX&&/[?&]look=1(&|$)/.test(location.search);
if(APP){
  document.body.classList.add('app-mode');
  if(LOOK) document.body.classList.add('look-mode');
  else if(!ME) LOCKED=true;
  else if(DEX!==ME.id){ location.replace(location.pathname+'?dex='+encodeURIComponent(ME.id)+location.hash); LOCKED=true; }
}
document.title=DEX?DEXNAME+"'s dex · Dex Art Tracker":'Dex Art Tracker';
if(ADMIN){
  document.body.classList.add('admin-mode');
  document.getElementById('roTag').textContent='Admin';
  document.title='Admin · Dex Art Tracker';
} else if(RO){
  document.body.classList.add('ro-mode');
  document.title=ADMINPATH?'Admin login · Dex Art Tracker':(DEX?DEXNAME+"'s dex"+(LOOK?'':' (view only)'):'Dex Art Tracker');
  if(ADMINPATH) document.getElementById('roTag').textContent='Admin login';
  if(LOOK) document.getElementById('roTag').textContent=DEXNAME; // whose dex this is (the app hides the "Dex of" menu)
  if(LOGIN){ var lens=document.querySelector('.lens'); lens.removeAttribute('aria-hidden'); lens.setAttribute('role','button'); lens.setAttribute('tabindex','0'); var lt=LOOK?'Back to the trainers':ADMINPATH?'Admin login':(DEX?'Log in to '+DEXNAME+"'s dex":'Log in'); lens.setAttribute('aria-label',lt); lens.title=lt; lens.style.cursor='pointer'; }
  if(HIDEV){ ['roWorth','roCost'].forEach(function(i){ var e=document.getElementById(i); if(e) e.style.display='none'; }); }
}
'use strict';
var cards=[], trainers=[], regular=[], sets=[], setsById={}, names={}, maxDex=1025;
var byDex={}, byReg={}, byId={};
// Prices: € Cardmarket or $ TCGplayer, chosen on the server with PRICE_SOURCE.
var CUR=window.DEX_CUR==='us'?'us':'eu';
var st={own:{},cards:{},pick:{},wish:{},cur:CUR};
var added={}, trades=null;
var trFilter='all', view='dex', curSet=null, setData=null, setFilter='all', setCache={}, dexOpen=null, regShown=60, armed=null;

function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
// A dex as stored, with its wish lists (the server made the first list from the wishes of earlier versions).
function normState(s){
  var o={own:s.own||{},cards:s.cards||{},pick:s.pick||{},cur:CUR,lists:[]};
  if(Array.isArray(s.lists)&&s.lists.length) o.lists=s.lists.map(function(l,i){ return {id:String(l.id||'w'+(i+1)),name:String(l.name||'Wish list'),cards:(l.cards||[]).map(String)}; });
  else o.lists=[{id:'w1',name:'Wish list',cards:[]}];
  return o;
}
function setStatus(t){
  if(RO) t=String(t).replace(' Pick another one under "view".','').replace(' Open one to see every card and tick what you own.',' Open one to see every card.');
  $('status').textContent=t;
}
async function call(url,opts){
  var r=await fetch(url,opts);
  var j=await r.json().catch(function(){return {};});
  if(!r.ok){ var e=new Error(j.error||('HTTP '+r.status)); e.status=r.status; throw e; }
  return j;
}
function getJSON(url){ return call(url); }
function post(url,body){ return call(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); }

/* ---------- pictures: TCGdex first, then two other image hosts, then a placeholder ---------- */
function ptcgId(sid){ return String(sid).replace(/^([a-z]+)0*(\d)/i,'$1$2').replace('.','pt'); }
function isJa(id){ return /^ja:/.test(String(id||'')); }
function langOf(id){ var m=/^(ja|zh-cn):/.exec(String(id||'')); return m?m[1]:'en'; }
function langTag(id){ var l=langOf(id); return l==='ja'?' · JA':l==='zh-cn'?' · ZH':''; }
// the names a card can be found by: its printed name (also Japanese or Chinese) and the English name of its Pokémon
function cardNames(c){ var t=String(c.n||''); (c.d||[]).forEach(function(n){ if(names[n]) t+=' '+names[n]; }); return t.toLowerCase(); }
function numOf(k){ return /^\d+$/.test(String(k))?String(+k):String(k); }
var PHONE=false; try{ PHONE=window.matchMedia('(max-width:700px)').matches; }catch(e){}
var PICS_OUT=!!window.DEX_PICS_OUT; // pictures from the outside sites first, the stored copy as the spare
function imgList(c,big){
  var lightbox=!!big;
  big=big||PHONE; // phones get the full resolution picture everywhere
  var l=[], st=[], lp=c.lc?'img/c/'+encodeURIComponent(c.id)+'/':null, low=lp?lp+'low?v='+encodeURIComponent(c.lv||''):null;
  // The copies stored on this server
  if(lp&&(c.lc>=2||!big)) st.push(lp+(big&&c.lc>=2?'high':'low')+'?v='+encodeURIComponent(c.lv||''));
  if(lp&&c.lc<2&&big&&!lightbox) st.push(low);
  // The outside picture sites
  if(c.b) l.push(c.b+'/'+(big?'high':'low')+'.webp');
  if(c.im) l.push(big?(c.iL||c.im):c.im); // found on pokemontcg.io, or set by hand
  if(c.sid&&c.k!=null&&c.k!==''&&isJa(c.sid)){
    // Japanese cards: Scrydex lists them as <set>_ja-<number>. The exact numbering style is a guess, so both are tried.
    var js=String(c.sid).replace(/^ja:/,'').toLowerCase(), sz=big?'medium':'small', plain=numOf(c.k);
    l.push('https://images.scrydex.com/pokemon/'+encodeURIComponent(js)+'_ja-'+encodeURIComponent(plain)+'/'+sz);
    if(String(c.k)!==plain) l.push('https://images.scrydex.com/pokemon/'+encodeURIComponent(js)+'_ja-'+encodeURIComponent(c.k)+'/'+sz);
  }
  if(c.sid&&c.k!=null&&c.k!==''&&langOf(c.sid)==='en'){
    var pid=ptcgId(c.sid), nm=encodeURIComponent(numOf(c.k));
    l.push('https://images.pokemontcg.io/'+pid+'/'+nm+(big?'_hires':'')+'.png');
    l.push('https://images.scrydex.com/pokemon/'+pid+'-'+nm+'/'+(big?'medium':'small'));
  }
  // Which first is the admin's choice (Show pictures from). A picture set by hand always comes from this server;
  // when the outside sites come first, only the first two are tried before the stored copy, so a miss costs little.
  if(PICS_OUT&&!c.lm&&st.length) l=l.slice(0,2).concat(st,l.slice(2)); else l=st.concat(l);
  if(low&&l.indexOf(low)<0) l.push(low); // last resort: the stored low one
  return l;
}
function subOf(c){ var s=setsById[c.sid]; return (s?s.name:(c.sid||''))+(c.k?' · '+c.k:'')+langTag(c.sid); }
function phHTML(name,sub){ return '<div class="ph"><i class="ball"></i><b>'+esc(name)+'</b><span>No picture available yet</span><span>'+esc(sub)+'</span></div>'; }
function picHTML(c,big){
  var l=imgList(c,big);
  if(!l.length) return phHTML(c.n,subOf(c));
  return '<img loading="lazy" src="'+esc(l[0])+'" data-srcs="'+esc(l.slice(1).map(encodeURIComponent).join('|'))+'" data-n="'+esc(c.n)+'" data-sub="'+esc(subOf(c))+'" alt="'+esc(c.n)+'" data-do="zoom" data-id="'+esc(c.id)+'">';
}
function logoList(s){
  var l=[], own=s.ll?'img/s/'+encodeURIComponent(s.id)+'?v='+encodeURIComponent(s.ll):null; // stored on this server
  if(own&&(!PICS_OUT||s.lm||!s.lg)) l.push(own);
  if(s.lg){ l.push(s.lg+'.webp'); if(own&&l.indexOf(own)<0) l.push(own); l.push(s.lg+'.png'); }
  if(s.sy){ l.push(s.sy+'.webp'); }
  if(langOf(s.id)==='en'){
    var pid=ptcgId(s.id);
    l.push('https://images.pokemontcg.io/'+pid+'/logo.png');
    l.push('https://images.scrydex.com/pokemon/'+pid+'-logo/logo');
    l.push('https://images.pokemontcg.io/'+pid+'/symbol.png');
  }
  return l;
}
function logoHTML(s){
  var l=logoList(s);
  if(!l.length) return '';
  return '<img class="slogo" loading="lazy" src="'+esc(l[0])+'" data-srcs="'+esc(l.slice(1).map(encodeURIComponent).join('|'))+'" data-hide="1" data-fb="'+esc(s.id)+'" alt="'+esc(s.name)+'">';
}
document.addEventListener('error',function(e){
  var t=e.target;
  if(!t||t.tagName!=='IMG'||t.dataset.srcs===undefined) return;
  var rest=t.dataset.srcs?t.dataset.srcs.split('|'):[];
  if(rest.length){ t.dataset.srcs=rest.slice(1).join('|'); t.src=decodeURIComponent(rest[0]); }
  else if(t.dataset.hide){ var sp=document.createElement('span'); sp.className='sid'; sp.textContent=t.dataset.fb||''; t.replaceWith(sp); }
  else { var d=document.createElement('div'); d.innerHTML=phHTML(t.dataset.n,t.dataset.sub); t.replaceWith(d.firstChild); }
},true);

/* ---------- data ---------- */
function showGens(s){
  if(!s||!s.sets) return;
  var t=s.count+' art cards · '+s.regular+' regular cards · '+s.sets.scanned+' sets';
  if(s.backlog) t+=' · '+s.backlog+' cards still to check';
  t+=' · '+s.pricesDue+' prices due';
  if(s.picsDue) t+=' · '+s.picsDue+' pictures to look up';
  if(s.imgsStored||s.imgsDue) t+=' · '+s.imgsStored+' pictures stored'+(s.imgsDue?', '+s.imgsDue+' to download':'');
  if(s.setsChecked) t+=' · new sets last checked '+new Date(s.setsChecked).toLocaleDateString(undefined,{day:'numeric',month:'short'});
  $('gens').textContent=ADMIN?t:''; // the database figures are for the admin only
}
async function loadData(){
  for(;;){
    try{ var c=await getJSON('data/cards.json'); cards=c.cards||[]; trainers=c.trainers||[]; regular=c.regular||[]; sets=c.sets||[]; break; }
    catch(e){
      if(e.status!==404) throw e;
      var s=await getJSON('api/status').catch(function(){return null;});
      showGens(s);
      setStatus('The server is building its card database'+(s&&s.sets?' ('+s.count+' art cards stored, '+s.backlog+' still to check)':'')+'. This can take a long time the first time. This page checks again in 15 seconds.');
      await sleep(15000);
    }
  }
  setsById={}; sets.forEach(function(s){setsById[s.id]=s;});
  setCache={};
  try{ showGens(await getJSON('api/status')); }catch(e){}
  try{ var n=await getJSON('data/names.json'); names=n.names||{}; maxDex=n.max||maxDex; }catch(e){}
}
async function loadState(){
  var s=null;
  try{ s=await getJSON('api/state?dex='+encodeURIComponent(DEX)); }catch(e){}
  if(s&&s.own) st=normState(s); added=s.added||{};
}
var saveTimer=null;
function save(){
  if(RO) return;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(function(){
    fetch('api/state?dex='+encodeURIComponent(DEX),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(st)}).then(function(r){ if(r.status===401||r.status===403){ location.reload(); return; } return r.json(); }).then(function(j){ if(j&&j.added){ added=j.added; if(view==='showcase') renderShowcase(); } }).catch(function(){});
  },400);
}

function price(c){ var v=c&&c[st.cur]; return typeof v==='number'?v:null; }
function fmt(v){ return v==null?'no price':(st.cur==='eu'?'€':'$')+v.toFixed(2); }
function ageOk(c){ return c&&c.pt&&(Date.now()-Date.parse(c.pt))<30*864e5; }
function getBtn(c){ return '<button type="button" class="mini" data-do="getp" data-id="'+esc(c.id)+'" title="Ask the card service for this card now">Get price</button>'; }
function priceHTML(c){
  if(!c) return '';
  var isArt=c.a||c.t==='a';
  if(c.pv) return '<div class="price" title="Known art card, price not fetched yet">price pending</div>'+getBtn(c);
  if(!isArt&&!c.pt) return '<div class="price" title="Prices of regular cards are fetched slowly in the background">price not loaded yet</div>'+getBtn(c);
  return '<div class="price" title="Price checked '+(c.pt?new Date(c.pt).toLocaleDateString():'unknown')+'">'+fmt(price(c))+chHTML(c)+'</div>'+printsHTML(c)+(price(c)==null?getBtn(c):'');
}
// Up or down: Cardmarket's day price (yesterday's average) against its 30-day average.
function chHTML(c){
  if(!c||st.cur!=='eu'||typeof c.ch!=='number') return '';
  var pc=Math.round(c.ch*100), cls=pc>=1?'up':pc<=-1?'down':'flat';
  return ' <span class="chg '+cls+'" title="Day price compared with the 30-day average on Cardmarket">'+(pc>=1?'▲ +'+pc:pc<=-1?'▼ '+pc:'= 0')+'%</span>';
}
// Every printing with its own price (standard / reverse holo on Cardmarket; normal, holo, reverse, 1st edition ... on TCGplayer)
function printsHTML(c){
  var v=c&&c.vr&&c.vr[st.cur];
  if(!v||v.length<2) return '';
  return '<div class="prints">'+v.map(function(x){ return '<span>'+esc(x.k)+' <b>'+fmt(x.v)+'</b></span>'; }).join('')+'</div>';
}
function linkHTML(c){
  var nm=c.n;
  if(/[^\x00-\x7F]/.test(nm||'')&&c.d&&c.d.length&&names[c.d[0]]){ // Japanese card name: search with the English Pokémon name, keeping ex / V / VMAX etc.
    var rest=String(nm).replace(/[^\x00-\x7F]+/g,' ').replace(/\s+/g,' ').trim();
    nm=names[c.d[0]]+(rest?' '+rest:'');
  }
  var q=[nm,c.k||''].filter(Boolean).join(' ').trim().split(/\s+/).map(encodeURIComponent).join('+');
  var cm=c.cm?'https://www.cardmarket.com/en/Pokemon/Products?idProduct='+encodeURIComponent(c.cm):'https://www.cardmarket.com/en/Pokemon/Products/Search?searchString='+q;
  var tp='https://www.tcgplayer.com/search/pokemon/product?q='+q;
  return '<div class="links"><a href="'+esc(cm)+'" target="_blank" rel="noopener noreferrer" title="'+(c.cm?'This exact card on Cardmarket':'Search Cardmarket for this card')+'">Cardmarket ↗</a> <a href="'+esc(tp)+'" target="_blank" rel="noopener noreferrer">TCGplayer ↗</a></div>';
}
var priceTried={};
async function loadPrices(list){
  if(RO) return;
  var ids=list.filter(function(c){ return c&&!c.a&&c.t!=='a'&&c.t!=='p'&&!ageOk(c)&&!priceTried[c.id]; }).slice(0,6).map(function(c){ priceTried[c.id]=1; return c.id; });
  if(!ids.length) return;
  try{ await post('api/prices',{ids:ids}); }catch(e){ return; }
  await loadData(); index();
  if(curSet){ delete setCache[curSet]; await openSet(curSet,true); }
  if(dexOpen) fillDex(false);
}
function setName(c){ var s=setsById[c.sid]; return s?s.name:(c.sid||''); }
function setDate(c){ var s=setsById[c.sid]; return s?s.date:''; }

function index(){
  byDex={}; byReg={}; byId={};
  cards.forEach(function(c){ c.a=1; byId[c.id]=c; (c.d||[]).forEach(function(n){ (byDex[n]=byDex[n]||[]).push(c); }); });
  trainers.forEach(function(c){ c.a=1; c.tr=1; byId[c.id]=c; });
  regular.forEach(function(c){ byId[c.id]=c; (c.d||[]).forEach(function(n){ (byReg[n]=byReg[n]||[]).push(c); }); });
  Object.keys(byDex).forEach(function(n){
    byDex[n].sort(function(a,b){
      var pa=price(a), pb=price(b);
      if(pa===null&&pb===null) return 0;
      if(pa===null) return 1; if(pb===null) return -1;
      return pa-pb;
    });
    if(+n>maxDex) maxDex=+n;
  });
  Object.keys(byReg).forEach(function(n){
    // regular cards: ones with a picture first, then newest set first
    byReg[n].sort(function(a,b){
      if(!!a.b!==!!b.b) return a.b?-1:1;
      return String(setDate(b)).localeCompare(String(setDate(a)));
    });
    if(+n>maxDex) maxDex=+n;
  });
}

/* ---------- ownership ---------- */
function owned(id){ return !!st.cards[id]; }
function artOwnedList(n){ return (byDex[n]||[]).filter(function(c){return owned(c.id);}); }
function regOwnedList(n){ return (byReg[n]||[]).filter(function(c){return owned(c.id);}); }
function artOwned(n){ var o=st.own[n]; return !!(o&&o.art)||artOwnedList(n).length>0; }
function anyOwned(n){ var o=st.own[n]; return !!(o&&o.any)||artOwned(n)||regOwnedList(n).length>0; }
// Main picture: the most expensive card you own, else the card you picked, else the cheapest art card, else a regular card.
function priciest(list){
  var best=null, bv=-2;
  list.forEach(function(c){ var v=price(c); if(v==null) v=-1; if(v>bv){ bv=v; best=c; } });
  return best;
}
function chosen(n){
  // A Pokémon you own shows the most expensive card of it that you own (art cards first; a regular card only when no art card exists).
  var ownedArt=artOwnedList(n);
  if(ownedArt.length) return priciest(ownedArt);
  if(!(byDex[n]&&byDex[n].length)){ var ownedReg=regOwnedList(n); if(ownedReg.length) return priciest(ownedReg); }
  var pid=st.pick[n];
  if(pid&&byId[pid]&&(byId[pid].d||[]).indexOf(+n)>=0) return byId[pid];
  var a=byDex[n]; if(a&&a.length) return a[0];
  var r=byReg[n]; if(r&&r.length) return r[0];
  return null;
}
// The art card that counts when you tick "Art card": your pick if it is an art card, else the cheapest.
function artTarget(n){
  var c=chosen(n);
  if(c&&c.a) return c;
  var a=byDex[n]; return a&&a.length?a[0]:null;
}
function isArmed(key){ return armed&&armed.key===key&&Date.now()-armed.t<4000; }
function arm(key){ armed={key:key,t:Date.now()}; setTimeout(function(){ if(armed&&armed.key===key) refresh(); },4100); }

/* ---------- Pokémon view ---------- */
function refresh(){ render(); if(dexOpen) fillDex(); if(reviewOpen&&$('scandlg').open) renderReview(); }
var GENS=[null,[1,151,'I','Kanto'],[152,251,'II','Johto'],[252,386,'III','Hoenn'],[387,493,'IV','Sinnoh'],[494,649,'V','Unova'],[650,721,'VI','Kalos'],[722,809,'VII','Alola'],[810,905,'VIII','Galar & Hisui'],[906,1025,'IX','Paldea']];
function genOf(n){ for(var g=1;g<GENS.length;g++) if(n<=GENS[g][1]) return g; return GENS.length-1; }
function render(){
  var q=$('q').value.trim().toLowerCase(), f=$('filter').value, gsel=0, lastGen=0, srt=$('sortSel').value, order=[];
  var gs={}; // per generation: Pokémon, with any card, with an art card, with an art card that exists
  for(var n0=1;n0<=maxDex;n0++){ var g0=genOf(n0), s0=gs[g0]=gs[g0]||{t:0,a:0,r:0,e:0}; s0.t++; if(anyOwned(n0)) s0.a++; if(artOwned(n0)) s0.r++; if(byDex[n0]&&byDex[n0].length) s0.e++; }
  var html=[], shown=0, any=0, art=0, avail=0, cost=0, costMissing=0, worth=0;
  for(var n=1;n<=maxDex;n++){
    var c=chosen(n), nm=names[n]||('#'+n), hasArt=!!(byDex[n]&&byDex[n].length);
    var ao=artOwned(n), yo=anyOwned(n);
    if(yo) any++; if(ao) art++;
    if(hasArt){
      avail++;
      var t=artTarget(n);
      if(!ao){ var p=price(t); if(p==null) costMissing++; else cost+=p; }
      else {
        var ol=artOwnedList(n);
        if(ol.length) ol.forEach(function(x){ var p2=price(x); if(p2!=null) worth+=p2; });
        else { var p3=price(t); if(p3!=null) worth+=p3; }
      }
    }
    if(q && nm.toLowerCase().indexOf(q)<0 && String(n)!==q) continue;
    if(f==='noany'&&yo) continue;
    if(f==='noart'&&(ao||!hasArt)) continue;
    if(f==='haveart'&&!ao) continue;
    if(f==='noexist'&&hasArt) continue;
    if(srt&&ownedPrice(n)===undefined) continue; // sorting by price: only Pokémon you own a card of
    var gn=genOf(n);
    if(gsel&&gsel!==gn) continue;
    shown++;
    if(srt) order.push({n:n,p:ownedPrice(n),i:html.length});
    else if(gn!==lastGen){
      lastGen=gn; var gi=GENS[gn], gx=gs[gn];
      html.push('<div class="sec gen" data-gen="'+gn+'"><b>Generation '+gi[2]+'</b><span>'+esc(gi[3])+' · No.'+gi[0]+'–'+Math.min(gi[1],maxDex)+'</span><span>any card '+gx.a+'/'+gx.t+' · art card '+gx.r+'/'+gx.e+'</span><div class="gbar" title="Art cards: '+gx.r+' of '+gx.e+'"><i style="width:'+(gx.e?Math.round(gx.r/gx.e*100):0)+'%"></i></div></div>');
    }
    var cnt=(byDex[n]||[]).length, rcnt=(byReg[n]||[]).length;
    var stc=ao?'s-g':(yo?'s-y':'s-r');
    var kA=artOwnedList(n).length, kR=regOwnedList(n).length;
    var artTxt=!hasArt?'No art card':(ao?(isArmed('art:'+n)?'Clear '+kA+' checked?':'✓ Art card'+(kA>1?' ×'+kA:'')):'Art card');
    var anyTxt=yo?(isArmed('any:'+n)?'Clear '+kR+' checked?':'✓ Any card'):'Any card';
    html.push('<div class="tile '+stc+'" data-n="'+n+'">'+
      '<div class="no"><span>No.'+String(n).padStart(4,'0')+'</span><i class="led"></i></div>'+
      '<div class="pic">'+(c?picHTML(c,false).replace('data-do="zoom"','data-do="zoom"'):phHTML(nm,'No card found yet'))+(c?'<span class="badge'+(c.a?'':' reg')+'">'+(c.a?'ART':'REGULAR')+'</span>':'')+(c&&isWish(n,c.id)?'<span class="badge wish" title="On the wish list">★ WISH</span>':'')+'</div>'+
      '<div class="name" title="'+esc(nm)+'">'+esc(nm)+'</div>'+
      '<div class="meta">'+(c?esc(c.a?(c.r||'Art card'):'Regular card')+'<br>'+esc(setName(c)):'&nbsp;')+'</div>'+
      (c&&(c.a||c.pt)?'<div class="price" title="Price checked '+(c.pt?new Date(c.pt).toLocaleDateString():'unknown')+'">'+fmt(price(c))+'</div>':'')+(c?linkHTML(c):'')+
      '<div class="row"><button type="button" data-do="any" data-n="'+n+'" class="yel'+(yo?' on':'')+(isArmed('any:'+n)?' arm':'')+'"'+(ao?' title="Counted because you have an art card"':'')+'>'+anyTxt+'</button>'+
      '<button type="button" data-do="art" data-n="'+n+'" class="'+(ao?'on':'')+(isArmed('art:'+n)?' arm':'')+'"'+(hasArt?'':' disabled')+'>'+artTxt+'</button></div>'+
      ((cnt||rcnt)?'<button type="button" class="alt" data-do="view" data-n="'+n+'">'+cnt+' art · '+rcnt+' regular · view</button>':'')+
      '</div>');
  }
  if(srt){ // highest (or lowest) owned price first; owned cards without a price last
    order.sort(function(a,b){
      if(a.p==null||b.p==null) return (a.p==null)-(b.p==null)||a.n-b.n;
      return (srt==='high'?b.p-a.p:a.p-b.p)||a.n-b.n;
    });
    html=order.map(function(o){ return html[o.i]; });
  }
  $('grid').innerHTML=html.join('');
  var S=st.cur==='eu'?'€':'$';
  $('sAny').textContent=any+' / '+maxDex;
  $('sArt').textContent=art+' / '+avail;
  $('sAvail').textContent=avail+' of '+maxDex;
  $('sWorth').textContent=S+worth.toFixed(2);
  $('sCost').textContent=S+cost.toFixed(2)+(costMissing?' (+'+costMissing+')':'');
  $('barAny').style.width=(maxDex?Math.min(100,any/maxDex*100):0)+'%';
  $('barArt').style.width=(maxDex?Math.min(100,art/maxDex*100):0)+'%';
  renderSets();
  if(view==='dex'&&srt) setStatus(shown+' Pokémon you own a card of, '+(srt==='high'?'most':'least')+' expensive first (by your most expensive card of each).');
  else if(view==='dex') setStatus(shown+' shown. Main picture is the most expensive card you own, else the cheapest art card (or a regular card when no art card exists). Pick another one under "view" to put it on your wish list.');
}

/* ---------- Pokémon card list ---------- */
function openDex(n){ dexOpen=+n; regShown=60; fillDex(true); if(!$('dlg').open) $('dlg').showModal(); loadPrices((byReg[dexOpen]||[]).slice(0,regShown)); }
function fillDex(reset){
  var n=dexOpen; if(!n) return;
  var list=byDex[n]||[], reg=byReg[n]||[], cur=chosen(n);
  $('dlgTitle').textContent='No.'+String(n).padStart(4,'0')+' '+(names[n]||('#'+n))+' · '+list.length+' art cards · '+reg.length+' regular cards';
  var box=$('opts'), top=reset?0:box.scrollTop;
  var h=[];
  function card(c){
    var isOwn=owned(c.id), sel=cur&&cur.id===c.id;
    var mk=c.a?'<button type="button" class="mini'+(isArmed('unart:'+c.id)?' arm':'')+'" data-do="mark" data-id="'+esc(c.id)+'" data-v="0">'+(isArmed('unart:'+c.id)?'Really?':'Not an art card')+'</button>'
      :'<button type="button" class="mini" data-do="mark" data-id="'+esc(c.id)+'" data-v="1">Count as art card</button>';
    mk+='<button type="button" class="mini" data-do="pic" data-id="'+esc(c.id)+'" title="Set this card\'s picture by hand">Picture…</button>';
    return '<div class="opt'+(sel?' sel':'')+(isOwn?' own':'')+'"><div class="pic">'+picHTML(c,false)+'</div>'+
      '<div><b>'+esc(c.n)+'</b></div><div>'+esc(subOf(c))+'</div>'+(c.a?'<div>'+esc(c.r||'Art card')+'</div>':'')+priceHTML(c)+linkHTML(c)+
      '<div class="row"><button type="button" class="'+(isOwn?'on':'')+'" data-do="have" data-id="'+esc(c.id)+'">'+(isOwn?'✓ Have it':'Have it')+'</button></div>'+
      (isOwn?'':'<div class="row">'+wishBtn(c)+'</div>')+
      '<button type="button" data-do="main" data-n="'+n+'" data-id="'+esc(c.id)+'"'+(sel?' disabled':'')+'>'+(sel?'✓ Main picture':'Use as main picture')+'</button>'+mk+'</div>';
  }
  if(list.length) h.push('<div class="sec">Art cards (cheapest first)</div>');
  list.forEach(function(c){h.push(card(c));});
  if(reg.length) h.push('<div class="sec">Regular cards</div>');
  reg.slice(0,regShown).forEach(function(c){h.push(card(c));});
  if(reg.length>regShown) h.push('<div class="sec"><button type="button" data-do="more">Show 60 more regular cards ('+(reg.length-regShown)+' left)</button></div>');
  box.innerHTML=h.join('');
  box.scrollTop=top;
}

/* ---------- lightbox ---------- */
function lookup(id){ return byId[id]||(setData&&setData.map[id])||scanMap[id]||null; }
function openLb(id){
  var c=lookup(id); if(!c) return;
  $('lbBody').innerHTML=picHTML(c,true).replace('data-do="zoom"','')+
    '<div style="margin-bottom:8px"><b>'+esc(c.n)+'</b><br><span style="color:var(--muted)">'+esc(subOf(c))+(c.r?' · '+esc(c.r):'')+'</span>'+(c.a||c.t==='a'||c.pt?'<br><span class="price">'+fmt(price(c))+'</span>':'')+'</div>'+linkHTML(c);
  history.pushState({app:1,lb:1},'',location.href);
  $('lb').showModal();
}

/* ---------- Sets view ---------- */
function sidOf(id){
  var i=id.lastIndexOf('-'), s=id.slice(0,i);
  if(setsById[s]) return s;
  for(var k in setsById) if(id.indexOf(k+'-')===0) return k;
  return null;
}
function ownedPerSet(){
  var m={}; Object.keys(st.cards).forEach(function(id){ var s=sidOf(id); if(s) m[s]=(m[s]||0)+1; });
  return m;
}
function renderTrainers(){
  var q=$('q').value.trim().toLowerCase(), list=trainers.slice();
  var own=list.filter(function(c){return owned(c.id);}).length, worth=0, left=0;
  list.forEach(function(c){ var v=price(c); if(v==null) return; if(owned(c.id)) worth+=v; else left+=v; });
  list=list.filter(function(c){
    if(trFilter==='miss'&&owned(c.id)) return false;
    if(trFilter==='own'&&!owned(c.id)) return false;
    return !q||cardNames(c).indexOf(q)>=0||setName(c).toLowerCase().indexOf(q)>=0;
  });
  list.sort(function(a,b){ return String(setDate(b)).localeCompare(String(setDate(a)))||String(a.k).localeCompare(String(b.k),undefined,{numeric:true}); });
  var S=st.cur==='eu'?'€':'$', h=[];
  h.push('<div class="sethead"><h2>Trainer art cards</h2><span>'+own+' / '+trainers.length+' owned'+(HIDEV?'':' · worth '+S+worth.toFixed(2)+' · left to spend '+S+left.toFixed(2))+'</span><span class="sp"></span>'+
    [['all','All'],['miss','Missing'],['own','Owned']].map(function(x){return '<button type="button" class="chip'+(trFilter===x[0]?' on':'')+'" data-do="tf" data-v="'+x[0]+'">'+x[1]+'</button>';}).join('')+'</div>');
  if(!trainers.length) h.push('<p>No trainer art cards stored yet. They are added as the server works through the art rarity list.</p>');
  h.push('<div class="cgrid">');
  list.forEach(function(c){
    var o=owned(c.id);
    h.push('<div class="tile '+(o?'s-g':'s-r')+'"><div class="no"><span>'+esc(c.k||'')+'</span><i class="led"></i></div>'+
      '<div class="pic">'+picHTML(c,false)+'<span class="badge">ART</span></div>'+
      '<div class="name" title="'+esc(c.n)+'">'+esc(c.n)+'</div>'+
      '<div class="meta">'+esc(c.r||'Art card')+' · '+esc(setName(c))+langTag(c.sid)+'</div>'+
      priceHTML(c)+linkHTML(c)+
      '<div class="row"><button type="button" class="'+(o?'on':'')+'" data-do="have" data-id="'+esc(c.id)+'">'+(o?'✓ Have it':'Have it')+'</button></div>'+wishBtn(c)+'</div>');
  });
  h.push('</div>');
  $('trainersView').innerHTML=h.join('');
  setStatus(list.length+' of '+trainers.length+' trainer art cards shown.');
}
/* ---------- sorting by price: the most expensive card you own of a Pokémon ---------- */
// undefined: you own no card of it; null: you own cards but none has a price.
function ownedPrice(n){
  var own=artOwnedList(n).concat(regOwnedList(n)), best=null;
  if(!own.length) return undefined;
  own.forEach(function(c){ var p=price(c); if(p!=null&&(best==null||p>best)) best=p; });
  return best;
}

/* ---------- wish lists: as many as you like, with any cards on them (also several of one Pokémon) ---------- */
function pl(n,w){ return n+' '+w+(n===1?'':'s'); }
var wlCur=''; try{ wlCur=localStorage.getItem('dexWishList:'+DEX)||''; }catch(e){}
function wlists(){ if(!st.lists||!st.lists.length) st.lists=[{id:'w1',name:'Wish list',cards:[]}]; return st.lists; }
function wlById(lid){ return wlists().find(function(l){ return l.id===lid; }); }
function wlNow(){ return wlById(wlCur)||null; } // null: all lists together
function dexOfCard(id){ var c=byId[id]; return c&&!c.tr&&c.d&&c.d.length?c.d[0]:null; }
function listsWith(id){ return wlists().filter(function(l){ return l.cards.indexOf(id)>=0; }); }
function wished(id){ return listsWith(id).length>0; }
function isWish(n,id){ return wished(id)&&!owned(id); }
// The cards of one list (or of all lists), leaving out cards you own by now.
function wishList(lid){
  var out=[], seen={};
  (lid?[wlById(lid)].filter(Boolean):wlists()).forEach(function(l){ l.cards.forEach(function(id){ if(!owned(id)&&byId[id]&&!seen[id]){ seen[id]=1; out.push({id:id,dex:dexOfCard(id)}); } }); });
  return out.sort(function(a,b){ return (a.dex==null)-(b.dex==null)||(a.dex||0)-(b.dex||0)||String(byId[a.id].n).localeCompare(byId[b.id].n); });
}
// Put a card on a list or take it off. A Pokémon without a main picture shows the card you wish for.
function wlSet(lid,id,on){
  var l=wlById(lid); if(!l) return;
  var i=l.cards.indexOf(id);
  if(on&&i<0){ l.cards.push(id); var n=dexOfCard(id); if(n&&!st.pick[n]) st.pick[n]=id; }
  if(!on&&i>=0){ l.cards.splice(i,1); if(!wished(id)) Object.keys(st.pick).forEach(function(k){ if(st.pick[k]===id&&!owned(id)) delete st.pick[k]; }); }
}
function wishChanged(){ save(); refresh(); if($('infodlg').open) renderInfo(); if(reviewOpen) renderReview(); }
// ☆ Wish: with one list it goes straight on (or off); with more you choose the lists.
function wishToggle(id){
  if(!byId[id]) return;
  var ls=wlists();
  if(ls.length===1){ wlSet(ls[0].id,id,!wished(id)); wishChanged(); return; }
  openWishPick(id);
}
var wpId=null;
function openWishPick(id){
  wpId=id; var c=byId[id];
  $('wpTitle').textContent=c?c.n+(c.k?' '+c.k:''):'Card'; $('wpNew').value='';
  renderWishPick(); if(!$('wpdlg').open) $('wpdlg').showModal();
}
function renderWishPick(){
  $('wpList').innerHTML=wlists().map(function(l){ var on=l.cards.indexOf(wpId)>=0, n=wishList(l.id).length;
    return '<label class="wprow"><input type="checkbox" data-wl="'+esc(l.id)+'"'+(on?' checked':'')+'> <span>'+esc(l.name)+'</span><small>'+pl(n,'card')+'</small></label>'; }).join('');
}
$('wpList').addEventListener('change',function(e){ var lid=e.target.dataset.wl; if(!lid||!wpId) return; wlSet(lid,wpId,e.target.checked); wishChanged(); renderWishPick(); });
$('wpAdd').addEventListener('click',function(){
  var nm=$('wpNew').value.trim(); if(!nm) { $('wpNew').focus(); return; }
  var l=wlNew(nm); wlSet(l.id,wpId,true); $('wpNew').value=''; wishChanged(); renderWishPick();
});
$('wpNew').addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); $('wpAdd').click(); } });
$('wpDone').addEventListener('click',function(){ $('wpdlg').close(); });
function wlNew(name){
  var ls=wlists(), n=1; while(wlById('w'+n)) n++;
  var l={id:'w'+n,name:String(name).slice(0,60),cards:[]}; ls.push(l); return l;
}
function wishBtn(c){
  if(owned(c.id)||!byId[c.id]) return '';
  var on=listsWith(c.id), w=on.length>0, many=wlists().length>1;
  var label=w?(many?'★ On '+(on.length===1?on[0].name:on.length+' lists'):'★ On wish list'):'☆ Wish';
  return '<button type="button" class="mini'+(w?' wished':'')+'" data-do="wish" data-id="'+esc(c.id)+'" title="'+(many?'Choose the wish lists for this card':(w?'Take it off the wish list':'Put it on the wish list'))+'">'+esc(label)+'</button>';
}
function cardTile(c,stc,body){
  return '<div class="tile '+stc+'"><div class="no"><span>'+esc(c.k||'')+'</span><i class="led"></i></div>'+
    '<div class="pic">'+picHTML(c,false)+(c.a?'<span class="badge">ART</span>':'')+'</div>'+
    '<div class="name" title="'+esc(c.n)+'">'+esc(c.n)+'</div>'+
    '<div class="meta">'+esc(c.a?(c.r||'Art card'):'Regular card')+' · '+esc(setName(c))+'</div>'+body+'</div>';
}
function dexBtn(n){ return '<div class="row"><button type="button" class="mini" data-do="view" data-n="'+n+'">#'+n+' '+esc(names[n]||'')+' →</button></div>'; }
async function loadTrades(){
  try{ trades=await getJSON('api/trades'); }catch(e){ trades=[]; }
  if(view==='wish') renderWish();
}
// Wish list order and price limit, remembered on this device (handy at a card show: cheapest first, up to what you want to pay).
var wishSort='cheap', wishMax=0;
try{ wishSort=localStorage.getItem('dexWishSort')||'cheap'; wishMax=+localStorage.getItem('dexWishMax')||0; }catch(e){}
var WISH_MAX=[0,1,2,5,10,25,50,100];
function wishSorted(list){
  var cmpP=function(a,b,dir){ var pa=price(byId[a.id]), pb=price(byId[b.id]); if(pa==null&&pb==null) return 0; if(pa==null) return 1; if(pb==null) return -1; return dir*(pa-pb); };
  var byName=function(a,b){ return String(byId[a.id].n).localeCompare(byId[b.id].n); };
  return list.slice().sort(function(a,b){
    if(wishSort==='cheap') return cmpP(a,b,1)||byName(a,b);
    if(wishSort==='dear') return cmpP(a,b,-1)||byName(a,b);
    if(wishSort==='name') return byName(a,b);
    if(wishSort==='set') return String(setDate(byId[b.id])).localeCompare(String(setDate(byId[a.id])))||byName(a,b);
    return (a.dex==null)-(b.dex==null)||(a.dex||0)-(b.dex||0)||byName(a,b); // Pokédex order
  });
}
function wishHit(w,q){
  if(!q) return true;
  var c=byId[w.id], hay=[c.n,setName(c),c.k,w.dex?names[w.dex]:'',w.dex?'#'+w.dex:''].join(' ').toLowerCase();
  return q.split(/\s+/).every(function(x){ return hay.indexOf(x)>=0; });
}
function renderWish(){
  if(!trades){ $('wishView').innerHTML='<p>Loading…</p>'; loadTrades(); return; }
  var others=trades.filter(function(t){ return t.id!==DEX; });
  var holders={}; others.forEach(function(t){ t.cards.forEach(function(id){ (holders[id]=holders[id]||[]).push(t.name); }); });
  var cur=wlNow(), mine=wishList(cur?cur.id:null);
  var wanted={}; others.forEach(function(t){ t.wish.forEach(function(w){ if(owned(w.id)&&byId[w.id]&&!(wanted[w.id]&&wanted[w.id].by.indexOf(t.name)>=0)) (wanted[w.id]=wanted[w.id]||{dex:w.dex||dexOfCard(w.id),by:[]}).by.push(t.name); }); });
  var wantedIds=Object.keys(wanted), match=mine.filter(function(w){ return holders[w.id]; }).length;
  var S=st.cur==='eu'?'€':'$', total=0, noPrice=0;
  mine.forEach(function(w){ var p=price(byId[w.id]); if(p==null) noPrice++; else total+=p; });
  var ls=wlists(), many=ls.length>1;
  var h=['<div class="wlbar">'+(many||RO?'<select data-ws="list" aria-label="Which wish list">'+(many?'<option value="">All lists together ('+wishList(null).length+')</option>':'')+
      ls.map(function(l){ return '<option value="'+esc(l.id)+'"'+(cur&&cur.id===l.id?' selected':'')+'>'+esc(l.name)+' ('+wishList(l.id).length+')</option>'; }).join('')+'</select>':'')+
    (RO?'':wlEdit?'<input data-ws="name" type="text" maxlength="60" value="'+esc(wlEdit==='new'?'':cur?cur.name:'')+'" placeholder="Name of the list" aria-label="Name of the list"><button type="button" class="mini on" data-wl="save">'+(wlEdit==='new'?'Make list':'Save name')+'</button><button type="button" class="mini" data-wl="cancel">Cancel</button>'
      :'<button type="button" class="mini" data-wl="new">+ New list</button>'+(mine.length?'<button type="button" class="mini" data-wl="cm" title="This list as text for Cardmarket\'s wants list">Export for Cardmarket</button>':'')+(cur?'<button type="button" class="mini" data-wl="rename">Rename</button>'+(many?'<button type="button" class="mini'+(isArmed('wldel:'+cur.id)?' arm':'')+'" data-wl="del">'+(isArmed('wldel:'+cur.id)?'Really delete "'+esc(cur.name)+'"?':'Delete list')+'</button>':''):''))+
    '</div>',
    '<div class="sethead"><h2>'+esc(cur?cur.name:(many?'All wish lists':DEXNAME+'\'s wish list'))+'</h2><span class="wtot">'+pl(mine.length,'card')+(HIDEV?'':' · '+S+total.toFixed(2)+(noPrice?' (+'+noPrice+' without a price)':''))+'</span><span>'+match+' owned by another trainer</span></div>'];
  if(!mine.length) h.push('<p>Nothing on '+(cur?'this list':'the wish list')+' yet. Use "☆ Wish" on a card in a Pokémon\'s card list, the Sets or Trainers view, or the card info after a scan. Any number of cards of one Pokémon can go on a list.</p>');
  var q=$('q').value.trim().toLowerCase(), all=mine.length;
  if(all){
    h.push('<div class="wishbar"><select data-ws="sort" aria-label="Order of the wish list">'+
      [['cheap','Cheapest first'],['dear','Most expensive first'],['dex','Pokédex order'],['name','Name'],['set','Newest set first']].map(function(o){ return '<option value="'+o[0]+'"'+(wishSort===o[0]?' selected':'')+'>'+o[1]+'</option>'; }).join('')+'</select>'+
      (HIDEV?'':'<span class="wmax">'+WISH_MAX.map(function(m){ return '<button type="button" class="chip'+(wishMax===m?' on':'')+'" data-wmax="'+m+'">'+(m?'≤ '+S+m:'Any price')+'</button>'; }).join('')+'</span>')+'</div>');
    mine=wishSorted(mine.filter(function(w){ var p=price(byId[w.id]); return wishHit(w,q)&&(!wishMax||(p!=null&&p<=wishMax)); }));
    if(mine.length<all){
      var sub=0; mine.forEach(function(w){ var p=price(byId[w.id]); if(p!=null) sub+=p; });
      h.push('<p class="wshown">Showing '+mine.length+' of '+all+(q?' matching "'+esc(q)+'"':'')+(wishMax?' up to '+S+wishMax:'')+(HIDEV?'':' · together '+S+sub.toFixed(2))+'. <button type="button" class="mini" data-wmax="reset">Show all</button></p>');
    }
  }
  h.push('<div class="cgrid">');
  mine.forEach(function(w){
    var c=byId[w.id], who=holders[c.id];
    h.push(cardTile(c,who?'s-y':'s-r',priceHTML(c)+'<button type="button" class="spark" data-chart="'+esc(c.id)+'" title="Price history"><span class="sparknote">…</span></button>'+linkHTML(c)+
      '<div class="who'+(who?'':' none')+'">'+(who?'Owned by '+esc(who.join(', ')):'No other trainer has this one')+'</div>'+(w.dex?dexBtn(w.dex):'')+
      (many&&!cur?'<div class="who">On '+esc(listsWith(c.id).map(function(l){ return l.name; }).join(', '))+'</div>':'')+
      (RO?'':'<div class="row">'+(cur?'<button type="button" data-wl="off" data-id="'+esc(c.id)+'">Take off this list</button>':'')+(many?'<button type="button" class="mini" data-do="wish" data-id="'+esc(c.id)+'">Lists…</button>':(cur?'':'<button type="button" data-do="wish" data-id="'+esc(c.id)+'">Take off wish list</button>'))+'</div>')));
  });
  h.push('</div>');
  h.push('<div class="sethead" style="margin-top:22px"><h2>'+esc(DEXNAME)+' has, others want</h2><span>'+pl(wantedIds.length,'card')+'</span></div>');
  if(!wantedIds.length) h.push('<p>'+(others.length?'None of the cards on the other trainers\' wish lists are in this dex.':'There are no other trainers yet.')+'</p>');
  h.push('<div class="cgrid">');
  wantedIds.forEach(function(id){
    var c=byId[id], w=wanted[id];
    h.push(cardTile(c,'s-g',priceHTML(c)+linkHTML(c)+'<div class="who">Wanted by '+esc(w.by.join(', '))+'</div>'+(w.dex?dexBtn(w.dex):'')));
  });
  h.push('</div>');
  $('wishView').innerHTML=h.join('');
  fillSparks(mine.map(function(w){ return w.id; }));
  setStatus(all+' on '+(cur?'"'+cur.name+'"':'the wish list'+(many?'s':''))+(mine.length<all?' ('+mine.length+' shown)':'')+' · '+wantedIds.length+' wanted by others.');
}

// The list you look at (one list or all), as text for Cardmarket's "Add Deck List"
function openCardmarket(){
  var cur=wlNow(); $('cmTitle').textContent=cur?cur.name:(wlists().length>1?'all wish lists':wlists()[0].name); $('cmText').value='Making the list…'; $('cmNote').textContent='';
  if(!$('cmdlg').open) $('cmdlg').showModal();
  var ids=wishList(cur?cur.id:null).map(function(w){ return w.id; });
  var ask=openCardmarket.n=(openCardmarket.n||0)+1; // only the last request counts (the set box may be clicked meanwhile)
  post('api/cardmarket',{ids:ids,sets:$('cmSets').checked}).then(function(j){ if(ask!==openCardmarket.n) return;
    $('cmText').value=j.text||'';
    $('cmNote').innerHTML=pl(j.n||0,'card')+'.'+(j.left?' <b>'+j.left+' more did not fit</b> (500 per export): split the list.':'')+(j.unsure&&j.unsure.length?' <b>Check these on Cardmarket</b> (Japanese and Chinese cards go by their English Pokémon name; Cardmarket may need the right set and version): '+esc(j.unsure.slice(0,12).join(' · '))+(j.unsure.length>12?' …':''):'');
  }).catch(function(){ if(ask!==openCardmarket.n) return; $('cmText').value=''; $('cmNote').textContent='Could not make the list. Try again in a moment.'; });
}
$('cmSets').addEventListener('change',openCardmarket);
$('cmClose').addEventListener('click',function(){ $('cmdlg').close(); });
$('cmCopy').addEventListener('click',function(){
  var t=$('cmText'), done=function(){ $('cmCopy').textContent='Copied ✓'; setTimeout(function(){ $('cmCopy').textContent='Copy'; },1800); };
  if(navigator.clipboard&&window.isSecureContext) navigator.clipboard.writeText(t.value).then(done,function(){ t.select(); document.execCommand('copy'); done(); });
  else { t.select(); document.execCommand('copy'); done(); }
});
var wlEdit=''; // '' | 'new' | 'rename': the name box in the list bar
function wlPick(lid){ wlCur=lid; try{ localStorage.setItem('dexWishList:'+DEX,lid); }catch(x){} }
$('wishView').addEventListener('click',function(e){
  var b=e.target.closest('[data-wl]'); if(!b||RO) return;
  var a=b.dataset.wl, cur=wlNow();
  if(a==='new'){ wlEdit='new'; renderWish(); var i=$('wishView').querySelector('[data-ws=name]'); if(i) i.focus(); }
  else if(a==='rename'&&cur){ wlEdit='rename'; renderWish(); var j=$('wishView').querySelector('[data-ws=name]'); if(j){ j.focus(); j.select(); } }
  else if(a==='cancel'){ wlEdit=''; renderWish(); }
  else if(a==='save'){
    var nm=($('wishView').querySelector('[data-ws=name]').value||'').trim(); if(!nm) return;
    if(wlEdit==='new'){ var l=wlNew(nm); wlPick(l.id); } else if(cur) cur.name=nm.slice(0,60);
    wlEdit=''; save(); renderWish();
  }
  else if(a==='del'&&cur&&wlists().length>1){
    if(!isArmed('wldel:'+cur.id)){ arm('wldel:'+cur.id); renderWish(); return; }
    var ids=cur.cards.slice(); st.lists=wlists().filter(function(l){ return l!==cur; });
    ids.forEach(function(id){ if(!wished(id)) Object.keys(st.pick).forEach(function(k){ if(st.pick[k]===id&&!owned(id)) delete st.pick[k]; }); });
    wlPick(''); save(); refresh();
  }
  else if(a==='off'&&cur){ wlSet(cur.id,b.dataset.id,false); wishChanged(); }
  else if(a==='cm'){ openCardmarket(); }
});
$('wishView').addEventListener('keydown',function(e){ if(e.target.dataset.ws==='name'&&e.key==='Enter'){ e.preventDefault(); $('wishView').querySelector('[data-wl=save]').click(); } if(e.target.dataset.ws==='name'&&e.key==='Escape'){ wlEdit=''; renderWish(); } });
$('wishView').addEventListener('change',function(e){
  if(e.target.dataset.ws==='list'){ wlPick(e.target.value); wlEdit=''; renderWish(); return; }
  if(e.target.dataset.ws!=='sort') return;
  wishSort=e.target.value; try{ localStorage.setItem('dexWishSort',wishSort); }catch(x){} renderWish();
});
$('wishView').addEventListener('click',function(e){
  var b=e.target.closest('[data-wmax]'); if(!b) return;
  if(b.dataset.wmax==='reset'){ wishMax=0; $('q').value=''; } else wishMax=+b.dataset.wmax;
  try{ localStorage.setItem('dexWishMax',String(wishMax)); }catch(x){} renderWish();
});

/* ---------- showcase: every card you own, in the order you choose ---------- */
// Orders: time added, price, Pokédex number, release date (of the set). The ⇅ button turns the order around.
// Cards without the value (no price, no time noted, a trainer without a dex number) always come last.
var SHOW_SORTS=[['added','Time added','Newest first','Oldest first'],['price','Price','Highest first','Lowest first'],['dex','Pokédex number','No. 1 first','Highest No. first'],['date','Release date','Oldest first','Newest first']];
var showSort='added', showRev=false, showN=120;
try{ showSort=localStorage.getItem('dexShowSort')||'added'; showRev=localStorage.getItem('dexShowRev')==='1'; }catch(e){}
if(!SHOW_SORTS.some(function(o){ return o[0]===showSort; })) showSort='added';
function addedAt(id){
  return added[id]||''; // cards owned from before the times were kept have none
}
function showList(){
  var q=$('q').value.trim().toLowerCase(), words=q?q.split(/\s+/):[], out=[];
  Object.keys(st.cards).forEach(function(id){
    if(!st.cards[id]) return;
    var c=lookup(id);
    if(!c) c={id:id,n:id,sid:'',k:''}; // a card that left the card list
    if(words.length){ var hay=[cardNames?cardNames(c):c.n,setName(c),c.k,(c.d||[]).map(function(n){ return '#'+n+' '+(names[n]||''); }).join(' ')].join(' ').toLowerCase();
      if(!words.every(function(w){ return hay.indexOf(w)>=0; })) return; }
    out.push({c:c,t:addedAt(id),p:price(c),n:c.d&&c.d.length?c.d[0]:null,r:setDate(c)||''});
  });
  var dir=showRev?-1:1, numOf=function(c){ var m=/\d+/.exec(c.k||''); return m?+m[0]:0; };
  var key={added:function(x){ return x.t||null; },price:function(x){ return x.p; },dex:function(x){ return x.n; },date:function(x){ return x.r||null; }}[showSort];
  var base={added:-1,price:-1,dex:1,date:1}[showSort]; // the first way round: newest, highest, No. 1, oldest
  out.sort(function(a,b){
    var ka=key(a), kb=key(b);
    if(ka==null&&kb!=null) return 1; if(kb==null&&ka!=null) return -1;
    if(ka!=null&&kb!=null&&ka!==kb) return (ka<kb?-1:1)*base*dir;
    return String(a.r).localeCompare(String(b.r))||numOf(a.c)-numOf(b.c)||String(a.c.n).localeCompare(String(b.c.n));
  });
  return out;
}
function renderShowcase(){
  var list=showList(), all=Object.keys(st.cards).filter(function(id){ return st.cards[id]; }).length, q=$('q').value.trim();
  var S=st.cur==='eu'?'€':'$', total=0, noPrice=0;
  list.forEach(function(x){ if(x.p==null) noPrice++; else total+=x.p; });
  var o=SHOW_SORTS.find(function(x){ return x[0]===showSort; });
  var h=['<div class="sethead"><h2>'+esc(DEXNAME)+'\'s showcase</h2><span class="wtot">'+pl(list.length,'card')+(q&&list.length<all?' of '+all:'')+(HIDEV?'':' · '+S+total.toFixed(2)+(noPrice?' (+'+noPrice+' without a price)':''))+'</span></div>'];
  if(!all) h.push('<p>No cards yet. Every card you tick, scan or import shows up here.</p>');
  else {
    h.push('<div class="wishbar"><select data-sc="sort" aria-label="Order of the showcase">'+SHOW_SORTS.map(function(x){ return '<option value="'+x[0]+'"'+(x[0]===showSort?' selected':'')+'>'+x[1]+'</option>'; }).join('')+'</select>'+
      '<button type="button" class="mini screv" data-sc="rev" title="Turn the order around">⇅ '+esc(showRev?o[3]:o[2])+'</button></div>');
    if(q&&!list.length) h.push('<p>No card matches "'+esc(q)+'".</p>');
  }
  h.push('<div class="cgrid">');
  list.slice(0,showN).forEach(function(x){
    var c=x.c, known=!!byId[c.id];
    var when=showSort==='date'?(x.r?'Released '+new Date(x.r).toLocaleDateString(undefined,{month:'short',year:'numeric'}):'')
      :(x.t?'Added '+new Date(x.t).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'');
    h.push(cardTile(c,c.a?'s-g':'s-y',(when?'<div class="who">'+esc(when)+'</div>':'')+(known?priceHTML(c)+linkHTML(c):'')+(x.n?dexBtn(x.n):'')));
  });
  h.push('</div>');
  if(list.length>showN) h.push('<div class="row" style="justify-content:center;margin:14px 0"><button type="button" data-sc="more">Show more ('+(list.length-showN)+' left)</button></div>');
  $('histView').innerHTML=h.join('');
  setStatus(pl(list.length,'card')+' in the showcase, '+o[1].toLowerCase()+' · '+(showRev?o[3]:o[2]).toLowerCase()+'.');
}
$('histView').addEventListener('change',function(e){
  if(e.target.dataset.sc!=='sort') return;
  showSort=e.target.value; showRev=false; showN=120;
  try{ localStorage.setItem('dexShowSort',showSort); localStorage.setItem('dexShowRev','0'); }catch(x){} renderShowcase();
});
$('histView').addEventListener('click',function(e){
  var b=e.target.closest('[data-sc]'); if(!b) return;
  if(b.dataset.sc==='rev'){ showRev=!showRev; showN=120; try{ localStorage.setItem('dexShowRev',showRev?'1':'0'); }catch(x){} renderShowcase(); }
  else if(b.dataset.sc==='more'){ showN+=120; renderShowcase(); }
});
function renderSets(){
  $('grid').hidden=view!=='dex'; $('setsView').hidden=view!=='sets'; $('trainersView').hidden=view!=='trainers';
  $('wishView').hidden=view!=='wish'; $('histView').hidden=view!=='showcase'; $('adminView').hidden=view!=='admin';
  $('viewSel').value=view;
  $('filter').hidden=view!=='dex'; $('genSel').hidden=view!=='dex'; $('sortSel').hidden=view!=='dex'; $('setSort').hidden=view!=='sets'||!!curSet||setMode==='artists';
  // the language menu only when sets of more than one language are read
  var langs={}; sets.forEach(function(s){ langs[langOf(s.id)]=1; });
  $('setLang').hidden=view!=='sets'||!!curSet||Object.keys(langs).length<2||setMode==='artists';
  [].forEach.call($('setLang').options,function(o){ o.hidden=!!o.value&&!langs[o.value]; });
  if(view==='trainers') renderTrainers();
  if(view==='wish') renderWish();
  if(view==='showcase') renderShowcase();
  if(view==='admin') renderAdmin();
  if(view!=='sets') return;
  var q=$('q').value.trim().toLowerCase(), h=[];
  if(!curSet&&setMode==='artists'){ renderArtists(q); return; }
  if(!curSet){
    h.push(modeBar());
    var per=ownedPerSet(), srt=$('setSort').value;
    var lg=$('setLang').hidden?'':$('setLang').value;
    var list=sets.filter(function(s){ return (!lg||langOf(s.id)===lg)&&(!q||s.name.toLowerCase().indexOf(q)>=0||s.id.toLowerCase().indexOf(q)>=0); });
    function pct(s){ return s.n?(per[s.id]||0)/s.n:0; }
    list.sort(function(a,b){
      if(srt==='old') return String(a.date).localeCompare(String(b.date));
      if(srt==='name') return a.name.localeCompare(b.name);
      if(srt==='most') return pct(b)-pct(a);
      if(srt==='least') return pct(a)-pct(b);
      return String(b.date).localeCompare(String(a.date));
    });
    h.push('<div class="setlist">');
    list.forEach(function(s){
      var o=per[s.id]||0, p=s.n?Math.round(o/s.n*100):0;
      h.push('<button type="button" class="settile'+(o&&o>=s.n?' full':'')+'" data-do="set" data-id="'+esc(s.id)+'">'+
        '<div class="slbox">'+logoHTML(s)+'</div><b>'+esc(s.name)+'</b><span>'+esc(s.date)+' · '+s.n+' cards · '+s.art+' art'+(s.promo?' · promo':'')+langTag(s.id)+'</span>'+
        '<div class="mbar"><i style="width:'+p+'%"></i></div><span class="pct">'+o+' / '+s.n+' · '+p+'%</span></button>');
    });
    h.push('</div>');
    $('setsView').innerHTML=list.length?h.join(''):'<p>No sets stored yet. The server is still building its database.</p>';
    setStatus(list.length+' sets. Open one to see every card and tick what you own.');
    return;
  }
  if(!setData||setData.id!==curSet){ $('setsView').innerHTML='<p>Loading set…</p>'; return; }
  var s=setData, own=0, mainTot=0, mainOwn=0, secTot=0, secOwn=0, artTot=0, artOwn=0;
  s.cards.forEach(function(c){
    var o=owned(c.id); if(o) own++;
    if(c.sec){secTot++; if(o) secOwn++;} else {mainTot++; if(o) mainOwn++;}
    if(c.t==='a'){artTot++; if(o) artOwn++;}
  });
  var list2=s.cards.filter(function(c){
    if(q&&cardNames(c).indexOf(q)<0&&String(c.k)!==q) return false;
    if(setFilter==='miss') return !owned(c.id);
    if(setFilter==='own') return owned(c.id);
    if(setFilter==='art') return c.t==='a';
    return true;
  });
  var total=s.cards.length, p=total?Math.round(own/total*100):0;
  if(s.artist) h.push('<div class="sethead"><button type="button" data-do="back">← All artists</button><h2>'+esc(s.name)+'</h2><span>'+pl(total,'card')+' in '+pl(s.sets,'set')+'</span><span class="sp"></span>'+
    [['all','All'],['miss','Missing'],['own','Owned'],['art','Art cards']].map(function(x){return '<button type="button" class="chip'+(setFilter===x[0]?' on':'')+'" data-do="sf" data-v="'+x[0]+'">'+x[1]+'</button>';}).join('')+'</div>');
  else h.push('<div class="sethead"><button type="button" data-do="back">← All sets</button>'+(setsById[s.id]?'<span class="slbox big">'+logoHTML(setsById[s.id])+'</span>':'')+'<h2>'+esc(s.name)+'</h2><span>'+esc(s.date)+(s.promo?' · promo set':'')+langTag(s.id)+'</span>'+(ADMIN?'<button type="button" class="mini" data-do="setpic" data-id="'+esc(s.id)+'" title="Give this set a picture by hand">Set picture…</button>':'')+'<span class="sp"></span>'+
    [['all','All'],['miss','Missing'],['own','Owned'],['art','Art cards']].map(function(x){return '<button type="button" class="chip'+(setFilter===x[0]?' on':'')+'" data-do="sf" data-v="'+x[0]+'">'+x[1]+'</button>';}).join('')+'</div>');
  h.push('<div class="setprog"><span>'+own+' / '+total+' ('+p+'%)</span><div class="mbar"><i style="width:'+p+'%"></i></div>'+
    (s.official&&!s.artist?'<span>Main '+mainOwn+' / '+mainTot+'</span>':'')+(secTot?'<span>Secret '+secOwn+' / '+secTot+'</span>':'')+(artTot?'<span>Art '+artOwn+' / '+artTot+'</span>':'')+'</div>');
  h.push('<div class="cgrid">');
  list2.forEach(function(c){
    var o=owned(c.id), isA=c.t==='a';
    var stc=o?(isA?'s-g':'s-y'):'s-r';
    var mk=isA?'<button type="button" class="mini'+(isArmed('unart:'+c.id)?' arm':'')+'" data-do="mark" data-id="'+esc(c.id)+'" data-v="0">'+(isArmed('unart:'+c.id)?'Really?':'Not an art card')+'</button>'
      :'<button type="button" class="mini" data-do="mark" data-id="'+esc(c.id)+'" data-v="1">Count as art card</button>';
    mk+='<button type="button" class="mini" data-do="pic" data-id="'+esc(c.id)+'" title="Set this card\'s picture by hand">Picture…</button>';
    h.push('<div class="tile '+stc+'"><div class="no"><span>'+esc(c.k)+(s.official&&/^\d+$/.test(c.k)?' / '+s.official:'')+'</span><i class="led"></i></div>'+
      '<div class="pic">'+picHTML(c,false)+(isA?'<span class="badge">ART</span>':'')+'</div>'+
      '<div class="name" title="'+esc(c.n)+'">'+esc(c.n)+'</div>'+
      (c.d&&c.d.length?'<div class="row">'+c.d.slice(0,3).map(function(d){ return '<button type="button" class="mini" data-do="view" data-n="'+d+'" title="Open this Pokémon">#'+d+' '+esc(names[d]||'')+' →</button>'; }).join('')+'</div>':'')+
      '<div class="meta">'+(isA?esc(c.r||'Art card'):(c.t==='p'?'Not checked yet':(c.sec?'Secret card':'Regular card')))+(s.artist?' · <button type="button" class="linkish" data-do="set" data-id="'+esc(c.sid)+'">'+esc(c.sn)+'</button>'+langTag(c.sid):'')+'</div>'+
      priceHTML(c)+linkHTML(c)+
      '<div class="row"><button type="button" class="'+(o?'on':'')+'" data-do="have" data-id="'+esc(c.id)+'">'+(o?'✓ Have it':'Have it')+'</button></div>'+wishBtn(c)+''+mk+'</div>');
  });
  h.push('</div>');
  $('setsView').innerHTML=h.join('');
  setStatus(list2.length+' of '+total+' cards shown.');
}
/* ---------- artists: every illustrator, with the most expensive card they drew as picture ---------- */
var setMode='sets', artData=null, artLoading=false, artSort='name';
try{ setMode=localStorage.getItem('dexSetMode')==='artists'?'artists':'sets'; artSort=localStorage.getItem('dexArtSort')||'name'; }catch(e){}
function modeBar(){
  return '<div class="modebar">'+[['sets','Sets'],['artists','Artists']].map(function(x){ return '<button type="button" class="chip'+(setMode===x[0]?' on':'')+'" data-do="smode" data-v="'+x[0]+'">'+x[1]+'</button>'; }).join('')+'</div>';
}
function loadArtists(){
  if(artLoading) return; artLoading=true;
  getJSON('data/artists.json').then(function(d){ artData=d; }).catch(function(){ artData={list:[],ids:[]}; }).then(function(){ artLoading=false; if(view==='sets'&&!curSet&&setMode==='artists') renderSets(); });
}
function renderArtists(q){
  var h=[modeBar()];
  if(!artData){ h.push('<p>Loading artists…</p>'); $('setsView').innerHTML=h.join(''); loadArtists(); return; }
  if(!artData.list.length){ h.push('<p>The server has not read the artists yet. It reads them in the background (a few hundred per hour), so they show up here soon.</p>'); $('setsView').innerHTML=h.join(''); setStatus('No artists yet.'); return; }
  var list=artData.list.map(function(a,i){ var ids=artData.ids[i]||[], o=0; ids.forEach(function(id){ if(owned(id)) o++; }); return {a:a,o:o}; });
  if(q) list=list.filter(function(x){ return x.a.n.toLowerCase().indexOf(q)>=0; });
  list.sort(function(x,y){
    if(artSort==='most') return y.a.c-x.a.c||x.a.n.localeCompare(y.a.n);
    if(artSort==='owned') return y.o-x.o||y.a.c-x.a.c;
    if(artSort==='dear') return (price(y.a.cv)||0)-(price(x.a.cv)||0)||x.a.n.localeCompare(y.a.n);
    return x.a.n.localeCompare(y.a.n);
  });
  h.push('<div class="wishbar"><select data-art="sort" aria-label="Order of the artists">'+[['name','Name'],['most','Most cards'],['owned','Most owned by you'],['dear','Most expensive card']].map(function(o){ return '<option value="'+o[0]+'"'+(artSort===o[0]?' selected':'')+'>'+o[1]+'</option>'; }).join('')+'</select></div>');
  h.push('<div class="setlist artlist">');
  list.forEach(function(x){
    var a=x.a, p=a.c?Math.round(x.o/a.c*100):0, v=price(a.cv);
    h.push('<button type="button" class="settile arttile'+(x.o&&x.o>=a.c?' full':'')+'" data-do="artist" data-name="'+esc(a.n)+'">'+
      '<div class="artpic">'+picHTML(a.cv,false).replace(/ data-do="zoom"/g,'')+'</div><b>'+esc(a.n)+'</b><span>'+pl(a.c,'card')+(v!=null&&!HIDEV?' · top card '+fmt(v):'')+'</span>'+
      '<div class="mbar"><i style="width:'+p+'%"></i></div><span class="pct">'+x.o+' / '+a.c+' · '+p+'%</span></button>');
  });
  h.push('</div>');
  if(q&&!list.length) h.push('<p>No artist matches "'+esc(q)+'".</p>');
  $('setsView').innerHTML=h.join('');
  setStatus(pl(list.length,'artist')+'. Open one to see every card they drew.');
}
$('setsView').addEventListener('change',function(e){ if(e.target.dataset.art!=='sort') return; artSort=e.target.value; try{ localStorage.setItem('dexArtSort',artSort); }catch(x){} renderSets(); });
async function openSet(id,keepScroll){
  curSet=id; setFilter=keepScroll?setFilter:'all';
  if(!keepScroll){ setData=null; renderSets(); }
  try{
    var d=setCache[id]||await getJSON('api/set?id='+encodeURIComponent(id));
    setCache[id]=d;
    d.map={}; d.cards.forEach(function(c){ c.sid=c.sid||id; c.a=c.t==='a'?1:0; d.map[c.id]=c; }); // an artist's cards keep their own set
    setData=d;
  }catch(e){ setStatus('Could not load that set ('+e.message+').'); curSet=null; }
  var y=window.scrollY; renderSets(); if(keepScroll) window.scrollTo(0,y); else { window.scrollTo(0,0); if(setData) loadPrices(setData.cards); }
}

/* ---------- navigation: the browser's back and forward buttons stay inside the app ---------- */
var scrollPos={}, curHash='', closingByRoute=false, skipPop=false, lbByPop=false;
if('scrollRestoration' in history) history.scrollRestoration='manual';
function hashNow(){ return location.hash||'#/dex'; }
function go(h){
  if(hashNow()===h) return;
  scrollPos[hashNow()]=window.scrollY;
  history.pushState({app:1},'',h);
  applyRoute();
}
function goBack(fallback){
  if(history.state&&history.state.app) history.back();
  else { history.replaceState(null,'',fallback); applyRoute(); }
}
// Routes: #/dex   #/dex/25 (card list of one Pokémon)   #/sets   #/sets/<set id>   #/trainers   #/wish   #/showcase
async function applyRoute(){
  var h=hashNow(), parts=h.replace(/^#\/?/,'').split('/'), keepTop=false;
  curHash=h;
  if(parts[0]==='sets'){
    view='sets';
    if($('dlg').open){ closingByRoute=true; $('dlg').close(); }
    var id=parts.length>1&&parts[1]?decodeURIComponent(parts.slice(1).join('/')):null;
    if(id){ if(curSet!==id) setFilter='all'; await openSet(id,true); }
    else { curSet=null; setData=null; renderSets(); }
  } else if(parts[0]==='wish'||parts[0]==='showcase'){
    view=parts[0]; curSet=null; setData=null;
    if(view==='wish') trades=null; // read the other dexes again each time
    if($('dlg').open){ closingByRoute=true; $('dlg').close(); }
    render();
  } else if(parts[0]==='admin'&&ADMIN){
    view='admin'; curSet=null; setData=null;
    if($('dlg').open){ closingByRoute=true; $('dlg').close(); }
    render();
  } else if(parts[0]==='trainers'){
    view='trainers'; curSet=null; setData=null;
    if($('dlg').open){ closingByRoute=true; $('dlg').close(); }
    render();
  } else {
    view='dex'; curSet=null; setData=null;
    var n=parts[1]?+parts[1]:0;
    render();
    if(n>0){ openDex(n); keepTop=true; }
    else if($('dlg').open){ closingByRoute=true; $('dlg').close(); }
  }
  if(!keepTop) requestAnimationFrame(function(){ window.scrollTo(0,scrollPos[h]||0); });
}
window.addEventListener('popstate',function(){
  if($('lb').open){ lbByPop=true; $('lb').close(); return; }
  if(skipPop){ skipPop=false; return; }
  scrollPos[curHash]=window.scrollY;
  applyRoute();
});

/* ---------- actions ---------- */
function noteIn(t){ // the status line is behind the card list dialog, so show messages inside it too
  var b=$('opts'); if(!dexOpen||!b) return;
  var n=b.querySelector('.note'); if(!n){ b.insertAdjacentHTML('afterbegin','<div class="sec note"></div>'); n=b.querySelector('.note'); }
  n.textContent=t;
}
async function markArt(id,art){
  var msg=art?'Reading the card details…':'Updating…';
  setStatus(msg); noteIn(msg);
  try{ await post('api/card/mark',{id:id,art:art}); }
  catch(e){ if(e.status===401){ location.reload(); return; } setStatus(e.message); noteIn(e.message); return; }
  await loadData(); index();
  if(curSet) await openSet(curSet,true);
  refresh();
}
var toastTimer=null;
function toast(t){ // shown above everything, the card dialog included
  var el=$('toast'); el.textContent=t; clearTimeout(toastTimer);
  try{ el.hidePopover(); el.showPopover(); }catch(e){ el.classList.add('show'); }
  toastTimer=setTimeout(function(){ try{ el.hidePopover(); }catch(e){} el.classList.remove('show'); },4500);
}
// Clicking Have it / Any card / Art card on a dex you are not logged in to: say why nothing changes.
function readOnlyHint(){
  if(ADMIN) toast('The admin has no dex. To mark cards, log in to a trainer\'s dex on the normal address (without /admin/).');
  else if(ME&&ME.id!==DEX) toast('This is '+DEXNAME+"'s dex. Switch to your own dex under \"Dex of\" to mark cards.");
  else if(LOOK) toast('Tap the lens to log in to your own dex.');
  else if(LOGIN&&!ADMINPATH){ toast('Log in to '+DEXNAME+"'s dex to mark cards."); openLogin(); }
  else if(ADMINPATH){ toast('This is the admin address. Trainers log in on the normal address, without /admin/.'); }
  else toast(DEXNAME+"'s dex is view-only here.");
}
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-do]'); if(!t) return;
  var a=t.dataset.do, n=+t.dataset.n, id=t.dataset.id;
  if(RO&&/^(any|art|have)$/.test(a)){ readOnlyHint(); return; }
  if(RO&&/^(main|unwish|wish)$/.test(a)) return;
  if(RO&&!ADMIN&&/^(mark|getp)$/.test(a)) return;
  if(!ADMIN&&(a==='mark'||a==='pic'||a==='setpic')) return;
  if(a==='any'){
    if(artOwned(n)) return;
    if(anyOwned(n)){
      var regs=regOwnedList(n);
      if(regs.length&&!isArmed('any:'+n)){ arm('any:'+n); refresh(); return; }
      var o=st.own[n]; if(o){ o.any=false; if(!o.art) delete st.own[n]; }
      regs.forEach(function(c){ delete st.cards[c.id]; });
    } else { var o2=st.own[n]=st.own[n]||{any:false,art:false}; o2.any=true; }
    save(); refresh();
  } else if(a==='art'){
    if(!(byDex[n]||[]).length) return;
    if(artOwned(n)){
      var k=artOwnedList(n);
      if(k.length&&!isArmed('art:'+n)){ arm('art:'+n); refresh(); return; }
      var o3=st.own[n]; if(o3){ o3.art=false; if(!o3.any) delete st.own[n]; }
      k.forEach(function(c){ delete st.cards[c.id]; });
    } else { var tg=artTarget(n); if(tg) st.cards[tg.id]=1; }
    save(); refresh();
  } else if(a==='have'){
    if(owned(id)) delete st.cards[id]; else st.cards[id]=1;
    save(); refresh();
  } else if(a==='main'){ st.pick[n]=id; save(); refresh(); }
  else if(a==='unwish'){ delete st.pick[n]; save(); refresh(); }
  else if(a==='wish'){ wishToggle(id); }
  else if(a==='view'){ go('#/dex/'+n); }
  else if(a==='more'){ regShown+=60; fillDex(); }
  else if(a==='zoom'){ openLb(id); }
  else if(a==='pic'){ openPic(id); }
  else if(a==='setpic'){ openPic(id,true); }
  else if(a==='scanview'){ $('scandlg').close(); go('#/dex/'+n); }
  else if(a==='mark'){
    var art=t.dataset.v==='1';
    if(!art&&!isArmed('unart:'+id)){ arm('unart:'+id); refresh(); return; }
    markArt(id,art);
  }
  else if(a==='set'){ go('#/sets/'+encodeURIComponent(id)); }
  else if(a==='back'){ goBack('#/sets'); }
  else if(a==='smode'){ setMode=t.dataset.v; try{ localStorage.setItem('dexSetMode',setMode); }catch(x){} window.scrollTo(0,0); renderSets(); }
  else if(a==='artist'){ go('#/sets/'+encodeURIComponent('artist:'+t.dataset.name)); }
  else if(a==='getp'){
    t.disabled=true; t.textContent='Fetching…'; setStatus('Fetching the price…'); noteIn('Fetching the price…');
    post('api/card/fetch',{id:id}).then(async function(r){
      await loadData(); index();
      if(curSet){ delete setCache[curSet]; await openSet(curSet,true); }
      refresh(); if($('infodlg').open) renderInfo(); if(reviewOpen) renderReview();
      var m=r.notArt?'That card turned out not to be an art card.':(r.price&&(r.price.eu!=null||r.price.us!=null)?'Price updated.':'The card service has no price for this card.');
      setStatus(m); noteIn(m);
    }).catch(function(e){ if(e.status===401){ location.reload(); return; } t.disabled=false; t.textContent='Get price'; setStatus(e.message); noteIn(e.message); });
  }
  else if(a==='sf'){ setFilter=t.dataset.v; renderSets(); }
  else if(a==='tf'){ trFilter=t.dataset.v; renderTrainers(); }
});
$('viewSel').addEventListener('change',function(){ go('#/'+$('viewSel').value); });
$('dlgClose').addEventListener('click',function(){$('dlg').close();});
$('dlg').addEventListener('close',function(){
  dexOpen=null;
  if(closingByRoute){ closingByRoute=false; return; }
  if(/^#\/dex\/\d+/.test(location.hash)){
    if(history.state&&history.state.app) history.back();
    else { history.replaceState(null,'','#/dex'); curHash='#/dex'; }
  }
});
$('lbClose').addEventListener('click',function(){$('lb').close();});
$('lb').addEventListener('close',function(){
  if(lbByPop){ lbByPop=false; return; }
  if(history.state&&history.state.lb){ skipPop=true; history.back(); }
});
$('lb').addEventListener('click',function(e){ if(e.target===$('lb')) $('lb').close(); });
$('q').addEventListener('input',render);
$('filter').addEventListener('change',render);
$('sortSel').addEventListener('change',render);
$('genSel').addEventListener('change',function(){
  var g=+$('genSel').value;
  if(!g){ window.scrollTo({top:0,behavior:'smooth'}); return; }
  var el=document.querySelector('#grid .gen[data-gen="'+g+'"]');
  if(!el){ $('filter').value='all'; $('q').value=''; render(); el=document.querySelector('#grid .gen[data-gen="'+g+'"]'); }
  if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
});
$('setSort').addEventListener('change',render);
try{ $('setLang').value=localStorage.getItem('dexSetLang')||''; }catch(e){}
$('setLang').addEventListener('change',function(){ try{ localStorage.setItem('dexSetLang',$('setLang').value); }catch(e){} render(); });

async function pollRefresh(){
  if(RO) return;
  for(;;){
    var s=await getJSON('api/status').catch(function(){return null;});
    if(!s||!s.running) break;
    setStatus('The server is updating its card database'+(s.sets?' ('+s.count+' art cards stored, '+s.backlog+' still to check)':'')+'…');
    await sleep(5000);
  }
  await loadData(); index(); if(curSet) await openSet(curSet,true); refresh();
}
$('refresh').hidden=!ADMIN; $('gens').hidden=!ADMIN; // admin only: refreshing the database by hand, and its figures
$('refresh').addEventListener('click',async function(){
  try{ await post('api/refresh'); }
  catch(e){
    if(e.status===429) setStatus('Please wait a few minutes between manual refreshes.');
    else if(e.status===409) setStatus('Refreshing is switched off on the server.');
    else setStatus('Could not reach the server.');
    return;
  }
  pollRefresh();
});
function openLogin(){ $('lgTitle').textContent=ADMINPATH?'Admin login':(DEX?'Log in to '+DEXNAME+"'s dex":'Log in');
  var none=!DEX&&SIGNUP&&!ADMINPATH; // no trainers yet: straight to signing up
  $('lgForm').hidden=none; $('lgSignup').hidden=!SIGNUP||ADMINPATH||!DEX; $('suForm').hidden=!none; $('lgMsg').textContent=''; $('lgPw').value=''; $('lgdlg').showModal(); (none?$('suName'):$('lgPw')).focus(); }
function backToLock(){ location.replace(location.pathname); } // the app's closed Pokédex: pick a trainer again
if(LOGIN){
  var lensEl=document.querySelector('.lens'), lensGo=LOOK?backToLock:openLogin;
  lensEl.addEventListener('click',lensGo);
  lensEl.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); lensGo(); } });
}
$('lgClose').addEventListener('click',function(){ $('lgdlg').close(); });
// Signing up: a new trainer makes their own dex (when the admin allows it) and is logged in right away.
var SIGNUP=!!window.DEX_SIGNUP;
async function signUp(name,pw,pw2,web,msgEl){
  if(!name.trim()){ msgEl.textContent='Enter a trainer name.'; return; }
  if(pw.length<8){ msgEl.textContent='The password needs at least 8 characters.'; return; }
  if(pw!==pw2){ msgEl.textContent='The two passwords are not the same.'; return; }
  msgEl.textContent='…';
  try{ var r=await post('api/signup',{name:name,password:pw,website:web}); try{ localStorage.setItem('dexLast',r.id); }catch(x){} location.replace(location.pathname+'?dex='+encodeURIComponent(r.id)); }
  catch(err){ msgEl.textContent=err.message||'Could not sign up.'; }
}
function showSignup(on){ $('lgForm').hidden=on; $('lgSignup').hidden=on||!SIGNUP||ADMINPATH; $('suForm').hidden=!on; $('suMsg').textContent=''; (on?$('suName'):$('lgPw')).focus(); }
$('lgNew').addEventListener('click',function(){ showSignup(true); });
$('suBack').addEventListener('click',function(){ showSignup(false); });
$('suForm').addEventListener('submit',function(e){ e.preventDefault(); signUp($('suName').value,$('suPw').value,$('suPw2').value,$('suWeb').value,$('suMsg')); });
$('lgForm').addEventListener('submit',async function(e){
  e.preventDefault(); $('lgMsg').textContent='…';
  try{ await post('api/login',{dex:DEX,password:$('lgPw').value}); location.reload(); }
  catch(err){ $('lgMsg').textContent=err.status===429?'Too many tries. Wait 15 minutes.':(err.status===404?'Pick a dex under "Dex of" first.':'Wrong password.'); }
});
/* ---------- scanning: a queue of photos, then a screen to check what was found ---------- */
// Every tap of the lens adds a photo to the queue; the photos are scanned one by one in the background while you
// take the next. Every card found goes on the check list (kept on this device), where you confirm, change or skip
// it, and then add the confirmed cards to your dex in one go.
var scanStream=null, scanMap={}, scanJobs=[], jobSeq=0, jobsRunning=false, review=[], reviewOpen=false, rvOpen=null, rvQuery='';
var reviewKey='dexScanReview:'+DEX;
function loadReview(){
  try{ review=JSON.parse(localStorage.getItem(reviewKey)||'[]'); }catch(e){ review=[]; }
  if(!Array.isArray(review)) review=[];
  review.forEach(function(it){ (it.matches||[]).forEach(function(m){ scanMap[m.id]=m; }); });
}
function saveReview(){
  try{ localStorage.setItem(reviewKey,JSON.stringify(review)); }
  catch(e){ try{ localStorage.setItem(reviewKey,JSON.stringify(review.map(function(it){ return Object.assign({},it,{thumb:null}); }))); }catch(e2){} } // full: keep the list without photos
}
async function startCam(){
  if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.isSecureContext)){
    $('camBox').hidden=true; $('scanShot').hidden=true;
    $('scanMsg').textContent='The camera only works when this page is opened over https (your Pangolin address). You can still scan photos with "Use photos".';
    return;
  }
  try{
    scanStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});
    $('camVid').srcObject=scanStream; $('camBox').hidden=false; $('scanShot').hidden=false;
    $('camVid').addEventListener('playing',vsStart,{once:true});
    var tr=scanStream.getVideoTracks()[0], caps=tr&&tr.getCapabilities?tr.getCapabilities():{};
    $('scanTorch').hidden=!caps.torch;
  }catch(e){ $('camBox').hidden=true; $('scanShot').hidden=true; $('scanMsg').textContent='No camera access ('+e.name+'). Allow the camera for this site, or scan photos with "Use photos".'; }
}
function stopCam(){ vsStop(); if(scanStream){ scanStream.getTracks().forEach(function(t){ t.stop(); }); scanStream=null; } $('camVid').srcObject=null; }
// The camera picture as you see it in the frame (the server finds the cards on it), at most 2000 px on the longest side.
function grabFrame(){
  var v=$('camVid'); if(!v.videoWidth) return null;
  var r=visibleRect()||{x:0,y:0,w:v.videoWidth,h:v.videoHeight};
  var k=Math.min(1,2000/Math.max(r.w,r.h)), c=document.createElement('canvas'); c.width=Math.round(r.w*k); c.height=Math.round(r.h*k);
  c.getContext('2d').drawImage(v,r.x,r.y,r.w,r.h,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',0.9);
}
function toJpeg(src,W,H,max,q){
  var k=Math.min(1,max/Math.max(W,H)), c=document.createElement('canvas'); c.width=Math.round(W*k); c.height=Math.round(H*k);
  c.getContext('2d').drawImage(src,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',q);
}
function loadImg(url){ return new Promise(function(ok,fail){ var im=new Image(); im.onload=function(){ ok(im); }; im.onerror=function(){ fail(new Error('That file is not a picture')); }; im.src=url; }); }
async function photoToJpeg(file){ var u=URL.createObjectURL(file); try{ var im=await loadImg(u); return toJpeg(im,im.naturalWidth,im.naturalHeight,2000,0.9); } finally{ URL.revokeObjectURL(u); } }
async function smallThumb(data){ try{ var im=await loadImg(data); return toJpeg(im,im.naturalWidth,im.naturalHeight,240,0.7); }catch(e){ return null; } }

function queuePhoto(data){
  if(!data) return;
  scanJobs.push({n:++jobSeq,data:data,status:'waiting'});
  var box=$('camBox'); box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); // a short flash: the photo was taken
  queueStatus(); processJobs();
}
async function processJobs(){
  if(jobsRunning) return; jobsRunning=true;
  try{
    for(;;){
      var j=scanJobs.find(function(x){ return x.status==='waiting'; }); if(!j) break;
      j.status='scanning'; queueStatus();
      try{ await addResults(j,await post('api/scan',{data:j.data})); j.status='done'; }
      catch(e){
        if(e.status===401){ location.reload(); return; }
        if(e.status===429){ j.status='waiting'; queueStatus(); await sleep(2500); continue; } // the server is busy with someone else's scan
        j.status='done';
        review.push({key:'e'+Date.now()+'-'+j.n,photo:j.n,thumb:await smallThumb(j.data),matches:[],chosen:null,include:false,error:e.message});
      }
      j.data=null; saveReview(); queueStatus(); if(reviewOpen) renderReview();
    }
  } finally { jobsRunning=false; queueStatus(); }
}
async function addResults(j,r){
  var cards=r.cards||[], photoThumb=null;
  if(!cards.length||cards.some(function(c){ return !c.thumb; })) photoThumb=await smallThumb(j.data);
  if(r.aiOff&&!aiOffSaid){ aiOffSaid=true; toast('Your dex scans with the built-in reader. Ask the admin to switch on AI scanning for better results.'); }
  if(!cards.length){ review.push({key:'n'+Date.now()+'-'+j.n,photo:j.n,thumb:photoThumb,matches:[],chosen:null,include:false,note:r.aiProblem?'The AI could not be reached, the built-in reader found no card':'No card found on this photo'}); return; }
  cards.forEach(function(c,i){
    (c.matches||[]).forEach(function(m){ m.a=m.a?1:0; scanMap[m.id]=m; });
    var best=c.matches[0];
    review.push({key:'c'+Date.now()+'-'+j.n+'-'+i,photo:j.n,thumb:c.thumb||photoThumb,read:c.read,matches:c.matches,chosen:best?best.id:null,include:!!best,sure:!!(best&&best.sure),ai:r.reader==='ai'});
  });
}
function queueStatus(){
  var w=scanJobs.filter(function(x){ return x.status==='waiting'; }).length, s=scanJobs.filter(function(x){ return x.status==='scanning'; }).length;
  var toCheck=review.length, parts=[];
  if(s) parts.push('scanning a photo'); if(w) parts.push(w+' waiting');
  $('queueMsg').textContent=parts.length?parts.join(' · '):(toCheck?'All photos scanned.':'');
  $('reviewBtn').textContent='Check '+toCheck+' card'+(toCheck===1?'':'s')+' →';
  if(PILE) pileCount();
  $('reviewBtn').hidden=!toCheck&&!s&&!w;
  $('reviewBtn').disabled=!toCheck;
}

/* the check screen */
function cardFor(id){ return byId[id]||scanMap[id]||null; }
function reviewItemHTML(it){
  var c=it.chosen?cardFor(it.chosen):null, open=rvOpen===it.key;
  var state=it.error?'none':(!c?'none':(it.sure?'sure':'check'));
  var chip=it.error?'Scan failed':(!c?'No match':(it.sure?'Sure':'Check this'));
  var rd=it.read||{}, said=[rd.name?'"'+rd.name+'"':'',rd.number||''].filter(Boolean).join(' · ');
  var h='<div class="rv-item rv-'+state+'" data-key="'+esc(it.key)+'">'+
    '<div class="rv-photo">'+(it.thumb?'<img src="'+esc(it.thumb)+'" alt="Your photo">':'<div class="ph"><i class="ball"></i></div>')+'<span>Photo '+esc(it.photo||'')+'</span></div>'+
    '<div class="rv-arrow">→</div>'+
    '<div class="rv-card">'+(c?'<div class="pic">'+picHTML(c,false).replace('data-do="zoom"','data-rv="info" title="Card details and prices"')+'</div>':'<div class="pic"><div class="ph"><i class="ball"></i><span>'+esc(it.error||it.note||'No match')+'</span></div></div>')+'</div>'+
    '<div class="rv-info"><span class="rv-chip">'+chip+'</span>'+
      (c?'<b>'+esc(c.n)+'</b><span>'+esc(setName(c)||c.set||'')+' · '+esc(c.k||'')+(c.r?' · '+esc(c.r):'')+'</span>'+priceHTML(c)+(owned(c.id)?'<span class="rv-own">Already in your dex</span>':''):'')+
      (said?'<span class="rv-said">Read: '+esc(said)+(it.ai?' (AI)':'')+'</span>':'')+
    '</div>'+
    '<div class="rv-actions">'+
      (c?'<button type="button" data-rv="add" class="on">'+(owned(c.id)?'Got it, remove':'Add to my dex')+'</button>':'')+
      (c?'<button type="button" data-rv="info" data-id="'+esc(c.id)+'" title="Card details and prices">Info</button>':'')+
      '<button type="button" data-rv="chg"'+(open?' class="on"':'')+'>'+(c?'Change':'Pick card')+'</button>'+
      '<button type="button" data-rv="del" title="Remove from the list">✕</button>'+
    '</div>';
  if(open){
    var alts=(it.matches||[]).filter(function(m){ return m.id!==it.chosen; });
    h+='<div class="rv-change">'+
      (alts.length?'<div class="sec">Other suggestions <span class="rv-tip">(tap one for its details and price)</span></div><div class="rv-alts">'+alts.map(function(m){ return altHTML(cardFor(m.id)||m); }).join('')+'</div>':'')+
      '<div class="sec">Search all cards</div><input type="search" class="rv-search" placeholder="Name and/or number, e.g. toxtricity gg09" value="'+esc(rvQuery)+'">'+
      '<div class="rv-alts rv-found">'+searchHTML(rvQuery)+'</div></div>';
  }
  return h+'</div>';
}
function altHTML(c){
  return '<button type="button" class="rv-alt" data-rv="info" data-id="'+esc(c.id)+'" title="Details and price"><div class="pic">'+picHTML(c,false).replace(' data-do="zoom"','')+'</div><b>'+esc(c.n)+'</b><span>'+esc(setName(c)||c.set||'')+' · '+esc(c.k||'')+'</span></button>';
}
function searchHTML(q){
  q=String(q||'').trim().toLowerCase(); if(q.length<2) return '<p class="rv-hint">Type at least 2 letters.</p>';
  var words=q.split(/\s+/).filter(Boolean), out=[];
  var num=function(k){ return String(k||'').toLowerCase().replace(/^([a-z]*)0+(\d)/,'$1$2'); };
  for(var id in byId){
    var c=byId[id], name=cardNames(c), k=num(c.k), set=setName(c).toLowerCase();
    if(words.every(function(w){ return name.indexOf(w)>=0||k===num(w)||set.indexOf(w)>=0; })) out.push(c);
    if(out.length>=400) break;
  }
  out.sort(function(a,b){ return String(setDate(b)).localeCompare(String(setDate(a))); });
  return out.length?out.slice(0,24).map(altHTML).join('')+(out.length>24?'<p class="rv-hint">'+out.length+' found: type more to narrow it down.</p>':''):'<p class="rv-hint">No card found.</p>';
}
function renderReview(){
  var add=review.filter(function(it){ return it.chosen; }).length, check=review.filter(function(it){ return it.chosen&&!it.sure; }).length;
  $('rvHead').textContent=review.length?(review.length+' scanned card'+(review.length===1?'':'s')+(check?' · '+check+' to check':'')):'Nothing scanned yet.';
  $('rvAdd').textContent=add>1?'Add all '+add+' to my dex':'Add '+add+' to my dex'; $('rvAdd').disabled=!add;
  $('rvClear').hidden=!review.length;
  var scroll=$('rvList').scrollTop;
  $('rvList').innerHTML=review.length?review.slice().reverse().map(reviewItemHTML).join(''):'<p class="rv-hint">Take photos with the lens; the cards found appear here to check.</p>';
  $('rvList').scrollTop=scroll;
}
function showReview(on){
  reviewOpen=on; $('scanCam').hidden=on; $('scanReview').hidden=!on;
  if(on){ stopCam(); renderReview(); } else startCam();
}
$('rvList').addEventListener('click',function(e){
  var b=e.target.closest('[data-rv]'); if(!b) return;
  var row=b.closest('.rv-item'), it=row&&review.find(function(x){ return x.key===row.dataset.key; }); if(!it) return;
  var a=b.dataset.rv;
  if(a==='add'){ // this one card: into the dex now, off the list
    var had=owned(it.chosen), cn=(cardFor(it.chosen)||{}).n||'Card';
    if(!had) st.cards[it.chosen]=1;
    review=review.filter(function(x){ return x!==it; }); if(rvOpen===it.key) rvOpen=null;
    if(!had){ save(); refresh(); }
    var m=had?cn+' was already in your dex.':cn+' added to your dex.';
    $('rvMsg').textContent=m; toast(m);
  }
  else if(a==='chg'){ rvOpen=rvOpen===it.key?null:it.key; rvQuery=''; }
  else if(a==='del'){ review=review.filter(function(x){ return x!==it; }); if(rvOpen===it.key) rvOpen=null; }
  else if(a==='info'){ openInfo(b.dataset.id||it.chosen,it.key); return; }
  else if(a==='pick'){ it.chosen=b.dataset.id; it.include=true; it.sure=true; it.picked=true; it.error=null; rvOpen=null; } // picked by hand: counts as sure
  saveReview(); renderReview(); queueStatus();
});
$('rvList').addEventListener('input',function(e){
  if(!e.target.classList.contains('rv-search')) return;
  rvQuery=e.target.value; var box=e.target.parentNode.querySelector('.rv-found'); if(box) box.innerHTML=searchHTML(rvQuery);
});
$('rvAdd').addEventListener('click',function(){
  var n=0, had=0;
  review.forEach(function(it){ if(it.chosen){ if(owned(it.chosen)) had++; else { st.cards[it.chosen]=1; n++; } it.done=true; } });
  review=review.filter(function(it){ return !it.done; });
  save(); saveReview(); refresh(); renderReview(); queueStatus();
  var m=n+' card'+(n===1?'':'s')+' added to your dex'+(had?' ('+had+' you already had)':'')+'.';
  $('rvMsg').textContent=m; toast(m);
});
$('rvClear').addEventListener('click',function(){
  if(!$('rvClear').classList.contains('arm')){ $('rvClear').classList.add('arm'); $('rvClear').textContent='Really clear the list?'; setTimeout(function(){ $('rvClear').classList.remove('arm'); $('rvClear').textContent='Clear list'; },4000); return; }
  review=[]; rvOpen=null; saveReview(); renderReview(); queueStatus();
});
$('reviewBtn').addEventListener('click',function(){ showReview(true); });
$('rvBack').addEventListener('click',function(){ $('rvMsg').textContent=''; showReview(false); });

function openScanner(){
  loadReview(); rvOpen=null;
  $('scanMsg').textContent=vs.on?'Hold one or more cards in the frame, straight on and without glare: the photo is taken by itself when they stand still. Then show the next card or turn the page.':'Hold one or more cards in view, straight on and without glare, and tap the lens. Keep going: photos are scanned in the background.';
  $('scandlg').showModal(); showReview(false); queueStatus();
}
if(AUTH){ // your own dex: the lens is the camera button
  var lensCam=document.querySelector('.lens');
  lensCam.classList.add('scan'); lensCam.removeAttribute('aria-hidden'); lensCam.setAttribute('role','button'); lensCam.setAttribute('tabindex','0');
  lensCam.setAttribute('aria-label','Scan cards'); lensCam.title='Scan cards with the camera';
  lensCam.addEventListener('click',openScanner);
  lensCam.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openScanner(); } });
}
$('scanClose').addEventListener('click',function(){ $('scandlg').close(); });
$('scandlg').addEventListener('close',function(){ stopCam(); reviewOpen=false; });
$('scanShot').addEventListener('click',function(){
  queuePhoto(grabFrame());
  if(PILE&&vs.ready){ // the app: the cards on this photo fly to the pile too
    var r=visibleRect(); if(!r) return;
    var W=360, H=Math.round(W*r.h/r.w), c=document.createElement('canvas'); c.width=W; c.height=H;
    var g=c.getContext('2d',{willReadFrequently:true}); g.drawImage($('camVid'),r.x,r.y,r.w,r.h,0,0,W,H);
    try{ var groups=cardfind.findCards(window.cv,g.getImageData(0,0,W,H).data,W,H,12); flyToPile(groups.map(function(x){ return x[0]; }),W,H); }catch(e){}
  }
});
$('scanFile').addEventListener('change',async function(){
  var files=[].slice.call($('scanFile').files); $('scanFile').value='';
  for(var i=0;i<files.length;i++){ try{ queuePhoto(await photoToJpeg(files[i])); }catch(e){ $('scanMsg').textContent=e.message; } }
});
$('scanTorch').addEventListener('click',function(){
  var tr=scanStream&&scanStream.getVideoTracks()[0]; if(!tr) return;
  var on=!$('scanTorch').classList.contains('on');
  tr.applyConstraints({advanced:[{torch:on}]}).then(function(){ $('scanTorch').classList.toggle('on',on); $('scanTorch').textContent=on?'Light off':'Light'; }).catch(function(){});
});

/* ---------- video scan: the phone finds the cards in the live camera picture and takes the photo itself ---------- */
// The same card finder as the server (cardfind.js, with OpenCV) runs on a small copy of the camera picture about
// 8 times a second. When the cards stand still and the picture is sharp, the photo is taken by itself; then the
// scanner waits until the view changes (a new card, a turned page, cards taken away) before it takes the next one.
var vs={on:true,ready:false,loading:null,timer:null,prev:null,stableSince:0,sharpMax:0,armed:true,sig:null,goneSince:0,diffRun:0,shots:0};
try{ vs.on=localStorage.getItem('dexVideoScan')!=='0'; }catch(e){}
function vsSay(t){ $('vsMsg').textContent=t; }
function vsButton(){ $('scanAuto').classList.toggle('on',vs.on); $('scanAuto').textContent=vs.on?'Video scan: on':'Video scan: off'; $('scanAuto').setAttribute('aria-pressed',vs.on?'true':'false'); }
function loadFinder(){ // OpenCV (about 11 MB, kept by the phone after the first time) and the card finder
  if(vs.loading) return vs.loading;
  vs.loading=new Promise(function(ok,fail){
    function add(src){ return new Promise(function(o,f){ var s=document.createElement('script'); s.src=src; s.async=true; s.onload=o; s.onerror=function(){ f(new Error('could not load '+src)); }; document.head.appendChild(s); }); }
    add('cardfind.js').then(function(){ return add('vendor/opencv.js?v=4.12.0'); }).then(function(){
      var t0=Date.now();
      (function wait(){ // OpenCV starts up after loading; it is ready when its functions exist
        var cv=window.cv; if(cv&&typeof cv.Mat==='function'&&typeof cv.Canny==='function'){ vs.ready=true; ok(); return; }
        if(Date.now()-t0>60000){ fail(new Error('the card finder did not start')); return; }
        setTimeout(wait,100);
      })();
    }).catch(fail);
  });
  vs.loading.catch(function(){ vs.loading=null; });
  return vs.loading;
}
// The part of the camera picture you see in the (card-shaped) frame: the video is shown "cover", so its sides are cut off.
function visibleRect(){
  var v=$('camVid'), b=$('camBox'), vw=v.videoWidth, vh=v.videoHeight, bw=b.clientWidth, bh=b.clientHeight;
  if(!vw||!vh||!bw||!bh) return null;
  var k=Math.max(bw/vw,bh/vh), w=bw/k, h=bh/k;
  return {x:(vw-w)/2,y:(vh-h)/2,w:w,h:h};
}
var vsCan=document.createElement('canvas'), vsCtx=null;
function vsTick(){
  if(!vs.on||!vs.ready||!scanStream||!$('scandlg').open||reviewOpen||document.hidden) return clearOverlay();
  var r=visibleRect(); if(!r) return;
  var W=360, H=Math.round(W*r.h/r.w);
  if(vsCan.width!==W||vsCan.height!==H){ vsCan.width=W; vsCan.height=H; vsCtx=vsCan.getContext('2d',{willReadFrequently:true}); }
  vsCtx.drawImage($('camVid'),r.x,r.y,r.w,r.h,0,0,W,H);
  var img=vsCtx.getImageData(0,0,W,H), groups;
  try{ groups=cardfind.findCards(window.cv,img.data,W,H,12); }catch(e){ return; }
  var quads=vsTrack(groups.map(function(g){ return g[0]; }),W,H), now=Date.now();
  drawOverlay(vs.tracks.filter(function(t){ return t.hits>=3&&t.miss<=2; }).map(function(t){ return t.q; }),W,H);
  // waiting for a change after a photo: the cards went away, their number changed, or what is inside them changed
  if(!vs.armed){
    // (cards that were out of sight for a moment and come back the same are the same page: no second photo of them)
    if(!quads.length){ if(!vs.goneSince) vs.goneSince=now; if(now-vs.goneSince>6000) vsArm(); }
    else { vs.goneSince=0;
      // new cards: cards that look like none of the photographed ones (a turned page, a swapped card), for a few frames;
      // a card more or less that the finder sees on the same page does not count
      var sig=vsSig(img,quads,W,H);
      vs.diffRun=vsFresh(sig)?vs.diffRun+1:0;
      if(vs.diffRun>=3) vsArm();
    }
    if(!vs.armed){ vsSay('Got it. Show the next card or turn the page.'); return; }
  }
  if(!quads.length){ vs.prev=null; vs.stableSince=0; vs.sharpMax=0; vsSay(vs.shots?'Looking for the next card…':'Hold one or more cards in the frame.'); return; }
  // standing still: the cards followed from the last frame hardly moved (the middle one of them, so one card that the
  // finder sees a bit differently does not count; the photo is of the whole frame, so a card more or less does not matter)
  var mv=vs.tracks.filter(function(t){ return t.hits>=3&&t.mv!=null; }).map(function(t){ return t.mv; }).sort(function(a,b){ return a-b; });
  var still=mv.length>0&&mv[Math.floor(mv.length/2)]<0.02;
  if(!still){ vs.stableSince=now; vs.sharpMax=0; vsSay(pl(quads.length,'card')+' found · hold still'); return; }
  var sharp=sharpness(img,quads,W,H); vs.sharpMax=Math.max(vs.sharpMax,sharp);
  var waiting=scanJobs.filter(function(x){ return x.status!=='done'; }).length;
  if(waiting>=4){ vsSay('Waiting for the scanner to catch up…'); return; }
  if(now-vs.stableSince>=600&&sharp>=vs.sharpMax*0.85){
    var sg=vsSig(img,quads,W,H);
    if(!vsFresh(sg)){ vs.armed=false; vs.sig=sg; vs.goneSince=0; vs.diffRun=0; vsSay('Got it. Show the next card or turn the page.'); return; } // photographed just before
    vs.shots++; vs.armed=false; vs.sig=sg; vs.goneSince=0; vs.diffRun=0;
    vs.recent=(vs.recent||[]).concat([sg.v]).slice(-4);
    if(navigator.vibrate) try{ navigator.vibrate(35); }catch(e){}
    queuePhoto(grabFrame());
    drawOverlay(quads,W,H,true);
    flyToPile(quads,W,H);
  } else vsSay(pl(quads.length,'card')+' found · hold still');
}
// Following the cards from frame to frame: a card counts once it was seen in 3 frames in a row, and stays drawn when
// one or two frames miss it, so the outlines do not flicker. The drawn outline is smoothed; the photo uses the last real one.
function vsTrack(found,W,H){
  var tracks=vs.tracks||(vs.tracks=[]), used=[];
  tracks.forEach(function(t){
    var best=-1, bd=0.05;
    found.forEach(function(q,i){ if(used.indexOf(i)<0){ var d=moved(q,t.raw,W,H); if(d<bd){ bd=d; best=i; } } });
    if(best<0){ t.miss++; t.mv=null; return; }
    used.push(best); var q=found[best];
    t.mv=bd; t.raw=q; t.hits++; t.miss=0; // mv: how far it moved since the last frame
    t.q={area:q.area,pts:q.pts.map(function(p,i){ var o=t.q.pts[i]; return {x:o.x*0.5+p.x*0.5,y:o.y*0.5+p.y*0.5}; })};
  });
  found.forEach(function(q,i){ if(used.indexOf(i)<0) tracks.push({raw:q,q:q,hits:1,miss:0}); });
  vs.tracks=tracks.filter(function(t){ return t.miss<=(t.hits>=3?2:0); });
  return vs.tracks.filter(function(t){ return t.hits>=3&&t.miss<=1; }).map(function(t){ return t.raw; }); // the cards to photograph
}
// new cards: at least a quarter of the cards look like none of the cards on the last 4 photos (a turned page, a swapped
// card); the same page seen again after the camera moved closer or away, or a card more or less, does not count
function vsFresh(sig){
  var seen=[].concat.apply([],vs.recent||[]);
  var fresh=sig.v.filter(function(c){ return !seen.some(function(o){ return sigDiff(c,o)<16; }); }).length;
  return fresh>=Math.max(1,Math.ceil(sig.v.length*0.25));
}
function vsArm(){ vs.armed=true; vs.sig=null; vs.prev=null; vs.nRun=0; vs.stableSince=0; vs.sharpMax=0; vs.diffRun=0; vs.goneSince=0; }
function center(q){ var x=0,y=0; q.pts.forEach(function(p){ x+=p.x; y+=p.y; }); return {x:x/4,y:y/4}; }
function moved(a,b,W,H){ var ca=center(a), cb=center(b); return Math.max(Math.abs(ca.x-cb.x)/W,Math.abs(ca.y-cb.y)/H,Math.abs(Math.sqrt(a.area)-Math.sqrt(b.area))/Math.sqrt(W*H)); }
function qbox(q,W,H){ var xs=q.pts.map(function(p){ return p.x; }), ys=q.pts.map(function(p){ return p.y; });
  return {x0:Math.max(0,Math.floor(Math.min.apply(null,xs))),x1:Math.min(W-1,Math.ceil(Math.max.apply(null,xs))),y0:Math.max(0,Math.floor(Math.min.apply(null,ys))),y1:Math.min(H-1,Math.ceil(Math.max.apply(null,ys)))}; }
// sharpness: how much the brightness changes from pixel to pixel inside the cards (a blurry picture changes slowly)
function sharpness(img,quads,W,H){
  var d=img.data, sum=0, n=0;
  quads.forEach(function(q){ var b=qbox(q,W,H); for(var y=b.y0+1;y<b.y1;y+=2) for(var x=b.x0+1;x<b.x1;x+=2){ var i=(y*W+x)*4, j=i-4, k=i-W*4;
    var g=d[i]+d[i+1]+d[i+2]; sum+=Math.abs(g-(d[j]+d[j+1]+d[j+2]))+Math.abs(g-(d[k]+d[k+1]+d[k+2])); n++; } });
  return n?sum/n:0;
}
// what is inside each card, very small (4 x 6 squares, the average colour of each): to see that the cards are other cards
// (averages, so the shine of a holo card or a little movement hardly changes it)
function vsSig(img,quads,W,H){
  var d=img.data;
  return {n:quads.length,v:quads.map(function(q){
    var b=qbox(q,W,H), cw=(b.x1-b.x0)/4, ch=(b.y1-b.y0)/6, out=[];
    for(var gy=0;gy<6;gy++) for(var gx=0;gx<4;gx++){
      var r=0,g=0,bl=0,n=0, x0=Math.floor(b.x0+gx*cw+cw*0.15), x1=Math.floor(b.x0+(gx+1)*cw-cw*0.15), y0=Math.floor(b.y0+gy*ch+ch*0.15), y1=Math.floor(b.y0+(gy+1)*ch-ch*0.15);
      for(var y=y0;y<y1;y+=2) for(var x=x0;x<x1;x+=2){ var i=(y*W+x)*4; r+=d[i]; g+=d[i+1]; bl+=d[i+2]; n++; }
      out.push(n?r/n:0,n?g/n:0,n?bl/n:0);
    }
    return out; })};
}
function sigDiff(a,b){ var s=0; for(var i=0;i<a.length;i++) s+=Math.abs(a[i]-b[i]); return a.length?s/a.length:0; }
function drawOverlay(quads,W,H,shot){
  var c=$('camOv'), bw=c.clientWidth, bh=c.clientHeight;
  if(c.width!==bw||c.height!==bh){ c.width=bw; c.height=bh; }
  var g=c.getContext('2d'); g.clearRect(0,0,bw,bh);
  var kx=bw/W, ky=bh/H, col=shot||!vs.armed?'#3ddc84':'#ffd23f';
  g.lineWidth=3; g.strokeStyle=col; g.fillStyle=shot?'#3ddc8433':'transparent';
  quads.forEach(function(q){ g.beginPath(); q.pts.forEach(function(p,i){ var x=p.x*kx, y=p.y*ky; if(i) g.lineTo(x,y); else g.moveTo(x,y); }); g.closePath(); g.stroke(); if(shot) g.fill(); });
}
function clearOverlay(){ var c=$('camOv'); if(c.width) c.getContext('2d').clearRect(0,0,c.width,c.height); }
function vsStart(){
  vsButton(); $('camBox').classList.toggle('vs',vs.on); $('camOv').hidden=!vs.on;
  if(!vs.on){ vsStop(); vsSay(''); return; }
  if(!scanStream) return;
  if(!vs.ready) vsSay('Starting the card finder… (the first time it downloads about 3.5 MB)');
  loadFinder().then(function(){ vsArm(); if(!vs.timer) vs.timer=setInterval(vsTick,120); })
    .catch(function(e){ vsSay('The video scan could not start ('+e.message+'). Tap the lens button to take photos.'); });
}
function vsStop(){ if(vs.timer){ clearInterval(vs.timer); vs.timer=null; } vs.tracks=null; vs.recent=null; clearOverlay(); }
$('scanAuto').addEventListener('click',function(){ vs.on=!vs.on; try{ localStorage.setItem('dexVideoScan',vs.on?'1':'0'); }catch(e){} vsStart(); });

/* ---------- the app: found cards fly into the "processing" pile ---------- */
// Only inside the Android app: when a photo is taken, every card found is cut out of the picture (straightened) and
// flies from where it was in the camera view into the pile next to the Check button, where it waits for your check.
var PILE=APP;
var pileCards=[]; // the last few cut-out cards on the pile
if(PILE){
  $('pile').hidden=false;
  $('pile').addEventListener('click',function(){ if(review.length) showReview(true); });
}
function pileCount(){ // cards still being scanned (photos in the queue) and cards waiting for the check
  var busy=scanJobs.filter(function(x){ return x.status!=='done'; }).length;
  $('pileN').textContent=review.length+(busy?' +'+busy:'');
  $('pile').classList.toggle('busy',!!busy);
  $('pile').title=busy?'Scanning '+pl(busy,'photo')+' · '+review.length+' to check':review.length+' to check';
}
// cut a card out of the visible camera picture, straightened (OpenCV), as a small canvas
function cutCard(q,W,H){
  var r=visibleRect(); if(!r||!window.cv||!vs.ready) return null;
  var cv=window.cv, CW=560, CH=Math.round(CW*r.h/r.w), big=document.createElement('canvas'); big.width=CW; big.height=CH;
  big.getContext('2d').drawImage($('camVid'),r.x,r.y,r.w,r.h,0,0,CW,CH);
  var k=CW/W, p=q.pts; if(q.landscape) p=[p[3],p[0],p[1],p[2]];
  var src=null, dst=null, a=null, b=null, M=null, out=document.createElement('canvas');
  try{
    src=cv.imread(big); dst=new cv.Mat();
    a=cv.matFromArray(4,1,cv.CV_32FC2,[p[0].x*k,p[0].y*k,p[1].x*k,p[1].y*k,p[2].x*k,p[2].y*k,p[3].x*k,p[3].y*k]);
    b=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,140,0,140,196,0,196]);
    M=cv.getPerspectiveTransform(a,b); cv.warpPerspective(src,dst,M,new cv.Size(140,196));
    cv.imshow(out,dst); return out;
  }catch(e){ return null; }
  finally{ [src,dst,a,b,M].forEach(function(m){ if(m) try{ m.delete(); }catch(x){} }); }
}
function flyToPile(quads,W,H){
  if(!PILE||!quads||!quads.length) return;
  var box=$('camBox').getBoundingClientRect(), pile=$('pile').getBoundingClientRect(), calm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  quads.forEach(function(q,i){
    var c=cutCard(q,W,H); if(!c) return;
    var xs=q.pts.map(function(p){ return p.x; }), ys=q.pts.map(function(p){ return p.y; });
    var x0=box.left+Math.min.apply(null,xs)/W*box.width, y0=box.top+Math.min.apply(null,ys)/H*box.height;
    var w0=(Math.max.apply(null,xs)-Math.min.apply(null,xs))/W*box.width, h0=w0/0.714;
    var url=c.toDataURL('image/jpeg',0.8);
    var fly=document.createElement('img'); fly.className='flycard'; fly.src=url; fly.alt='';
    fly.style.left=x0+'px'; fly.style.top=y0+'px'; fly.style.width=w0+'px'; fly.style.height=h0+'px';
    $('flyLayer').appendChild(fly);
    var tx=pile.left+pile.width/2-(x0+w0/2), ty=pile.top+pile.height/2-(y0+h0/2), sc=Math.max(0.12,30/w0), rot=(Math.random()*24-12);
    var done=function(){ fly.remove(); addToPile(url,rot); };
    if(calm||!fly.animate){ done(); return; }
    fly.animate([
      {transform:'translate(0,0) scale(1) rotate(0deg)',opacity:1},
      {transform:'translate(0,-14px) scale(1.06) rotate(0deg)',opacity:1,offset:0.18},  // lifts off the table
      {transform:'translate('+tx+'px,'+ty+'px) scale('+sc+') rotate('+rot+'deg)',opacity:0.9}
    ],{duration:650,delay:i*90,easing:'cubic-bezier(.45,0,.2,1)',fill:'forwards'}).onfinish=done;
  });
}
function addToPile(url,rot){
  pileCards.push({url:url,rot:rot}); if(pileCards.length>3) pileCards.shift();
  $('pileStack').innerHTML=pileCards.map(function(p,i){ return '<img src="'+p.url+'" alt="" style="transform:rotate('+p.rot.toFixed(1)+'deg);z-index:'+i+'">'; }).join('');
  var el=$('pile'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  pileCount();
}

/* ---------- installable app ---------- */
if('serviceWorker' in navigator&&window.isSecureContext){ navigator.serviceWorker.register('sw.js').catch(function(){}); }
var installEvt=null;
window.addEventListener('beforeinstallprompt',function(e){ e.preventDefault(); installEvt=e; $('installBtn').hidden=false; });
window.addEventListener('appinstalled',function(){ installEvt=null; $('installBtn').hidden=true; });
$('installBtn').addEventListener('click',function(){ if(!installEvt) return; installEvt.prompt(); installEvt.userChoice.then(function(){ installEvt=null; $('installBtn').hidden=true; }); });
// The Android app download: for everyone, logged in or not, on every device except iPhones/iPads and the app itself
if(window.DEX_APK&&!APP&&!/iPhone|iPad|iPod/i.test(navigator.userAgent)){
  var onAndroid=/Android/i.test(navigator.userAgent);
  $('apkBtn').hidden=false;
  $('apkBtn').addEventListener('click',function(){
    toast(onAndroid?'Downloading the app… Open the file when it is done. Android may ask you to allow installing apps from your browser.'
      :'Downloading the Android app. Easiest: open this page on your Android phone and tap "Android app" there.');
    location.href='android.apk';
  });
}
$('logoutBtn').addEventListener('click',async function(){ try{ await post('api/logout'); }catch(e){} location.reload(); });

/* ---------- dex picker, trainer name, accounts ---------- */
function dexUrl(id){ return location.pathname+'?dex='+encodeURIComponent(id)+location.hash; }
function fillDexSel(){
  var h=CFG.accounts.map(function(a){ return '<option value="'+esc(a.id)+'">'+esc(a.name)+(ME&&ME.id===a.id?' (you)':'')+'</option>'; });
  if(ADMIN) h.push('<option disabled>──────────</option><option value="__add">+ Add account…</option><option value="__manage">Manage accounts…</option>');
  $('dexSel').innerHTML=h.join(''); $('dexSel').value=DEX;
}
fillDexSel();
if(ADMIN){ $('meTag').hidden=false; $('meTag').innerHTML='Logged in as admin · <a href="#/admin">settings</a>'; }
else if(ME&&ME.id!==DEX){ $('meTag').hidden=false; $('meTag').innerHTML='Logged in as '+esc(ME.name)+' · <a href="'+esc(dexUrl(ME.id))+'">your dex</a>'; }
$('dexSel').addEventListener('change',function(){
  var v=$('dexSel').value;
  if(v==='__add'||v==='__manage'){ $('dexSel').value=DEX; openAccounts(v==='__add'); return; }
  if(v!==DEX) location.href=dexUrl(v);
});
$('nameBtn').addEventListener('click',function(){ $('nameIn').value=ME?ME.name:''; $('nameMsg').textContent=''; $('namedlg').showModal(); $('nameIn').focus(); });
$('nameClose').addEventListener('click',function(){ $('namedlg').close(); });
$('pwBtn').addEventListener('click',function(){ ['pwOld','pwNew','pwNew2'].forEach(function(i){ $(i).value=''; }); $('pwMsg').textContent=''; $('pwdlg').showModal(); $('pwOld').focus(); });
$('pwClose').addEventListener('click',function(){ $('pwdlg').close(); });
var picId=null, picData=null, picSet=false; // picSet: the picture is for a set (its logo), not a card
function openPic(id,isSet){
  var c=isSet?null:lookup(id); picId=id; picSet=!!isSet;
  $('picTitle').textContent=isSet?'Set picture · '+((setsById[id]||{}).name||id):'Picture · '+(c?c.n+' · '+subOf(c):id);
  $('picUrl').value=''; $('picFile').value=''; picData=null; $('picMsg').textContent=''; showPrev();
  $('picdlg').showModal(); $('picUrl').focus();
}
function showPrev(){
  var u=picData||$('picUrl').value.trim();
  $('picPrev').hidden=!(picData||/^https:\/\//.test(u)); if(!$('picPrev').hidden) $('picPrev').src=u;
}
$('picUrl').addEventListener('input',function(){ picData=null; $('picFile').value=''; showPrev(); });
$('picFile').addEventListener('change',function(){
  var f=$('picFile').files[0]; picData=null; $('picMsg').textContent='';
  if(!f){ showPrev(); return; }
  if(f.size>15*1024*1024){ $('picFile').value=''; $('picMsg').textContent='That file is larger than 15 MB.'; return; }
  var rd=new FileReader();
  rd.onload=function(){ picData=String(rd.result); $('picUrl').value=''; showPrev(); };
  rd.readAsDataURL(f);
});
$('picPrev').addEventListener('error',function(){ $('picPrev').hidden=true; $('picMsg').textContent='That address does not show a picture here.'; });
$('picPrev').addEventListener('load',function(){ $('picMsg').textContent=''; });
$('picClose').addEventListener('click',function(){ $('picdlg').close(); });
$('picForm').addEventListener('submit',async function(e){
  e.preventDefault(); $('picMsg').textContent='…';
  $('picMsg').textContent=picData||$('picUrl').value.trim()?'Downloading and storing the picture…':'…';
  try{ await post(picSet?'api/set/picture':'api/card/picture',picData?{id:picId,data:picData}:{id:picId,url:$('picUrl').value.trim()}); }
  catch(err){ if(err.status===401){ location.reload(); return; } $('picMsg').textContent=err.message; return; }
  $('picdlg').close();
  await loadData(); index();
  if(curSet){ delete setCache[curSet]; await openSet(curSet,true); }
  refresh();
});
$('pwForm').addEventListener('submit',async function(e){
  e.preventDefault();
  if($('pwNew').value!==$('pwNew2').value){ $('pwMsg').textContent='The two new passwords are not the same.'; return; }
  $('pwMsg').textContent='…';
  try{ await post('api/account/password',{old:$('pwOld').value,password:$('pwNew').value}); ['pwOld','pwNew','pwNew2'].forEach(function(i){ $(i).value=''; }); $('pwMsg').textContent='Password changed. Other devices are logged out.'; }
  catch(err){ if(err.status===401&&/login required/.test(err.message)){ location.reload(); return; } $('pwMsg').textContent=err.message; }
});
$('nameForm').addEventListener('submit',async function(e){
  e.preventDefault(); $('nameMsg').textContent='…';
  try{ await post('api/account/name',{name:$('nameIn').value}); location.reload(); }
  catch(err){ if(err.status===401){ location.reload(); return; } $('nameMsg').textContent=err.message; }
});
var accDirty=false, accArmed=null, aiOffSaid=false;
function accSay(html){ $('accMsg').innerHTML=html; }
async function loadAccounts(){
  var r, list;
  try{ r=await getJSON('api/admin/accounts'); }catch(e){ accSay(esc(e.message)); return; }
  list=Array.isArray(r)?r:r.list; var aiSetUp=!Array.isArray(r)&&r.aiSetUp;
  $('accList').innerHTML=list.map(function(a){
    var del=accArmed&&accArmed.key==='del:'+a.id&&Date.now()-accArmed.t<4000;
    return '<div class="accrow"><b>'+esc(a.name)+'</b>'+
      ('<span>'+(a.self?'signed up ':'added ')+esc(new Date(a.created).toLocaleDateString())+'</span>'+
      (aiSetUp?'<button type="button" class="mini'+(a.ai?' on':'')+'" data-acc="ai" data-on="'+(a.ai?1:0)+'" data-id="'+esc(a.id)+'" data-name="'+esc(a.name)+'" title="May this trainer\'s scans use the AI reader (it costs money per scan)?">AI scanning: '+(a.ai?'on':'off')+'</button>':'')+
      '<button type="button" class="mini" data-acc="pw" data-id="'+esc(a.id)+'" data-name="'+esc(a.name)+'">New password</button>'+
      '<button type="button" class="mini'+(del?' arm':'')+'" data-acc="del" data-id="'+esc(a.id)+'" data-name="'+esc(a.name)+'">'+(del?'Really delete?':'Delete')+'</button>')+
      '<a class="mini" href="'+esc(dexUrl(a.id))+'">open dex</a></div>';
  }).join('');
}
function openAccounts(add){
  accSay(''); $('accName').value=''; $('accPw').value='';
  $('accdlg').showModal(); loadAccounts();
  if(add) $('accName').focus();
}
$('accClose').addEventListener('click',function(){ $('accdlg').close(); });
$('accdlg').addEventListener('close',function(){ if(accDirty) location.reload(); });
$('accForm').addEventListener('submit',async function(e){
  e.preventDefault(); accSay('…');
  try{
    var r=await post('api/admin/accounts',{name:$('accName').value,password:$('accPw').value});
    accDirty=true; $('accName').value=''; $('accPw').value='';
    accSay('Added <b>'+esc(r.name)+'</b>. Password: <span class="pwshow">'+esc(r.password)+'</span> (write it down, it is not shown again).');
    loadAccounts();
  }catch(err){ accSay(esc(err.message)); }
});
$('accList').addEventListener('click',async function(e){
  var b=e.target.closest('[data-acc]'); if(!b) return;
  var id=b.dataset.id, nm=b.dataset.name;
  if(b.dataset.acc==='del'){
    if(!(accArmed&&accArmed.key==='del:'+id&&Date.now()-accArmed.t<4000)){ accArmed={key:'del:'+id,t:Date.now()}; loadAccounts(); setTimeout(loadAccounts,4100); return; }
    accArmed=null;
    try{ await post('api/admin/accounts/delete',{id:id}); accDirty=true; accSay('Deleted <b>'+esc(nm)+'</b>.'); }catch(err){ accSay(esc(err.message)); }
    loadAccounts();
  } else if(b.dataset.acc==='ai'){
    var on=b.dataset.on!=='1';
    try{ await post('api/admin/accounts/ai',{id:id,on:on}); accSay('AI scanning is now <b>'+(on?'on':'off')+'</b> for <b>'+esc(nm)+'</b>.'); }catch(err){ accSay(esc(err.message)); }
    loadAccounts();
  } else if(b.dataset.acc==='pw'){
    try{ var r=await post('api/admin/accounts/password',{id:id}); accSay('New password for <b>'+esc(nm)+'</b>: <span class="pwshow">'+esc(r.password)+'</span> (they are logged out everywhere).'); }
    catch(err){ accSay(esc(err.message)); }
  }
});
$('exp').addEventListener('click',function(){
  var b=$('bk'); b.hidden=false; b.value=JSON.stringify(st); b.select();
});
$('imp').addEventListener('click',function(){
  var b=$('bk');
  if(b.hidden){ b.hidden=false; b.value=''; b.placeholder='Paste backup text here, then press Restore again'; return; }
  try{
    var j=JSON.parse(b.value);
    if(j&&j.own){ st=normState(j); save(); index(); render(); b.value=''; b.hidden=true; }
  }catch(e){ b.value='That text could not be read as a backup.'; }
});

/* ---------- the admin page: settings (dropdowns) and trainers ---------- */
var setInfo=null, setDirty={};
if(ADMIN){
  $('viewSel').insertAdjacentHTML('beforeend','<option value="admin">Admin settings</option>');
  var lensAdm=document.querySelector('.lens');
  lensAdm.removeAttribute('aria-hidden'); lensAdm.setAttribute('role','button'); lensAdm.setAttribute('tabindex','0');
  lensAdm.setAttribute('aria-label','Admin settings'); lensAdm.title='Admin settings'; lensAdm.style.cursor='pointer';
  lensAdm.addEventListener('click',function(){ go('#/admin'); });
  lensAdm.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go('#/admin'); } });
}
function optLabel(f,v){ var o=(f.options||[]).filter(function(x){ return x[0]===v; })[0]; return o?o[1]:v; }
function defaultText(f){
  if(f.type==='secret') return '';
  return 'Default · '+(f.container!=null?optLabel(f,f.container)+' (container)':optLabel(f,f.def||''));
}
function aiService(){ // the service chosen on the page now, else the container's, else none
  var sel=document.querySelector('#adminView [data-key="SCAN_AI"]');
  var v=sel?sel.value:'';
  if(!sel){ var f0=setInfo&&setInfo.fields.filter(function(x){ return x.key==='SCAN_AI'; })[0]; v=f0&&f0.value?f0.value:''; } // while the page is being built
  if(!v){ var f=setInfo&&setInfo.fields.filter(function(x){ return x.key==='SCAN_AI'; })[0]; v=f&&f.container?f.container:'none'; }
  return ({gpt:'openai',chatgpt:'openai',anthropic:'claude',google:'gemini',ollama:'local',llama:'local',lmstudio:'local'})[v]||v;
}
function modelOptions(f,cur){
  var list=(setInfo.models[aiService()]||[]).slice(), h=['<option value="">'+esc(defaultText(f))+'</option>'];
  if(f.none) h.push('<option value="none"'+(cur==='none'?' selected':'')+'>None</option>');
  list.forEach(function(m){ h.push('<option value="'+esc(m)+'"'+(cur===m?' selected':'')+'>'+esc(m)+'</option>'); });
  var other=cur&&cur!=='none'&&list.indexOf(cur)<0;
  h.push('<option value="__other"'+(other?' selected':'')+'>Other…</option>');
  return h.join('');
}
function fieldHTML(f){
  var h='<div class="setrow" data-row="'+esc(f.key)+'"><label for="set_'+esc(f.key)+'">'+esc(f.label)+'</label>';
  if(f.options){
    h+='<select id="set_'+esc(f.key)+'" data-key="'+esc(f.key)+'"><option value="">'+esc(defaultText(f))+'</option>'+
      f.options.map(function(o){ return '<option value="'+esc(o[0])+'"'+(f.value===o[0]?' selected':'')+'>'+esc(o[1])+'</option>'; }).join('')+'</select>';
  } else if(f.type==='model'){
    var other=f.value&&f.value!=='none'&&(setInfo.models[aiService()]||[]).indexOf(f.value)<0;
    h+='<div class="sub"><select id="set_'+esc(f.key)+'" data-key="'+esc(f.key)+'" data-model="1">'+modelOptions(f,f.value)+'</select>'+
      '<input type="text" data-other="'+esc(f.key)+'" placeholder="Model name, exactly as the service writes it" value="'+esc(other?f.value:'')+'"'+(other?'':' hidden')+' autocomplete="off" spellcheck="false"></div>';
  } else if(f.type==='secret'){
    h+='<div class="sub"><span class="keyst">'+(f.set?'A key is saved on this page.':(f.container?'The container has a key; none saved on this page.':'No key saved.'))+'</span>'+
      '<input type="password" id="set_'+esc(f.key)+'" data-secret="'+esc(f.key)+'" placeholder="'+(f.set?'New key (leave empty to keep it)':'Paste the key')+'" autocomplete="off">'+
      (f.set?'<label class="keyst"><input type="checkbox" data-clear="'+esc(f.key)+'" style="width:auto"> Remove the saved key</label>':'')+'</div>';
  } else {
    h+='<input type="url" id="set_'+esc(f.key)+'" data-key="'+esc(f.key)+'" value="'+esc(f.value||'')+'" placeholder="'+esc(f.container?f.container+' (container)':f.def||'')+'" autocomplete="off" spellcheck="false">';
  }
  if(f.help) h+='<span class="hint">'+esc(f.help)+'</span>';
  return h+'</div>';
}
async function renderAdmin(){
  setStatus('');
  var v=$('adminView');
  if(!setInfo){
    v.innerHTML='<p class="intro">Loading the settings…</p>';
    try{ setInfo=await getJSON('api/admin/settings'); }
    catch(e){ if(e.status===401||e.status===403){ location.reload(); return; } v.innerHTML='<p class="intro">'+esc(e.message)+'</p>'; return; }
  }
  var groups=[], by={};
  setInfo.fields.forEach(function(f){ if(!by[f.group]){ by[f.group]=[]; groups.push(f.group); } by[f.group].push(f); });
  v.innerHTML='<h2>Admin</h2>'+
    '<p class="intro">The admin has no dex of its own. To tick cards, log in to a trainer\'s dex on the normal address (without /admin/).</p>'+
    '<div class="abtns"><button type="button" id="admAcc">Trainers…</button><button type="button" id="admPw">Change admin password</button></div>'+
    (setInfo.notes||[]).map(function(n){ return '<p class="intro" style="border-left:3px solid var(--lens);padding-left:10px"><b>Check this:</b> '+esc(n)+'</p>'; }).join('')+
    '<h2>Settings</h2><p class="intro">Choices made here win over the container\'s settings. <b>Default</b> uses the container\'s value (or the built-in one). '+
    (setInfo.restarts?'Saving restarts the server for a few seconds.':'After saving, restart the container to apply the changes.')+'</p>'+
    groups.map(function(g){ return '<fieldset><legend>'+esc(g)+'</legend>'+by[g].map(fieldHTML).join('')+'</fieldset>'; }).join('')+
    '<div class="savebar"><button type="button" id="setSave" disabled>Save settings</button><span id="setMsg" aria-live="polite"></span></div>';
  setDirty={};
}
function markDirty(key){ setDirty[key]=1; var r=document.querySelector('[data-row="'+key+'"]'); if(r) r.classList.add('changed'); $('setSave').disabled=false; $('setMsg').textContent=''; }
$('adminView').addEventListener('change',function(e){
  var t=e.target, key=t.dataset.key||t.dataset.other||t.dataset.secret||t.dataset.clear; if(!key) return;
  if(t.dataset.model){ var o=document.querySelector('[data-other="'+key+'"]'); o.hidden=t.value!=='__other'; if(!o.hidden) o.focus(); }
  if(key==='SCAN_AI'){ // other services have other models
    document.querySelectorAll('#adminView select[data-model]').forEach(function(s){
      var f=setInfo.fields.filter(function(x){ return x.key===s.dataset.key; })[0], cur=s.value==='__other'?(document.querySelector('[data-other="'+s.dataset.key+'"]').value||'__other'):s.value;
      s.innerHTML=modelOptions(f,cur==='__other'?'':cur);
      if(cur&&cur!=='__other'&&s.value!==cur){ s.value='__other'; }
      document.querySelector('[data-other="'+s.dataset.key+'"]').hidden=s.value!=='__other';
    });
  }
  markDirty(key);
});
$('adminView').addEventListener('input',function(e){ var t=e.target, key=t.dataset.other||t.dataset.secret||(t.type==='url'&&t.dataset.key); if(key) markDirty(key); });
$('adminView').addEventListener('click',async function(e){
  var t=e.target;
  if(t.id==='admAcc') openAccounts(false);
  else if(t.id==='admPw') $('pwBtn').click();
  else if(t.id==='setSave'){
    var values={}, bad=null;
    Object.keys(setDirty).forEach(function(key){
      var f=setInfo.fields.filter(function(x){ return x.key===key; })[0]; if(!f) return;
      if(f.type==='secret'){
        var clr=document.querySelector('[data-clear="'+key+'"]'), nv=document.querySelector('[data-secret="'+key+'"]').value.trim();
        if(nv) values[key]=nv; else if(clr&&clr.checked) values[key]='';
      } else if(f.type==='model'){
        var s=document.querySelector('select[data-key="'+key+'"]');
        if(s.value==='__other'){ var ov=document.querySelector('[data-other="'+key+'"]').value.trim(); if(!ov){ bad='Type the model name for "'+f.label+'"'; return; } values[key]=ov; }
        else values[key]=s.value;
      } else values[key]=document.querySelector('[data-key="'+key+'"]').value.trim();
    });
    if(bad){ $('setMsg').textContent=bad; return; }
    t.disabled=true; $('setMsg').textContent='Saving…';
    try{ var r=await post('api/admin/settings',{values:values}); }
    catch(err){ t.disabled=false; if(err.status===401||err.status===403){ location.reload(); return; } $('setMsg').textContent=err.message; return; }
    setInfo=null;
    if(!r.restarting){ $('setMsg').textContent='Saved. Restart the container to apply the changes.'; return; }
    $('setMsg').textContent='Saved. The server is restarting…';
    var t0=Date.now(), down=false;
    (async function wait(){
      await sleep(1000);
      var ok=false; try{ var rr=await fetch('api/status',{cache:'no-store'}); ok=rr.ok; }catch(x){ ok=false; }
      if(!ok) down=true;
      if(ok&&(down||Date.now()-t0>4000)){ location.reload(); return; }
      if(Date.now()-t0>90000){ $('setMsg').textContent='Saved, but the server has not come back yet. Check the container log.'; return; }
      wait();
    })();
  }
});

/* ---------- price history graphs (wish list) ---------- */
// The server notes each card's price every time it is fetched; wished cards are priced every day.
var histCache={};
async function loadHist(ids){
  var now=Date.now(), need=ids.filter(function(id){ var x=histCache[id]; return !x||now-x.t>10*60000; });
  for(var i=0;i<need.length;i+=150){
    var part=need.slice(i,i+150), r;
    try{ r=await getJSON('api/prices?ids='+encodeURIComponent(part.join(','))); }catch(e){ return; }
    part.forEach(function(id){ histCache[id]={t:now,h:(r.h&&r.h[id])||[]}; });
  }
}
function monthAvg(c){ // Cardmarket's 30-day average of the printing whose price is shown
  var v=c&&c.vr&&c.vr.eu; if(st.cur!=='eu'||!v) return null;
  var p=price(c), best=null; v.forEach(function(x){ if(best==null||Math.abs(x.v-p)<Math.abs(best.v-p)) best=x; });
  return best&&best.a30!=null?best:null;
}
// pts: [[day, price], ...]; w, h: size; big: axis labels and dots; ref: the 30-day average (dashed line)
function chartSVG(pts,w,h,big,ref){
  var vals=pts.map(function(p){ return p[1]; }); if(ref!=null) vals.push(ref);
  var lo=Math.min.apply(null,vals), hi=Math.max.apply(null,vals); if(hi-lo<0.01){ hi+=0.5; lo=Math.max(0,lo-0.5); }
  var t0=Date.parse(pts[0][0]), t1=Date.parse(pts[pts.length-1][0]); if(t1===t0) t1=t0+864e5;
  var L=big?52:2, R=big?10:2, T=big?10:3, B=big?24:3;
  var X=function(d){ return L+(Date.parse(d)-t0)/(t1-t0)*(w-L-R); }, Y=function(v){ return T+(1-(v-lo)/(hi-lo))*(h-T-B); };
  var line=pts.map(function(p,i){ return (i?'L':'M')+X(p[0]).toFixed(1)+' '+Y(p[1]).toFixed(1); }).join(' ');
  var up=pts[pts.length-1][1]>=pts[0][1], col=up?'var(--green)':'#ff8a8a';
  var o='<svg viewBox="0 0 '+w+' '+h+'"'+(big?'':' preserveAspectRatio="none"')+' role="img" aria-label="Price from '+fmt(pts[0][1])+' to '+fmt(pts[pts.length-1][1])+'">';
  if(ref!=null) o+='<line x1="'+L+'" x2="'+(w-R)+'" y1="'+Y(ref).toFixed(1)+'" y2="'+Y(ref).toFixed(1)+'" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1" vector-effect="non-scaling-stroke"><title>30-day average '+fmt(ref)+'</title></line>';
  o+='<path d="'+line+'" fill="none" stroke="'+col+'" stroke-width="'+(big?2.5:2)+'" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>';
  if(big){
    o+='<text x="'+(L-6)+'" y="'+(Y(hi)+4).toFixed(1)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+fmt(hi)+'</text><text x="'+(L-6)+'" y="'+(Y(lo)+4).toFixed(1)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+fmt(lo)+'</text>';
    o+='<text x="'+L+'" y="'+(h-6)+'" font-size="11" fill="var(--muted)">'+new Date(t0).toLocaleDateString()+'</text><text x="'+(w-R)+'" y="'+(h-6)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+new Date(Date.parse(pts[pts.length-1][0])).toLocaleDateString()+'</text>';
    pts.forEach(function(p){ o+='<circle cx="'+X(p[0]).toFixed(1)+'" cy="'+Y(p[1]).toFixed(1)+'" r="3" fill="'+col+'"><title>'+new Date(Date.parse(p[0])).toLocaleDateString()+': '+fmt(p[1])+'</title></circle>'; });
  }
  return o+'</svg>';
}
async function fillSparks(ids){
  if(!ids.length) return;
  await loadHist(ids);
  ids.forEach(function(id){
    var el=document.querySelector('#wishView [data-chart="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]'); if(!el) return;
    var pts=(histCache[id]||{}).h||[], m=monthAvg(byId[id]);
    if(pts.length>=2) el.innerHTML=chartSVG(pts,200,40,false,m?m.a30:null);
    else el.innerHTML='<span class="sparknote">'+(pts.length?'Price graph from '+new Date(Date.parse(pts[0][0])).toLocaleDateString()+' · grows daily':'Price graph starts with the next daily price')+'</span>';
  });
}
async function openChart(id){
  var c=byId[id]; if(!c) return;
  await loadHist([id]);
  var pts=(histCache[id]||{}).h||[], m=monthAvg(c), v=c.vr&&c.vr[st.cur];
  $('chartTitle').textContent=c.n+' · '+setName(c)+' '+(c.k||'');
  if(!$('chartdlg').open) $('chartdlg').showModal();
  var cw=Math.max(280,Math.round($('chartBody').clientWidth||600)), hh=''; // drawn at the real width, so the labels keep their size
  if(pts.length>=2) hh+=chartSVG(pts,cw,Math.round(Math.min(260,cw*0.45)),true,m?m.a30:null);
  else hh+='<p class="sparknote" style="margin:12px 0">'+(pts.length?'The server noted the price on '+new Date(Date.parse(pts[0][0])).toLocaleDateString()+'. Wished cards are priced every day, so the graph grows from here.':'No price noted yet. Wished cards are priced every day, so the graph starts with the next daily price.')+'</p>';
  var stats=['<span>Now <b>'+fmt(price(c))+'</b>'+chHTML(c)+'</span>'];
  if(pts.length>=2){ var vals=pts.map(function(p){ return p[1]; }); stats.push('<span>Lowest <b>'+fmt(Math.min.apply(null,vals))+'</b></span>','<span>Highest <b>'+fmt(Math.max.apply(null,vals))+'</b></span>','<span>'+pts.length+' days noted</span>'); }
  if(m) stats.push('<span>Cardmarket averages: day <b>'+fmt(m.a1)+'</b> · 7 days <b>'+fmt(m.a7)+'</b> · 30 days <b>'+fmt(m.a30)+'</b> (dashed line)</span>');
  hh+='<div class="chartstats">'+stats.join('')+'</div>';
  if(v&&v.length) hh+='<p class="sparknote" style="margin-top:10px">Prices per printing:</p><div class="prints" style="font-size:.85rem">'+v.map(function(x){ return '<span>'+esc(x.k)+' <b>'+fmt(x.v)+'</b>'+(x.a30!=null?' (30 days '+fmt(x.a30)+')':'')+'</span>'; }).join('')+'</div>';
  $('chartBody').innerHTML=hh;
}
$('wishView').addEventListener('click',function(e){ var b=e.target.closest('[data-chart]'); if(b) openChart(b.dataset.chart); });
$('chartClose').addEventListener('click',function(){ $('chartdlg').close(); });

/* ---------- card info: one card with its prices, from the scan check (before adding it) or anywhere ---------- */
// At a card show: scan a card, open it here, see what it is worth, then add it, wish for it or just close.
var infoCtx=null;
function openInfo(id,key){
  infoCtx={id:id,key:key||null}; $('infoMsg')&&($('infoMsg').textContent='');
  renderInfo(); if(!$('infodlg').open) $('infodlg').showModal();
  var b=$('infoBody').querySelector('[data-do="getp"]'); // no price yet: ask for it at once
  if(b&&!RO&&byId[id]&&!priceTried['info:'+id]){ priceTried['info:'+id]=1; b.click(); }
}
function infoItem(){ return infoCtx&&infoCtx.key?review.find(function(x){ return x.key===infoCtx.key; }):null; }
function renderInfo(){
  if(!infoCtx) return;
  var c=lookup(infoCtx.id), it=infoItem();
  if(!c){ $('infoBody').innerHTML='<p class="rv-hint">This card is not in the card list.</p>'; return; }
  $('infoTitle').textContent=c.n;
  var m=monthAvg(c), art=c.a||c.t==='a', own=owned(c.id), wish=byId[c.id]&&wished(c.id);
  var acts='';
  if(it&&it.chosen!==c.id) acts+='<button type="button" data-info="use">Use this card</button>';
  if(!RO) acts+=own?'':'<button type="button" class="on" data-info="add">Add to my dex</button>';
  if(!RO&&byId[c.id]&&!own) acts+='<button type="button" data-info="wish">'+(wish?'★ On your wish list':'☆ Add to wish list')+'</button>';
  if(byId[c.id]) acts+='<button type="button" data-info="chart">Price history</button>';
  $('infoBody').innerHTML='<div class="info"><div class="pic">'+picHTML(c,true).replace('data-do="zoom"','')+'</div><div class="meta">'+
    '<span class="sub">'+esc(subOf(c))+(c.r?' · '+esc(c.r):'')+'</span>'+
    '<span><span class="badge'+(art?'':' reg')+'" style="position:static">'+(art?'ART':'REGULAR')+'</span></span>'+
    priceHTML(c)+
    (m?'<span class="avgs">Cardmarket averages: day '+fmt(m.a1)+' · 7 days '+fmt(m.a7)+' · 30 days '+fmt(m.a30)+'</span>':'')+
    (own?'<span class="state">Already in your dex</span>':'')+
    (it&&it.chosen===c.id?'<span class="state" style="color:var(--muted)">The pick for photo '+esc(it.photo||'')+'</span>':'')+
    '<div class="acts">'+acts+'</div>'+linkHTML(c)+'<div id="infoMsg"></div>'+
    '</div></div>';
}
$('infoBody').addEventListener('click',function(e){
  var b=e.target.closest('[data-info]'); if(!b||!infoCtx) return;
  var a=b.dataset.info, id=infoCtx.id, it=infoItem(), c=lookup(id);
  if(a==='use'&&it){ it.chosen=id; it.include=true; it.sure=true; it.picked=true; it.error=null; rvOpen=null; saveReview(); renderReview(); queueStatus(); renderInfo(); $('infoMsg').textContent='Now the pick for this photo.'; }
  else if(a==='add'){
    if(!owned(id)){ st.cards[id]=1; save(); refresh(); }
    if(it){ review=review.filter(function(x){ return x!==it; }); if(rvOpen===it.key) rvOpen=null; saveReview(); renderReview(); queueStatus(); }
    var msg=(c&&c.n||'Card')+' added to your dex.'; toast(msg); if($('rvMsg')) $('rvMsg').textContent=msg; $('infodlg').close();
  }
  else if(a==='wish'){ wishToggle(id); renderInfo(); if(reviewOpen) renderReview(); $('infoMsg').textContent=wished(id)?'On your wish list: its price is noted every day.':'Taken off your wish list.'; }
  else if(a==='chart'){ openChart(id); }
});
$('infoClose').addEventListener('click',function(){ $('infodlg').close(); });

/* ---------- importing a collection export from another site (Collectr and the like) ---------- */
var impData=null;
$('impTop').addEventListener('click',function(){ $('impSite').click(); });
$('impSite').addEventListener('click',function(){ $('impFile').value=''; $('impText').value=''; $('impMsg').textContent=''; $('impRes').innerHTML=''; impData=null; $('impdlg').showModal(); });
$('impClose').addEventListener('click',function(){ $('impdlg').close(); });
$('impFile').addEventListener('change',function(){
  var f=$('impFile').files[0]; impData=null; $('impRes').innerHTML='';
  if(!f) return;
  if(f.size>5*1024*1024){ $('impMsg').textContent='That file is larger than 5 MB.'; return; }
  $('impMsg').textContent='Reading '+f.name+'…';
  var rd=new FileReader();
  rd.onload=function(){ readImport(String(rd.result)); };
  rd.onerror=function(){ $('impMsg').textContent='That file could not be read.'; };
  rd.readAsText(f);
});
async function readImport(text){
  impData=null; $('impRes').innerHTML='';
  if(!text.trim()){ $('impMsg').textContent='Nothing to read.'; return; }
  $('impMsg').textContent='Matching the cards…';
  try{ impData=await post('api/import',{csv:text}); }
  catch(err){ if(err.status===401){ location.reload(); return; } $('impMsg').textContent=err.message; return; }
  impData.found.forEach(function(x){ x.pick=true; });
  renderImport();
}
$('impRead').addEventListener('click',function(){ $('impFile').value=''; readImport($('impText').value); });
$('impTo').addEventListener('change',function(){ if(impData) renderImport(); });
// To my owned cards, or to one of the wish lists (value wl:<list id>)
function impLists(){
  var sel=$('impTo'), was=sel.value, key=wlists().map(function(l){ return l.id+':'+l.name; }).join('|');
  if(sel.dataset.k!==key){
    sel.innerHTML='<option value="own">Add to my owned cards</option>'+wlists().map(function(l){ return '<option value="wl:'+esc(l.id)+'">Add to wish list: '+esc(l.name)+'</option>'; }).join('');
    sel.dataset.k=key;
    sel.value=was==='wish'?'wl:'+(wlNow()||wlists()[0]).id:[].some.call(sel.options,function(o){ return o.value===was; })?was:'own';
  }
}
function impList(){ var v=$('impTo').value; return v.indexOf('wl:')===0?wlById(v.slice(3)):null; }
function impHas(id){ var l=impList(); return !l?owned(id):(owned(id)||l.cards.indexOf(id)>=0); }
function renderImport(){
  impLists();
  var toOwn=$('impTo').value==='own', f=impData.found, m=impData.missing, seen={}, n=0;
  f.forEach(function(x){ x.dup=!!seen[x.id]; seen[x.id]=1; x.had=impHas(x.id); if(x.pick&&!x.dup&&!x.had) n++; });
  var check=f.filter(function(x){ return !x.sure; }).length;
  $('impMsg').textContent=f.length+' of '+(f.length+m.length)+' rows matched to a card'+(check?' · '+check+' marked "check" (no exact set match)':'')+'.';
  var h='';
  if(f.length) h+='<div class="implist">'+f.map(function(x,i){
    return '<label class="improw'+(x.had||x.dup?' had':'')+'"><input type="checkbox" data-imp="'+i+'"'+(x.pick?' checked':'')+(x.had||x.dup?' disabled':'')+'>'+
      '<div>'+esc(x.name)+' <span>'+esc(x.number)+'</span><br><span>'+esc(x.set)+'</span></div>'+
      '<div>→ '+esc(x.card)+(x.sure?'':'<em class="chk">check</em>')+'<br><span>'+esc(x.cardSet)+(x.had?' · '+(toOwn?'already owned':'already on your list'):(x.dup?' · listed twice':''))+'</span></div></label>';
  }).join('')+'</div>';
  if(m.length) h+='<details><summary>'+m.length+' rows not matched</summary><div class="implist">'+m.map(function(x){
    return '<div class="improw"><span>'+x.row+'</span><div>'+esc(x.name)+' <span>'+esc(x.number)+'</span><br><span>'+esc(x.set)+'</span></div><div><span>'+esc(x.why)+'</span></div></div>';
  }).join('')+'</div></details>';
  h+='<div class="impbar"><button type="button" id="impGo"'+(n?'':' disabled')+'>Add '+n+' card'+(n===1?'':'s')+' to '+(toOwn?'my owned cards':'the wish list "'+esc((impList()||{}).name||'')+'"')+'</button></div>';
  $('impRes').innerHTML=h;
}
$('impRes').addEventListener('change',function(e){ var i=e.target.dataset.imp; if(i==null) return; impData.found[+i].pick=e.target.checked; renderImport(); });
$('impRes').addEventListener('click',function(e){
  if(e.target.id!=='impGo') return;
  var toOwn=$('impTo').value==='own', wl=impList(), n=0;
  impData.found.forEach(function(x){
    if(!x.pick||x.dup||impHas(x.id)) return;
    if(toOwn) st.cards[x.id]=1; else if(wl) wlSet(wl.id,x.id,true);
    n++;
  });
  save(); index(); refresh();
  var msg=n+' card'+(n===1?'':'s')+' added to '+(toOwn?'your owned cards':'the wish list "'+((wl||{}).name||'')+'"')+'.';
  renderImport(); $('impMsg').textContent=msg; toast(msg);
});

/* ---------- the app's closed Pokédex: pick your trainer, log in, it opens ---------- */
var dlId=null;
function showLock(){
  var list=CFG.accounts, last=null;
  try{ last=localStorage.getItem('dexLast'); }catch(e){}
  $('dlList').innerHTML=list.length?list.map(function(a){ return '<button type="button" data-id="'+esc(a.id)+'"'+(a.id===last?' class="last"':'')+'>'+esc(a.name)+'</button>'; }).join('')
    :'<p>'+(SIGNUP?'No trainers yet. Tap "New trainer" to make the first dex.':'No trainers yet. Ask the admin to add an account for you.')+'</p>';
  $('dlNewBtn').hidden=!SIGNUP;
  lockSize();
  $('dexLock').hidden=false;
}
// The keyboard makes the window shorter: keep the size measured without it, and keep the password field in view.
function lockSize(){ document.documentElement.style.setProperty('--dlh',window.innerHeight+'px'); }
var lockW=window.innerWidth;
window.addEventListener('resize',function(){
  if($('dexLock').hidden) return;
  if(window.innerWidth!==lockW){ lockW=window.innerWidth; lockSize(); return; } // turned the phone: measure again
  if(document.activeElement===$('dlPw')) setTimeout(function(){ $('dlPw').scrollIntoView({block:'center'}); },50);
});
function pickTrainer(id){
  dlId=id; $('dlName').textContent=accName(id); $('dlMsg').textContent=''; $('dlPw').value='';
  $('dlPick').hidden=true; $('dlForm').hidden=false; $('dlPw').focus();
}
$('dlList').addEventListener('click',function(e){ var b=e.target.closest('button[data-id]'); if(b) pickTrainer(b.dataset.id); });
$('dlBack').addEventListener('click',function(){ $('dlForm').hidden=true; $('dlPick').hidden=false; });
$('dlNewBtn').addEventListener('click',function(){ $('dlPick').hidden=true; $('dlNew').hidden=false; $('dlNMsg').textContent=''; $('dlNName').focus(); });
$('dlNBack').addEventListener('click',function(){ $('dlNew').hidden=true; $('dlPick').hidden=false; });
$('dlNew').addEventListener('submit',function(e){ e.preventDefault(); signUp($('dlNName').value,$('dlNPw').value,$('dlNPw2').value,$('dlNWeb').value,$('dlNMsg')); });
$('dlView').addEventListener('click',function(){ location.replace(location.pathname+'?dex='+encodeURIComponent(dlId)+'&look=1'); });
$('dlForm').addEventListener('submit',async function(e){
  e.preventDefault(); $('dlMsg').textContent='…'; $('dlGo').disabled=true;
  try{
    await post('api/login',{dex:dlId,password:$('dlPw').value});
    try{ localStorage.setItem('dexLast',dlId); }catch(e2){}
    $('dlMsg').textContent=''; $('dlShell').classList.add('opening');
    setTimeout(function(){ location.replace(location.pathname+'?dex='+encodeURIComponent(dlId)); },750);
  }catch(err){
    $('dlGo').disabled=false;
    $('dlMsg').textContent=err.status===429?'Too many tries. Wait 15 minutes.':(err.status===404?'That trainer cannot log in here.':'Wrong password.');
  }
});
if(APP&&LOCKED&&!ME) showLock();

(async function start(){
  if(LOCKED) return; // the app shows the closed Pokédex first
  try{
    await loadState();
    await loadData();
    index(); await applyRoute();
    var s=await getJSON('api/status').catch(function(){return null;});
    if(s&&s.running&&(!RO||ADMIN)) pollRefresh();
  }catch(e){
    setStatus('Could not load card data ('+(e&&e.message||e)+'). Reload the page to try again.');
  }
})();
})();
