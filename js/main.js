  // mobile sidebar
  const _overlay=document.getElementById('mob-overlay');
  const _sidebar=document.getElementById('mob-sidebar');
  const _sbClose=document.getElementById('mob-sb-close');
  const _menuBtn=document.querySelector('.menu-tg');

  window.openMobSidebar=function(){
    _sidebar?.classList.add('open');
    _overlay?.classList.add('open');
    _sidebar?.setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';
  };
  window.closeMobSidebar=function(){
    _sidebar?.classList.remove('open');
    _overlay?.classList.remove('open');
    _sidebar?.setAttribute('aria-hidden','true');
    document.body.style.overflow='';
  };

  _menuBtn?.addEventListener('click', openMobSidebar);
  _sbClose?.addEventListener('click', closeMobSidebar);
  _overlay?.addEventListener('click', closeMobSidebar);
  _sidebar?.querySelectorAll('.mob-sb-link').forEach(a=>
    a.addEventListener('click', closeMobSidebar));

  // close sidebar on Escape
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape')closeMobSidebar();
  });

  // sticky header
  const hdr=document.getElementById('hdr');
  addEventListener('scroll',()=>hdr.classList.toggle('scrolled',scrollY>20));

  // reveal on scroll — stagger siblings in the same parent
  const rvGroups=new Map();
  document.querySelectorAll('.rv').forEach(el=>{
    const p=el.parentElement;
    if(!rvGroups.has(p))rvGroups.set(p,[]);
    rvGroups.get(p).push(el);
  });
  const firedGroups=new WeakSet();
  const io=new IntersectionObserver((es)=>{
    es.forEach(e=>{
      if(!e.isIntersecting)return;
      const el=e.target,p=el.parentElement;
      const group=rvGroups.get(p)||[el];
      if(group.length>1&&!firedGroups.has(p)){
        firedGroups.add(p);
        group.forEach((s,i)=>{
          if(!s.style.transitionDelay)s.style.transitionDelay=(i*0.08)+'s';
          s.classList.add('in');
          if(s.classList.contains('step'))s.classList.add('on');
          io.unobserve(s);
        });
      } else {
        el.classList.add('in');
        if(el.classList.contains('step'))el.classList.add('on');
        io.unobserve(el);
      }
    });
  },{threshold:.12});
  document.querySelectorAll('.rv').forEach(el=>io.observe(el));

  // animated counters
  const fmt=(n)=>n%1===0?n.toString():n.toFixed(1);
  // ease-out with gentle overshoot — briefly exceeds target before settling
  const easeOutBack=(p)=>{const c=1.4;return 1+(c+1)*Math.pow(p-1,3)+c*Math.pow(p-1,2);};
  const counters=new IntersectionObserver((es)=>{
    es.forEach(e=>{
      if(!e.isIntersecting)return;
      const el=e.target, to=parseFloat(el.dataset.to), suf=el.dataset.suf||'', pre=el.dataset.pre||'';
      const dur=1500, t0=performance.now();
      const tick=(now)=>{
        const p=Math.min((now-t0)/dur,1);
        el.textContent=pre+fmt(+(to*easeOutBack(p)).toFixed(1))+suf;
        if(p<1)requestAnimationFrame(tick); else el.textContent=pre+fmt(to)+suf;
      };
      requestAnimationFrame(tick); counters.unobserve(el);
    });
  },{threshold:.5});
  document.querySelectorAll('.num [data-to],.num[data-to]').forEach(el=>counters.observe(el));

  /* auth functions live in auth.js — loaded after this file */

  // dashboard sidebar active state
  document.querySelectorAll('.dnav li').forEach(li=>{
    li.addEventListener('click',()=>{
      document.querySelectorAll('.dnav li').forEach(x=>x.classList.remove('active'));
      li.classList.add('active');
    });
  });

  // segmented control toggle (period selector handled in initDashboard)

  /* ===== REAL BACKTEST DASHBOARD (data from DATA in data.js) ===== */
  let dashReady=false, curSel='ALL', curWeeks=52, fcGeom=null, hideBacktest=true;
  const fcVisible={a:true,f:true,w:true};
  document.querySelectorAll('#fcLegend .lgd-item').forEach(el=>{
    el.addEventListener('click',()=>{
      const k=el.dataset.k;
      fcVisible[k]=!fcVisible[k];
      el.classList.toggle('off',!fcVisible[k]);
      drawChart();
    });
  });

  const nf=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(n);
  const nfFull=n=>Math.round(n).toLocaleString();

  function seriesWape(a,f){            // per-week + overall WAPE for an a/f pair
    const w=a.map((av,i)=>(av!=null&&av>0)?100*Math.abs(av-f[i])/av:null);
    let num=0,den=0; a.forEach((av,i)=>{if(av!=null){num+=Math.abs(av-f[i]);den+=av;}});
    return {w, overall: den?100*num/den:null};
  }
  function getSeries(sel){
    if(!sel||sel==='ALL') return {a:DATA.all.a,f:DATA.all.f,w:DATA.all.w,name:'All SKUs',overall:DATA.overallWape};
    const o=DATA.skus[sel]; if(!o) return null;
    const r=seriesWape(o.a,o.f); return {a:o.a,f:o.f,w:r.w,name:sel,overall:r.overall};
  }

  function initDashboard(){
    if(dashReady){drawChart();return;}
    dashReady=true;
    // KPIs
    document.getElementById('kpiWape').textContent=DATA.overallWape.toFixed(2)+'%';
    document.getElementById('kpiSkus').textContent=Object.keys(DATA.skus).length.toLocaleString();
    document.getElementById('kpiUnits').textContent=nf(DATA.all.a.reduce((s,x)=>s+(x||0),0));

    // top SKUs by volume (for movers + table)
    const rows=Object.keys(DATA.skus).map(a=>{
      const o=DATA.skus[a], vol=o.a.reduce((s,x)=>s+(x||0),0);
      return {a, vol, wape:seriesWape(o.a,o.f).overall, avgF:o.f.reduce((s,x)=>s+(x||0),0)/o.f.length};
    }).filter(r=>r.vol>0&&r.wape!=null).sort((x,y)=>y.vol-x.vol);

    // movers: top 6 by volume
    document.getElementById('moversList').innerHTML=rows.slice(0,6).map(r=>{
      const good=r.wape<=DATA.overallWape;
      return `<li data-sku="${r.a}"><div><div class="nmx">${r.a}</div><div class="sku">${nfFull(r.vol)} units · 2024</div></div>`+
             `<span class="chg ${good?'up':'down'}">${r.wape.toFixed(1)}%</span></li>`;
    }).join('');

    // table: top 12 by volume
    document.getElementById('skuBody').innerHTML=rows.slice(0,12).map(r=>{
      const acc=Math.max(0,100-r.wape);
      const cls=r.wape<=30?'ok':r.wape<=45?'warn':'risk';
      const lab=r.wape<=30?'Strong':r.wape<=45?'Fair':'High error';
      return `<tr data-sku="${r.a}"><td class="skucell">${r.a}</td><td>${nfFull(r.vol)}</td>`+
        `<td>${nfFull(r.avgF)}</td><td>${r.wape.toFixed(1)}%</td>`+
        `<td><div class="bar-mini"><i style="width:${acc.toFixed(0)}%"></i></div></td>`+
        `<td><span class="pill ${cls}">${lab}</span></td></tr>`;
    }).join('');

    // SKU datalist (capped so the picker stays snappy; free-text search still hits any SKU)
    document.getElementById('skuList').innerHTML=rows.slice(0,400).map(r=>`<option value="${r.a}">`).join('');

    // wire interactions
    const input=document.getElementById('skuInput');
    const apply=()=>selectSku(input.value.trim());
    input.addEventListener('change',apply);
    input.addEventListener('keydown',e=>{if(e.key==='Enter')apply();});
    const periodSeg=document.getElementById('periodSeg');
    const customBtn=document.getElementById('periodCustomBtn');
    const customInput=document.getElementById('periodCustomInput');
    periodSeg.querySelectorAll('button').forEach(b=>{
      b.addEventListener('click',()=>{
        if(b.dataset.w==='custom'){
          customInput.style.display='';
          customInput.focus();
          return; // wait for a value — don't touch curWeeks or the 'on' state yet
        }
        customInput.style.display='none';
        customBtn.textContent='Custom';
        periodSeg.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
        b.classList.add('on'); curWeeks=+b.dataset.w; drawChart();
      });
    });
    function applyCustomWeeks(){
      const v=parseInt(customInput.value,10);
      if(!v||v<1){ customInput.style.display='none'; return; }
      periodSeg.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      customBtn.classList.add('on'); customBtn.textContent=v+'W';
      curWeeks=v; customInput.style.display='none'; drawChart();
    }
    customInput.addEventListener('keydown',e=>{if(e.key==='Enter')applyCustomWeeks();});
    customInput.addEventListener('blur',applyCustomWeeks);
    const hideBtBtn=document.getElementById('hideBacktestBtn');
    if(hideBtBtn && DATA.backtestWeeks!=null && DATA.backtestWeeks<DATA.weeks.length){
      hideBtBtn.style.display='';
      hideBtBtn.addEventListener('click',()=>{
        hideBacktest=!hideBacktest;
        hideBtBtn.classList.toggle('on',hideBacktest);
        hideBtBtn.textContent=hideBacktest?'Show Backtest':'Hide Backtest';
        drawChart();
      });
    }
    document.getElementById('moversList').addEventListener('click',e=>{
      const li=e.target.closest('li'); if(li){input.value=li.dataset.sku;selectSku(li.dataset.sku);}});
    document.getElementById('skuBody').addEventListener('click',e=>{
      const tr=e.target.closest('tr'); if(tr){input.value=tr.dataset.sku;selectSku(tr.dataset.sku);}});

    // hover + resize
    const cv=document.getElementById('fcCanvas');
    cv.addEventListener('mousemove',onHover);
    cv.addEventListener('mouseleave',()=>{document.getElementById('fcTip').style.opacity=0;drawChart();});
    new ResizeObserver(()=>drawChart()).observe(document.getElementById('forecastChart'));

    selectSku('');
  }

  function selectSku(sel){
    const s=getSeries(sel||'ALL');
    if(!s){ document.getElementById('selName').textContent='SKU “'+sel+'” not found';
            document.getElementById('selWape').textContent='—'; return; }
    curSel=sel||'ALL';
    document.getElementById('selName').textContent=s.name;
    document.getElementById('selWape').textContent=s.overall==null?'—':s.overall.toFixed(2)+'%';
    drawChart();
  }

  function drawChart(){
    const s=getSeries(curSel); if(!s)return;
    let N=Math.min(curWeeks,s.a.length), st=s.a.length-N;
    if(hideBacktest && DATA.backtestWeeks!=null){
      st=Math.max(st,DATA.backtestWeeks); N=s.a.length-st;
    }
    const weeks=DATA.weeks.slice(st), a=s.a.slice(st), f=s.f.slice(st), w=s.w.slice(st);
    const box=document.getElementById('forecastChart'), cv=document.getElementById('fcCanvas');
    const cw=box.clientWidth||720, ch=box.clientHeight||260, dpr=window.devicePixelRatio||1;
    cv.width=cw*dpr; cv.height=ch*dpr; const ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,cw,ch);
    const padL=52,padR=46,padT=16,padB=26;
    const uMax=Math.max(...a.filter(x=>x!=null),...f.filter(x=>x!=null))*1.12||1;
    const wVals=w.filter(x=>x!=null); const wMax=(wVals.length?Math.max(...wVals):100)*1.15;
    const X=i=>padL+i*(cw-padL-padR)/(N-1||1);
    const Yu=v=>padT+(ch-padT-padB)*(1-v/uMax);
    const Yw=v=>padT+(ch-padT-padB)*(1-v/wMax);
    // grid + left axis (units) + right axis (wape)
    ctx.font='10px JetBrains Mono';
    for(let g=0;g<=4;g++){const y=padT+(ch-padT-padB)*g/4;
      ctx.strokeStyle='rgba(255,255,255,.06)';ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(cw-padR,y);ctx.stroke();
      ctx.fillStyle='#5C6878';ctx.textAlign='right';ctx.fillText(nf(uMax*(1-g/4)),padL-8,y+3);
      ctx.textAlign='left';ctx.fillStyle='#7AA2FF';ctx.fillText(Math.round(wMax*(1-g/4))+'%',cw-padR+8,y+3);}
    // x labels (~7)
    ctx.fillStyle='#5C6878';ctx.textAlign='center';
    const step=Math.max(1,Math.round(N/7));
    for(let i=0;i<N;i+=step){const d=weeks[i].slice(5);ctx.fillText(d,X(i),ch-8);}
    const line=(arr,Y,color,dash)=>{ctx.strokeStyle=color;ctx.lineWidth=2.2;ctx.setLineDash(dash||[]);
      ctx.beginPath();let started=false;
      arr.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Y(v);if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);});
      ctx.stroke();ctx.setLineDash([]);};
    // area under actual
    if(fcVisible.a){
      const grad=ctx.createLinearGradient(0,padT,0,ch-padB);
      grad.addColorStop(0,'rgba(84,230,196,.22)');grad.addColorStop(1,'rgba(84,230,196,0)');
      ctx.beginPath();let sx=null;a.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Yu(v);if(sx===null){ctx.moveTo(x,y);sx=x;}else ctx.lineTo(x,y);});
      if(sx!==null){ctx.lineTo(X(N-1),Yu(0));ctx.lineTo(sx,Yu(0));ctx.closePath();ctx.fillStyle=grad;ctx.fill();}
    }
    if(fcVisible.w) line(w,Yw,'#7AA2FF');                 // wape (right axis)
    if(fcVisible.a) line(a,Yu,'#54E6C4');                 // actual
    if(fcVisible.f) line(f,Yu,'#C8F24E',[7,5]);           // forecast (dashed)
    // "today" divider — backtest ends, forward-only forecast begins (skip if data has no forward portion, e.g. older cached format)
    const backtestTotal=DATA.backtestWeeks||DATA.weeks.length;
    const boundary=backtestTotal-st;
    if(boundary>0&&boundary<N){
      const bx=X(boundary-0.5);
      ctx.strokeStyle='rgba(255,255,255,.18)';ctx.setLineDash([3,3]);
      ctx.beginPath();ctx.moveTo(bx,padT);ctx.lineTo(bx,ch-padB);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='#5C6878';ctx.font='9px JetBrains Mono';ctx.textAlign='left';
      ctx.fillText('FORECAST →',bx+4,padT+10);
    }
    fcGeom={weeks,a,f,w,X,Yu,Yw,N,padL,padR,cw,ch,padT,padB};
  }

  function onHover(e){
    if(!fcGeom)return; const g=fcGeom;
    const rect=e.currentTarget.getBoundingClientRect();
    const mx=(e.clientX-rect.left); 
    let i=Math.round((mx-g.padL)/((g.cw-g.padL-g.padR)/(g.N-1||1)));
    i=Math.max(0,Math.min(g.N-1,i));
    drawChart();
    const ctx=document.getElementById('fcCanvas').getContext('2d');
    ctx.strokeStyle='rgba(200,242,78,.35)';ctx.setLineDash([3,4]);ctx.beginPath();
    ctx.moveTo(g.X(i),g.padT);ctx.lineTo(g.X(i),g.ch-g.padB);ctx.stroke();ctx.setLineDash([]);
    const dot=(v,Y,c)=>{if(v==null)return;ctx.fillStyle=c;ctx.beginPath();ctx.arc(g.X(i),Y(v),3.5,0,7);ctx.fill();};
    dot(g.a[i],g.Yu,'#54E6C4');dot(g.f[i],g.Yu,'#C8F24E');dot(g.w[i],g.Yw,'#7AA2FF');
    const tip=document.getElementById('fcTip');
    const row=(c,l,val)=>`<div class="rw"><i style="background:${c}"></i>${l}<b>${val}</b></div>`;
    tip.innerHTML=`<div class="wk">${g.weeks[i]}</div>`+
      row('#54E6C4','Actual',g.a[i]==null?'—':nfFull(g.a[i]))+
      row('#C8F24E','Forecast',g.f[i]==null?'—':nfFull(g.f[i]))+
      row('#7AA2FF','WAPE',g.w[i]==null?'—':g.w[i].toFixed(1)+'%');
    tip.style.opacity=1;
    let tx=g.X(i); const half=tip.offsetWidth/2;
    tx=Math.max(half+4,Math.min(g.cw-half-4,tx));
    tip.style.left=tx+'px'; tip.style.top=(g.padT+6)+'px';
  }

  /* ===== AI ANALYST CHATBOT (offline, grounded in DATA) ===== */
  let cbStats=null, cbBooted=false;
  function cbGetStats(){
    if(cbStats)return cbStats;
    const rows=Object.keys(DATA.skus).map(a=>{
      const o=DATA.skus[a], vol=o.a.reduce((s,x)=>s+(x||0),0);
      return {a,vol,wape:seriesWape(o.a,o.f).overall};
    }).filter(r=>r.vol>0&&r.wape!=null);
    const byVol=[...rows].sort((x,y)=>y.vol-x.vol);
    const sig=rows.filter(r=>r.vol>=5000);           // only "meaningful" volume for best/worst
    const byWapeAsc=[...sig].sort((x,y)=>x.wape-y.wape);
    const totA=DATA.all.a.reduce((s,x)=>s+(x||0),0), totF=DATA.all.f.reduce((s,x)=>s+(x||0),0);
    const wk=DATA.all.w.map((v,i)=>({i,v})).filter(x=>x.v!=null);
    const worstWk=wk.reduce((m,x)=>x.v>m.v?x:m), bestWk=wk.reduce((m,x)=>x.v<m.v?x:m);
    cbStats={rows,byVol,byWapeAsc,totA,totF,bias:100*(totF-totA)/totA,
      skuCount:Object.keys(DATA.skus).length,worstWk,bestWk};
    return cbStats;
  }
  const cbNum=n=>Math.round(n).toLocaleString();
  const cbM=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(Math.round(n));
  const skuLink=a=>`<span class="lk" data-sku="${a}">${a}</span>`;

  function cbAnswer(q){
    const t=q.toLowerCase().trim();
    const S=cbGetStats();
    const acc=(100-DATA.overallWape).toFixed(1);
    // explicit SKU lookup / chart
    const m=q.toUpperCase().match(/\bB0[A-Z0-9]{8}\b/);
    if(m){
      const id=m[0], o=DATA.skus[id];
      if(!o) return {html:`I couldn't find SKU <b>${id}</b> in this backtest. Try one from the top sellers — e.g. ${skuLink(S.byVol[0].a)}.`};
      const r=seriesWape(o.a,o.f).overall, vol=o.a.reduce((s,x)=>s+(x||0),0);
      return {html:`<b>${id}</b> — ${cbNum(vol)} units shipped in 2024 across 52 weeks. Its forecast WAPE is <span class="mono">${r.toFixed(1)}%</span> (≈${(100-r).toFixed(0)}% accuracy). I've charted it for you above. ${skuLink(id)}`, action:()=>cbChart(id)};
    }
    const has=(...w)=>w.some(x=>t.includes(x));
    // help / greeting
    if(has('hi','hello','hey','help','what can you','who are you')||t==='')
      return {html:`Hi — I'm <b>Lyra</b>, your demand analyst. I can answer questions about this 2024 backtest: overall accuracy, top sellers, best/worst forecasted products, weekly error, model bias, or any specific SKU. Try a chip below, or paste a SKU like ${skuLink(S.byVol[0].a)}.`};
    // accuracy / wape
    if(has('accuracy','accurate','wape','error rate','how good','perform'))
      return {html:`Overall <b>WAPE is ${DATA.overallWape.toFixed(2)}%</b> — that's about <b>${acc}% volume-weighted accuracy</b> on out-of-sample 2024 data (trained on 2022–2023, forecasting one week ahead). Accuracy holds steady across the high-volume catalog, where it matters most.`};
    // counts / scale
    if(has('how many sku','number of sku','how many product','catalog','sku count'))
      return {html:`The model forecasts <b>${S.skuCount.toLocaleString()} SKUs</b> every week. The top 1,000 alone make up ~96% of total volume.`};
    if(has('how many week','weeks','horizon','time period','date range','timeframe'))
      return {html:`This is a <b>52-week backtest</b> covering Jan–Dec 2024 (${DATA.weeks[0]} → ${DATA.weeks[DATA.weeks.length-1]}), forecasting <b>one week ahead</b>.`};
    // total units
    if(has('total unit','how many unit','volume','units forecast','units shipped'))
      return {html:`Across 2024 the catalog shipped <b>${cbNum(S.totA)} units</b>; the model forecast <b>${cbNum(S.totF)}</b> — a ${S.bias>0?'+':''}${S.bias.toFixed(1)}% gap.`};
    // bias
    if(has('bias','over-forecast','under-forecast','over forecast','under forecast','too high','too low'))
      return {html:`There's a slight <b>${S.bias.toFixed(1)}% bias</b> — the model ${S.bias<0?'under':'over'}-forecasts total volume (predicted ${cbM(S.totF)} vs ${cbM(S.totA)} actual). Worth a calibration pass, but consistent and correctable.`};
    // worst / best week
    if(has('worst week','highest error','worst period','peak error'))
      return {html:`The hardest week was <b>${DATA.weeks[S.worstWk.i]}</b> at <span class="mono">${S.worstWk.v.toFixed(1)}% WAPE</span> — typically promo/seasonal spikes. The cleanest was ${DATA.weeks[S.bestWk.i]} at ${S.bestWk.v.toFixed(1)}%.`};
    if(has('best week','lowest error','best period'))
      return {html:`The best week was <b>${DATA.weeks[S.bestWk.i]}</b> at <span class="mono">${S.bestWk.v.toFixed(1)}% WAPE</span>. The worst was ${DATA.weeks[S.worstWk.i]} (${S.worstWk.v.toFixed(1)}%).`};
    // best forecasted skus
    if(has('best','most accurate','lowest wape','forecast best','easiest')){
      const top=S.byWapeAsc.slice(0,5);
      return {html:`Best-forecasted high-volume SKUs (WAPE):<br>`+top.map(r=>`${skuLink(r.a)} — <span class="mono">${r.wape.toFixed(1)}%</span>`).join('<br>')+`<br><span style="color:var(--muted);font-size:12px">Tap any to chart it.</span>`};
    }
    // worst forecasted skus
    if(has('worst','least accurate','highest wape','hardest','struggle')){
      const bot=S.byWapeAsc.slice(-5).reverse();
      return {html:`Highest-error high-volume SKUs (WAPE):<br>`+bot.map(r=>`${skuLink(r.a)} — <span class="mono">${r.wape.toFixed(1)}%</span>`).join('<br>')+`<br><span style="color:var(--muted);font-size:12px">These are the calibration targets.</span>`};
    }
    // top sellers
    if(has('top sell','top sku','biggest','highest volume','best sell','top product','most sold')){
      const top=S.byVol.slice(0,5);
      return {html:`Top sellers by 2024 volume:<br>`+top.map(r=>`${skuLink(r.a)} — <b>${cbNum(r.vol)}</b> units · ${r.wape.toFixed(1)}% WAPE`).join('<br>')};
    }
    // model details
    if(has('model','how does','algorithm','train','method','approach'))
      return {html:`It's a <b>1-week-ahead</b> model trained on 2022–2023 history and evaluated out-of-sample on all of 2024. Performance is measured by WAPE (Σ|actual−forecast| / Σactual), weighted by volume so big sellers count most.`};
    // fallback
    return {html:`I can answer that best in terms of the data I have. Try: <b>overall accuracy</b>, <b>top sellers</b>, <b>best/worst forecasted SKUs</b>, <b>worst week</b>, <b>model bias</b>, or paste a SKU to chart it.`};
  }

  function cbChart(id){
    document.getElementById('skuInput').value=id;
    selectSku(id);
    document.getElementById('forecastChart').scrollIntoView({behavior:'smooth',block:'center'});
  }

  const LYRA_AVATAR_SVG = '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<ellipse cx="16" cy="14.5" rx="9" ry="7.6" fill="#2B2118"/>'
    + '<circle cx="16" cy="6.3" r="3.6" fill="#2B2118"/>'
    + '<ellipse cx="16" cy="19" rx="7.8" ry="9" fill="#E8B685"/>'
    + '<rect x="6" y="16" width="7" height="5.6" rx="2" stroke="#54E6C4" stroke-width="1.3" fill="rgba(84,230,196,0.1)"/>'
    + '<rect x="19" y="16" width="7" height="5.6" rx="2" stroke="#54E6C4" stroke-width="1.3" fill="rgba(84,230,196,0.1)"/>'
    + '<line x1="13" y1="18.6" x2="19" y2="18.6" stroke="#54E6C4" stroke-width="1.3" stroke-linecap="round"/>'
    + '<line x1="6" y1="18" x2="4" y2="17" stroke="#54E6C4" stroke-width="1.1" stroke-linecap="round"/>'
    + '<line x1="26" y1="18" x2="28" y2="17" stroke="#54E6C4" stroke-width="1.1" stroke-linecap="round"/>'
    + '<ellipse cx="9.4" cy="18.8" rx="1.4" ry="1.6" fill="#1a1a2e"/>'
    + '<ellipse cx="22.6" cy="18.8" rx="1.4" ry="1.6" fill="#1a1a2e"/>'
    + '<circle cx="10.1" cy="18.1" r="0.5" fill="white"/>'
    + '<circle cx="23.3" cy="18.1" r="0.5" fill="white"/>'
    + '<circle cx="10.5" cy="22" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<circle cx="12" cy="22.6" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<circle cx="20" cy="22.6" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<circle cx="21.5" cy="22" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<path d="M13 24.5 Q16 27 19 24.5" stroke="#a5623f" stroke-width="1.2" stroke-linecap="round" fill="none"/>'
    + '<rect x="23.7" y="9.5" width="1.5" height="7.5" rx="0.6" fill="#C8F24E" transform="rotate(20 23.7 9.5)"/>'
    + '<path d="M9 31 Q13 28 16 27.5 Q19 28 23 31" fill="#7AA2FF" opacity="0.65"/>'
    + '</svg>';

  const cbBody=()=>document.getElementById('cbBody');
  function cbPush(text,who){
    const d=document.createElement('div'); d.className='cb-msg '+who; d.innerHTML=text;
    cbBody().appendChild(d); cbBody().scrollTop=cbBody().scrollHeight;
    d.querySelectorAll('.lk').forEach(l=>l.onclick=()=>cbChart(l.dataset.sku));
    return d;
  }
  const CHAT_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/chat';
  let cbHistory = [];

  function cbMd(text){
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\n\n+/g,'<br><br>')
      .replace(/\n/g,'<br>');
  }

  function cbAsk(q){
    if(!q.trim())return;
    cbPush(q.replace(/</g,'&lt;'),'user');
    cbHistory.push({role:'user',content:q});

    const typ=document.createElement('div'); typ.className='cb-typing-row';
    typ.innerHTML='<span class="cb-avatar-sm cb-thinking">'+LYRA_AVATAR_SVG+'<span class="cb-think-badge">\u{1F4AD}</span></span>'
      +'<div class="cb-typing"><i></i><i></i><i></i></div>';
    cbBody().appendChild(typ); cbBody().scrollTop=cbBody().scrollHeight;
    const cbOrbEl=document.querySelector('.cb-orb'); if(cbOrbEl) cbOrbEl.classList.add('cb-thinking');

    var styleMap ={quick:{max_tokens:200,temperature:0.2},balanced:{max_tokens:512,temperature:0.35},detailed:{max_tokens:1024,temperature:0.45}};
    var toneMap  ={precise:{temperature:0.15},conversational:{temperature:0.35},creative:{temperature:0.7}};
    var focusHint={general:'',accuracy:'Focus primarily on WAPE metrics, accuracy percentages, and forecast quality.',
                   trends:'Focus on patterns, seasonality, and trends over the 52-week period.',
                   anomalies:'Highlight outliers, unusual spikes, and weeks or SKUs with abnormally high error.'};
    var langHint ={simple:'Use plain, jargon-free language. Avoid acronyms — explain them if you must use them.',
                   technical:'You may use supply chain and ML terminology freely.'};
    var style=localStorage.getItem('lyra_style')||'balanced';
    var tone =localStorage.getItem('lyra_tone') ||'conversational';
    var focus=localStorage.getItem('lyra_focus')||'general';
    var lang =localStorage.getItem('lyra_lang') ||'technical';
    var sp=styleMap[style]||styleMap.balanced;
    var tp=toneMap[tone]  ||toneMap.conversational;
    var extraHint=([focusHint[focus],langHint[lang]].filter(Boolean).join(' ')).trim();

    var cbToken=localStorage.getItem('apra_id');
    fetch(CHAT_API,{
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'}, cbToken?{'Authorization':'Bearer '+cbToken}:{}),
      body:JSON.stringify({
        message: q,
        history: cbHistory.slice(0,-1).slice(-8),
        extra_instructions: extraHint,
        temperature: tp.temperature,
        max_tokens: sp.max_tokens
      })
    })
    .then(function(r){return r.json();})
    .then(function(d){
      typ.remove(); if(cbOrbEl) cbOrbEl.classList.remove('cb-thinking');
      const reply=d.reply||'Sorry, something went wrong — please try again.';
      cbPush(cbMd(reply),'bot');
      cbHistory.push({role:'assistant',content:reply});
    })
    .catch(function(){
      typ.remove(); if(cbOrbEl) cbOrbEl.classList.remove('cb-thinking');
      cbPush('Connection error — please try again.','bot');
    });
  }
  function cbOpen(){
    document.getElementById('cbPanel').classList.add('open');
    document.getElementById('cbLaunch').classList.add('hide');
    if(!cbBooted){cbBooted=true;
      cbPush(`Hi — I'm <b>Lyra</b>, your AI demand analyst. Ask me anything about the 2024 forecast backtest, or tap a suggestion below. 👇`,'bot');}
    setTimeout(()=>document.getElementById('cbText').focus(),120);
  }
  function cbCloseFn(){document.getElementById('cbPanel').classList.remove('open');
    document.getElementById('cbLaunch').classList.remove('hide');}
  document.getElementById('cbLaunch').onclick=cbOpen;
  document.getElementById('cbClose').onclick=cbCloseFn;
  document.getElementById('cbForm').addEventListener('submit',e=>{
    e.preventDefault(); const i=document.getElementById('cbText'); const v=i.value; i.value=''; cbAsk(v);});
  document.getElementById('cbChips').querySelectorAll('button').forEach(b=>b.onclick=()=>cbAsk(b.textContent));

  /* ===== GENERATE REPORT (print-ready PDF view + CSV export) ===== */
  // dropdown
  const rDrop=document.getElementById('reportDrop');
  document.getElementById('genReport').onclick=e=>{e.stopPropagation();rDrop.classList.toggle('open');};
  document.addEventListener('click',()=>rDrop.classList.remove('open'));
  rDrop.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    rDrop.classList.remove('open');
    if(b.dataset.act==='pdf')generateReport(); else exportCSV();
  });

  function reportChartPNG(){
    const cv=document.createElement('canvas'); const W=940,H=380, dpr=2;
    cv.width=W*dpr; cv.height=H*dpr; const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
    ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,W,H);
    const a=DATA.all.a,f=DATA.all.f,w=DATA.all.w,wk=DATA.weeks,N=a.length;
    const padL=64,padR=58,padT=22,padB=40;
    const uMax=Math.max(...a,...f)*1.1, wMax=Math.max(...w.filter(x=>x!=null))*1.15;
    const X=i=>padL+i*(W-padL-padR)/(N-1), Yu=v=>padT+(H-padT-padB)*(1-v/uMax), Yw=v=>padT+(H-padT-padB)*(1-v/wMax);
    ctx.font='11px Arial'; ctx.textBaseline='middle';
    for(let g=0;g<=4;g++){const y=padT+(H-padT-padB)*g/4;
      ctx.strokeStyle='#e9edf2';ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();
      ctx.fillStyle='#6b7787';ctx.textAlign='right';
      ctx.fillText(Math.round(uMax*(1-g/4)/1000)+'K',padL-8,y);
      ctx.textAlign='left';ctx.fillStyle='#1aa179';ctx.fillText(Math.round(wMax*(1-g/4))+'%',W-padR+8,y);}
    ctx.fillStyle='#6b7787';ctx.textAlign='center';
    for(let i=0;i<N;i+=Math.round(N/9)){ctx.fillText(wk[i].slice(5),X(i),H-18);}
    const line=(arr,Y,c,dash)=>{ctx.strokeStyle=c;ctx.lineWidth=2.2;ctx.setLineDash(dash||[]);ctx.beginPath();
      arr.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Y(v);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();ctx.setLineDash([]);};
    line(a,Yu,'#1b66d6'); line(f,Yu,'#e8833a',[7,5]); line(w,Yw,'#1aa179');
    // axis titles
    ctx.fillStyle='#1c2330';ctx.textAlign='center';ctx.font='600 11px Arial';
    ctx.save();ctx.translate(16,H/2);ctx.rotate(-Math.PI/2);ctx.fillText('Units shipped',0,0);ctx.restore();
    return cv.toDataURL('image/png');
  }

  function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  function buildInsightsSection(insights){
    if(!insights) return '';
    const rowStyle='display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid #f0f2f5;font-size:13px';
    const findings=(insights.key_findings||[]).map(f=>
      `<li style="${rowStyle}"><span style="font-weight:600">${escHtml(f.title)}</span><span style="text-align:right;max-width:65%;color:#3a4555">${escHtml(f.detail)}</span></li>`).join('');
    const plainLi=t=>`<li style="${rowStyle};justify-content:flex-start"><span style="color:#3a4555">${escHtml(t)}</span></li>`;
    const watch=(insights.watch_areas||insights.risks||[]).map(plainLi).join('');
    const opps=(insights.opportunities||[]).map(plainLi).join('');
    return `
        <h2>AI Insights</h2>
        <p class="lead" style="font-weight:600;color:#0A0E15">${escHtml(insights.headline)}</p>
        <p class="lead" style="margin-top:8px">${escHtml(insights.summary)}</p>
        ${findings?`<h3 style="font-size:12px;color:#6b7787;margin:16px 0 8px">Key findings</h3><ul style="list-style:none">${findings}</ul>`:''}
        <div class="two" style="margin-top:16px">
          <div><h3>Watch areas</h3><ul>${watch}</ul></div>
          <div><h3>Opportunities</h3><ul>${opps}</ul></div>
        </div>`;
  }

  function buildReportHTML(insights){
    const S=cbGetStats();
    const acc=(100-DATA.overallWape).toFixed(1);
    const user=document.getElementById('greetName').textContent||'—';
    const dt=new Date().toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});
    const top=S.byVol.slice(0,15);
    const best=S.byWapeAsc.slice(0,5), worst=S.byWapeAsc.slice(-5).reverse();
    const tn=n=>Math.round(n).toLocaleString();
    const card=(l,v,s)=>`<div class="mc"><div class="mc-l">${l}</div><div class="mc-v">${v}</div><div class="mc-s">${s||''}</div></div>`;
    const trow=r=>{const a2=Math.max(0,100-r.wape);const cls=r.wape<=30?'ok':r.wape<=45?'warn':'risk';
      const lab=r.wape<=30?'Strong':r.wape<=45?'Fair':'High error';
      return `<tr><td class="mono">${r.a}</td><td>${tn(r.vol)}</td><td>${r.wape.toFixed(1)}%</td><td>${a2.toFixed(0)}%</td><td><span class="pill ${cls}">${lab}</span></td></tr>`;};
    const li=r=>`<li><span class="mono">${r.a}</span><b>${r.wape.toFixed(1)}%</b></li>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>APRABot — Forecast Accuracy Report</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c2330;background:#eef1f5;line-height:1.55}
      .page{max-width:880px;margin:24px auto;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      .hd{background:#0A0E15;color:#fff;padding:30px 40px;display:flex;justify-content:space-between;align-items:flex-end}
      .hd .logo{font-size:22px;font-weight:700;letter-spacing:-.02em}.hd .logo b{color:#C8F24E}
      .hd h1{font-size:15px;font-weight:600;color:#C8F24E;margin-top:14px}
      .hd .meta{text-align:right;font-size:12px;color:#9fb0c6;line-height:1.7}
      .body{padding:34px 40px}
      h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#6b7787;margin:30px 0 14px;border-bottom:1px solid #e9edf2;padding-bottom:8px}
      h2:first-child{margin-top:0}
      .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
      .mc{border:1px solid #e9edf2;border-radius:10px;padding:16px}
      .mc-l{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7787}
      .mc-v{font-size:26px;font-weight:700;color:#0A0E15;margin-top:4px}
      .mc-s{font-size:11px;color:#8b97a6;margin-top:3px}
      p.lead{font-size:14px;color:#3a4555}
      img.chart{width:100%;border:1px solid #e9edf2;border-radius:10px;margin-top:6px}
      table{width:100%;border-collapse:collapse;font-size:13px;margin-top:4px}
      th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7787;padding:8px 10px;border-bottom:2px solid #e9edf2}
      td{padding:9px 10px;border-bottom:1px solid #f0f2f5}
      .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#1b66d6}
      .pill{font-size:11px;padding:2px 9px;border-radius:100px;font-weight:600}
      .pill.ok{background:#e7f7ef;color:#1aa179}.pill.warn{background:#fdf3e0;color:#b9852a}.pill.risk{background:#fde9e9;color:#d35454}
      .two{display:grid;grid-template-columns:1fr 1fr;gap:28px}
      .two h3{font-size:12px;color:#6b7787;margin-bottom:8px}
      .two ul{list-style:none}.two li{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f2f5;font-size:13px}
      .foot{font-size:11px;color:#8b97a6;border-top:1px solid #e9edf2;margin-top:30px;padding-top:14px}
      .toolbar{position:fixed;top:14px;right:14px;display:flex;gap:8px}
      .toolbar button{background:#1b66d6;color:#fff;border:none;border-radius:7px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer}
      .toolbar button.sec{background:#fff;color:#1b66d6;border:1px solid #c7ced8}
      @media print{.toolbar{display:none}body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}}
    </style></head><body>
    <div class="toolbar"><button onclick="window.print()">Save as PDF / Print</button><button class="sec" onclick="window.close()">Close</button></div>
    <div class="page">
      <div class="hd">
        <div><div class="logo">APRA<b>Bot</b></div><h1>Demand Forecast Accuracy Report</h1></div>
        <div class="meta">2024 Weekly Backtest<br>Generated ${dt}<br>Prepared for: ${user}</div>
      </div>
      <div class="body">
        <h2>Executive Summary</h2>
        <p class="lead">Out-of-sample evaluation of the APRABot demand model across the full catalog. The model was trained on 2022–2023 history and used to forecast shipped units one week ahead for every week of 2024. Accuracy is reported as WAPE (weighted absolute percentage error), so high-volume products dominate the headline figure.</p>
        <div class="cards" style="margin-top:18px">
          ${card('Overall WAPE',DATA.overallWape.toFixed(2)+'%','volume-weighted error')}
          ${card('Volume-wtd Accuracy',acc+'%','100 − WAPE')}
          ${card('Forecast Bias',(S.bias>0?'+':'')+S.bias.toFixed(1)+'%',S.bias<0?'under-forecast':'over-forecast')}
          ${card('SKUs Forecasted',S.skuCount.toLocaleString(),'full catalog')}
          ${card('Units Forecasted',tn(S.totA),'shipped, 52 weeks')}
          ${card('Backtest Horizon','52 wks','1-week-ahead')}
        </div>
        ${buildInsightsSection(insights)}
        <h2>Forecast vs Actuals — Aggregate</h2>
        <img class="chart" src="${reportChartPNG()}" alt="Forecast vs actuals chart">
        <p class="lead" style="margin-top:10px;font-size:12px;color:#6b7787">Blue: actual units · Orange (dashed): forecast units · Green: weekly WAPE (%). Hardest week: ${DATA.weeks[S.worstWk.i]} (${S.worstWk.v.toFixed(1)}%). Best week: ${DATA.weeks[S.bestWk.i]} (${S.bestWk.v.toFixed(1)}%).</p>
        <h2>Top 15 SKUs by Volume</h2>
        <table><thead><tr><th>SKU</th><th>Total Units</th><th>WAPE</th><th>Accuracy</th><th>Status</th></tr></thead>
        <tbody>${top.map(trow).join('')}</tbody></table>
        <h2>Forecast Quality (high-volume SKUs)</h2>
        <div class="two">
          <div><h3>Best forecasted</h3><ul>${best.map(li).join('')}</ul></div>
          <div><h3>Highest error</h3><ul>${worst.map(li).join('')}</ul></div>
        </div>
        <div class="foot">Methodology: WAPE = Σ|actual − forecast| / Σactual, computed per week and aggregated by volume. Best/highest-error lists are restricted to SKUs with ≥5,000 units to exclude low-volume noise. This report is generated from a static backtest snapshot for demonstration purposes.</div>
      </div>
    </div></body></html>`;
  }

  function generateReport(){
    // Open the window synchronously (within the click handler) so popup
    // blockers don't intervene, then fill it in once insights are fetched.
    const w=window.open('','_blank');
    if(w){w.document.open();w.document.write('<!DOCTYPE html><title>Generating…</title><body style="font-family:sans-serif;padding:40px;color:#666">Generating report…</body>');w.document.close();}
    const finish=insights=>{
      const html=buildReportHTML(insights);
      if(w && !w.closed){w.document.open();w.document.write(html);w.document.close();}
      else{ // popup blocked or user closed the placeholder tab → download instead
        const blob=new Blob([html],{type:'text/html'});
        const a=document.createElement('a');a.href=URL.createObjectURL(blob);
        a.download='APRABot_Forecast_Report.html';a.click();URL.revokeObjectURL(a.href);
      }
    };
    if(window.fetchInsights) window.fetchInsights().then(finish).catch(()=>finish(null));
    else finish(null);
  }

  function exportCSV(){
    const S=cbGetStats();
    let csv='sku,total_units,avg_weekly_forecast,wape_pct,accuracy_pct\n';
    S.byVol.forEach(r=>{
      const o=DATA.skus[r.a];
      const avgF=o.f.reduce((s,x)=>s+(x||0),0)/o.f.length;
      csv+=`${r.a},${Math.round(r.vol)},${Math.round(avgF)},${r.wape.toFixed(2)},${Math.max(0,100-r.wape).toFixed(2)}\n`;
    });
    const blob=new Blob([csv],{type:'text/csv'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download='APRABot_forecast_summary.csv';a.click();URL.revokeObjectURL(a.href);
  }

  // esc closes login
  addEventListener('keydown',e=>{if(e.key==='Escape')closeLogin();});

  // spotlight cursor glow on cards
  document.querySelectorAll('.card').forEach(card=>{
    card.addEventListener('mousemove',e=>{
      const r=card.getBoundingClientRect();
      card.style.setProperty('--mx',((e.clientX-r.left)/r.width*100).toFixed(1)+'%');
      card.style.setProperty('--my',((e.clientY-r.top)/r.height*100).toFixed(1)+'%');
    });
  });

  // Platform cards → horizontal slider with dot indicators on mobile
  function initCardSlider(){
    const cards=document.querySelector('.cards');
    if(!cards)return;
    document.querySelectorAll('.cards-dots').forEach(el=>el.remove());
    if(window.innerWidth>768)return;

    const items=[...cards.querySelectorAll('.card')];
    const wrap=document.createElement('div');
    wrap.className='cards-dots';
    const dots=items.map((_,i)=>{
      const b=document.createElement('button');
      b.className='cdot'+(i===0?' on':'');
      b.setAttribute('aria-label','Feature '+(i+1));
      b.addEventListener('click',()=>{
        cards.scrollTo({left:items[i].offsetLeft-16,behavior:'smooth'});
      });
      wrap.appendChild(b);
      return b;
    });
    cards.after(wrap);

    // update active dot as user swipes
    const io=new IntersectionObserver(es=>{
      es.forEach(e=>{
        if(!e.isIntersecting)return;
        const idx=items.indexOf(e.target);
        if(idx<0)return;
        dots.forEach((d,i)=>d.classList.toggle('on',i===idx));
      });
    },{root:cards,threshold:.55});
    items.forEach(c=>io.observe(c));
  }

  // ── Mobile expand/collapse sections ──
  function addMobChev(el){
    if(el.querySelector('.mob-chev'))return;
    const s=document.createElement('span');
    s.className='mob-chev';
    s.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    el.appendChild(s);
  }
  function triggerRv(sec){
    sec.querySelectorAll('.rv:not(.in)').forEach(el=>{
      el.classList.add('in');
      if(el.classList.contains('step'))el.classList.add('on');
    });
  }
  function initMobCollapse(){
    const isMob=window.innerWidth<=768;
    [[document.getElementById('how'),             '#how .sec-head'],
     [document.getElementById('decision-engine'), '.de-head'],
     [document.getElementById('industries'),      '#industries .sec-head'],
    ].forEach(([sec,sel])=>{
      if(!sec)return;
      const head=sec.querySelector(sel);
      if(!head)return;
      if(isMob){
        addMobChev(head);
        if(!sec._mobBound){
          sec._mobBound=true;
          head.addEventListener('click',()=>{
            const open=sec.classList.toggle('mob-open');
            if(open)triggerRv(sec);
          });
        }
      } else {
        sec.classList.remove('mob-open');
        head.querySelector('.mob-chev')?.remove();
      }
    });
  }

  initCardSlider();
  initMobCollapse();
  let _sliderTimer;
  window.addEventListener('resize',()=>{
    clearTimeout(_sliderTimer);
    _sliderTimer=setTimeout(()=>{initCardSlider();initMobCollapse();},200);
  },{passive:true});
