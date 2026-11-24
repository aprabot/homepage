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
  // data.js's bundled sample: still what window.DATA holds if the real
  // forecast couldn't be loaded, so the Overview can say so (ovHasForecast).
  const SAMPLE_DATA=window.DATA;
  const ovHasForecast=()=>!!window.DATA&&window.DATA!==SAMPLE_DATA;
  let dashReady=false, curSel='ALL', fcGeom=null, hideBacktest=true, ovHorizon=52;
  const fcVisible={a:true,f:true,w:true};
  // Chart colours per theme: the dark-theme lime / light-teal / white grid
  // are too faint on the light theme's white cards.
  function fcPalette(){
    const light=document.documentElement.dataset.theme==='light';
    return light
      ?{grid:'rgba(17,19,24,.08)',axis:'#52606E',actual:'#0E9384',actualFill:'14,147,132',forecast:'#6E9400',wape:'#3D6FE0',plan:'#8A97A6',divider:'rgba(17,19,24,.22)'}
      :{grid:'rgba(255,255,255,.06)',axis:'#8694A6',actual:'#54E6C4',actualFill:'84,230,196',forecast:'#C8F24E',wape:'#7AA2FF',plan:'#93A1B5',divider:'rgba(255,255,255,.18)'};
  }
  // Redraw on theme switch so the chart never keeps the other theme's colours.
  new MutationObserver(()=>{ if(dashReady&&window.DATA)drawChart(); })
    .observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  document.querySelectorAll('#fcLegend .lgd-item').forEach(el=>{
    el.addEventListener('click',()=>{
      const k=el.dataset.k;
      fcVisible[k]=!fcVisible[k];
      el.classList.toggle('off',!fcVisible[k]);
      drawChart();
    });
  });

  // "Hide backtest", shared by the Forecasts and Scenarios charts: drops the
  // model's past-week forecast and its WAPE. Actuals stay; with Actual also
  // off there is nothing left in the past, so those weeks go too.
  const fcBacktest={
    hidden:(()=>{try{return localStorage.getItem('apraHideBacktest')==='1';}catch(e){return false;}})(),
    set(on,remember){
      this.hidden=on;
      if(remember)try{localStorage.setItem('apraHideBacktest',on?'1':'0');}catch(e){}
      this.sync();
      document.dispatchEvent(new Event('apra:backtest'));
    },
    sync(){
      document.querySelectorAll('.fc-backtest-btn').forEach(b=>{
        b.textContent=this.hidden?'Show backtest':'Hide backtest';
        b.setAttribute('aria-pressed',String(this.hidden));
      });
      document.querySelectorAll('.selbar .selwape').forEach(el=>{el.style.visibility=this.hidden?'hidden':'';});
    },
    from(start,edge,showActual){return this.hidden&&!showActual&&edge>start?edge:start;},
    past(values,boundary){return this.hidden?values.map((v,i)=>i<boundary?null:v):values;},
    subtitle(full,context,ahead,showActual){
      const next='the next '+ahead+' weeks of forecast';
      if(this.hidden&&!showActual)return next.charAt(0).toUpperCase()+next.slice(1);
      return (full?(this.hidden?'All past weeks of actuals':'Full backtest history'):'Last '+context+' weeks of actuals')+', then '+next;
    },
  };
  document.querySelectorAll('.fc-backtest-btn').forEach(b=>b.addEventListener('click',()=>fcBacktest.set(!fcBacktest.hidden,true)));
  document.addEventListener('apra:backtest',()=>{ if(dashReady&&window.DATA)drawChart(); });
  fcBacktest.sync();

  const nf=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(Math.round(n));
  const nfFull=n=>Math.round(n).toLocaleString();

  function seriesWape(a,f){            // per-week + overall WAPE for an a/f pair
    const w=a.map((av,i)=>(av!=null&&av>0)?100*Math.abs(av-f[i])/av:null);
    let num=0,den=0; a.forEach((av,i)=>{if(av!=null){num+=Math.abs(av-f[i]);den+=av;}});
    return {w, overall: den?100*num/den:null};
  }
  function forecastZipSeries(skuId,zip){
    if(skuId!=='ALL')return DATA.skus[skuId]?.byZip?.[zip];
    const matches=Object.values(DATA.skus).map(sku=>sku.byZip?.[zip]).filter(Boolean);
    if(!matches.length)return null;
    const sumWeeks=field=>{
      const totals=DATA.weeks.map(()=>null);
      matches.forEach(series=>series[field]?.forEach((value,i)=>{
        if(Number.isFinite(value))totals[i]=(totals[i]??0)+value;
      }));
      return totals;
    };
    return {a:sumWeeks('a'),f:sumWeeks('f')};
  }

  function getSeries(sel){
    if(!sel||sel==='ALL') return {a:DATA.all.a,f:DATA.all.f,w:DATA.all.w,name:'All SKUs',overall:DATA.overallWape};
    if(sel.indexOf('|')!==-1){
      const [skuId,zip]=sel.split('|');
      const o=forecastZipSeries(skuId,zip);
      if(!o) return null;
      const r=seriesWape(o.a,o.f);
      return {...o,w:r.w,name:(skuId==='ALL'?'All SKUs':skuId)+' · '+zip,overall:r.overall};
    }
    const o=DATA.skus[sel]; if(!o) return null;
    const r=seriesWape(o.a,o.f); return {a:o.a,f:o.f,w:r.w,name:sel,overall:r.overall};
  }

  // Real trailing-window WAPE over the backtest's actual weeks, via the
  // existing seriesWape(a,f). "Trailing N weeks" means the N weeks ending
  // at the backtest/forecast boundary (DATA.backtestWeeks) — the only
  // weeks with real actuals — not an arbitrary slice of the 104-week
  // array (most of which is forecast-only with a:null).
  function trailingWape(n){
    const bt=DATA.backtestWeeks||DATA.weeks.length;
    const st=Math.max(0,bt-n);
    const a=DATA.all.a.slice(st,bt), f=DATA.all.f.slice(st,bt);
    return seriesWape(a,f).overall;
  }

  // Error per SKU and week over the last n weeks of actuals, as in "Backtest
  // WAPE" on Forecasts and Scenarios. (On the all-SKU total, one SKU's
  // over-forecast hides another's under-forecast.)
  function skuLevelWape(d,n){
    const bt=d.backtestWeeks??d.weeks.length, st=Math.max(0,bt-n);
    if(st===0&&Number.isFinite(d.overallWape))return d.overallWape;
    let error=0,sold=0;
    for(let i=st;i<bt;i++){
      const a=d.all.a[i], w=d.all.w?.[i];
      if(Number.isFinite(a)&&Number.isFinite(w)){error+=a*w;sold+=a;}
    }
    return sold?error/sold:null;
  }

  function renderDashboardData(){
    // Overview KPI strip (the matrix is overview-matrix.js; real values only — see
    // ovPickHorizon for the Time-Horizon-driven WAPE chip/chart redraw)
    const totalUnits=DATA.all.a.reduce((s,x)=>s+(x||0),0);
    const skuCount=Object.keys(DATA.skus).length;
    const setTxt=(id,v)=>{const el=document.getElementById(id); if(el)el.textContent=v;};
    const has=ovHasForecast();
    const bt=DATA.backtestWeeks||DATA.weeks.length;
    setTxt('ovKpiSkus',has?skuCount.toLocaleString():'—');
    setTxt('ovKpiSold',has?nf(totalUnits):'—');
    setTxt('ovKpiSoldNote',has?'In the '+bt+' backtest weeks':'');
    ['ovKpiStrip'].forEach(id=>{
      const el=document.getElementById(id); if(!el)return;
      el.classList.remove('ov-loading'); el.removeAttribute('aria-busy');
    });
    ovPickHorizon(document.querySelector('#ovHorizonSeg button[data-w="'+ovHorizon+'"]')||document.querySelector('#ovHorizonSeg button.active'));

    // Top SKUs by volume for the Overview list and Forecast SKU picker.
    const rows=Object.keys(DATA.skus).map(a=>{
      const o=DATA.skus[a], vol=o.a.reduce((s,x)=>s+(x||0),0);
      return {a, vol, wape:seriesWape(o.a,o.f).overall};
    }).filter(r=>r.vol>0&&r.wape!=null).sort((x,y)=>y.vol-x.vol);

    // Overview movers: top six by volume.
    const moversHtml=rows.slice(0,6).map(r=>{
      const good=r.wape<=DATA.overallWape;
      return `<li data-sku="${r.a}"><div><div class="nmx">${r.a}</div><div class="sku">${nfFull(r.vol)} units · 2024</div></div>`+
             `<span class="chg ${good?'up':'down'}">${r.wape.toFixed(1)}%</span></li>`;
    }).join('');
    const ovMovers=document.getElementById('ovMoversList');
    if(ovMovers)ovMovers.innerHTML=moversHtml;

    // SKU datalist (capped so the picker stays snappy; free-text search still hits any SKU)
    document.getElementById('skuList').innerHTML=rows.slice(0,400).map(r=>`<option value="${r.a}">`).join('');
  }

  // Compact, non-interactive all-SKU actual-vs-forecast snapshot for the
  // Overview page — same visual language as the real Forecasts chart
  // (mint actual, dashed signal-green forecast) but no axis-2/WAPE line,
  // hover, or legend toggle, since it's a glance-and-click-through widget.
  // Window width follows the Time Horizon toggle (ovHorizon: 12/26/52) so
  // picking a horizon visibly changes how much trailing-actual + forward
  // data is plotted, not just the WAPE number next to it.
  function drawOverviewTrend(){
    const cv=document.getElementById('ovTrendCanvas');
    if(!cv||!window.DATA)return;
    const ovSkel=document.getElementById('ovTrendSkel');
    if(ovSkel)ovSkel.style.display='none';
    // Center the window on the backtest/forecast boundary (trailing actuals
    // + near-term forward outlook) rather than just "the last N calendar
    // weeks" — with a long forward horizon, the most recent weeks are
    // forecast-only with no actuals yet, which would make the actual line
    // vanish entirely from a naive trailing window.
    const winW=Math.min(DATA.weeks.length,Math.max(26,ovHorizon));
    const backtestTotal0=DATA.backtestWeeks||DATA.weeks.length;
    const halfTrail=Math.min(backtestTotal0,Math.round(winW/2));
    const st=Math.max(0,Math.min(backtestTotal0-halfTrail,DATA.weeks.length-winW));
    const N=Math.min(winW,DATA.weeks.length-st);
    const weeks=DATA.weeks.slice(st), a=DATA.all.a.slice(st), f=DATA.all.f.slice(st);
    const box=cv.parentElement;
    const cw=box.clientWidth||600, ch=box.clientHeight||190, dpr=window.devicePixelRatio||1;
    cv.width=cw*dpr; cv.height=ch*dpr; const ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,cw,ch);
    const padL=48,padR=12,padT=14,padB=24;
    const uMax=Math.max(...a.filter(x=>x!=null),...f.filter(x=>x!=null))*1.12||1;
    const X=i=>padL+i*(cw-padL-padR)/(N-1||1);
    const Y=v=>padT+(ch-padT-padB)*(1-v/uMax);
    ctx.font='10px JetBrains Mono';
    for(let g=0;g<=3;g++){const y=padT+(ch-padT-padB)*g/3;
      ctx.strokeStyle='rgba(255,255,255,.06)';ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(cw-padR,y);ctx.stroke();
      ctx.fillStyle='#5C6878';ctx.textAlign='right';ctx.fillText(nf(uMax*(1-g/3)),padL-8,y+3);}
    ctx.fillStyle='#5C6878';ctx.textAlign='center';
    const step=Math.max(1,Math.round(N/5));
    for(let i=0;i<N;i+=step){ctx.fillText(weeks[i].slice(5),X(i),ch-6);}
    const line=(arr,color,dash)=>{ctx.strokeStyle=color;ctx.lineWidth=2.2;ctx.setLineDash(dash||[]);
      ctx.beginPath();let started=false;
      arr.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Y(v);if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);});
      ctx.stroke();ctx.setLineDash([]);};
    const grad=ctx.createLinearGradient(0,padT,0,ch-padB);
    grad.addColorStop(0,'rgba(84,230,196,.2)');grad.addColorStop(1,'rgba(84,230,196,0)');
    ctx.beginPath();let sx=null;a.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Y(v);if(sx===null){ctx.moveTo(x,y);sx=x;}else ctx.lineTo(x,y);});
    if(sx!==null){ctx.lineTo(X(N-1),Y(0));ctx.lineTo(sx,Y(0));ctx.closePath();ctx.fillStyle=grad;ctx.fill();}
    line(a,'#54E6C4'); line(f,'#C8F24E',[7,5]);
    const backtestTotal=DATA.backtestWeeks||DATA.weeks.length, boundary=backtestTotal-st;
    if(boundary>0&&boundary<N){
      const bx=X(boundary-0.5);
      ctx.strokeStyle='rgba(255,255,255,.18)';ctx.setLineDash([3,3]);
      ctx.beginPath();ctx.moveTo(bx,padT);ctx.lineTo(bx,ch-padB);ctx.stroke();ctx.setLineDash([]);
    }
  }

  // Overview Time Horizon toggle (12W/26W/52W) — genuinely recomputes the
  // WAPE KPI chip via trailingWape()/seriesWape() on the real trailing-N-
  // week actual/forecast slice, and redraws the trend chart's window to
  // match. Not just a CSS/active-state toggle. Exposed on window since
  // it's invoked from an inline onclick= in dashboard/index.html.
  window.ovPickHorizon=function(btn){
    if(!btn||!window.DATA)return;
    const n=+btn.dataset.w;
    ovHorizon=n;
    document.querySelectorAll('#ovHorizonSeg button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const has=ovHasForecast();
    const w=has?skuLevelWape(DATA,n):null;
    const put=(id,v)=>{const el=document.getElementById(id); if(el)el.textContent=v;};
    const wapeEl=document.getElementById('ovKpiWape');
    if(wapeEl)wapeEl.textContent=w==null?'—':w.toFixed(2)+'%';
    const noForecast='Your forecast couldn’t be loaded';
    const used=Math.min(n,DATA.backtestWeeks||DATA.weeks.length);
    put('ovKpiWapeNote',!has?noForecast:w==null?'No actuals to compare with yet'
      :'Average error per SKU over '+used+' weeks of actuals · lower is better');
    // Forecast units for the weeks ahead (as on Forecasts), not units already sold.
    const ahead=has?Math.min(n,DATA.weeks.length-(DATA.backtestWeeks??DATA.weeks.length)):0;
    const period=ahead>0?fclyPeriod(DATA.all,ahead):{units:null,prior:null,change:null};
    put('ovKpiUnits',period.units==null?'—':nf(period.units));
    put('ovKpiUnitsNote',!has?noForecast:period.units==null?'No forecast weeks ahead'
      :'Next '+ahead+' weeks'+(period.prior>0?' · last year '+nf(period.prior):' · no last-year data'));
    const delta=document.getElementById('ovKpiUnitsDelta');
    if(delta){
      const c=period.change, up=c!=null&&c>=0.05, down=c!=null&&c<=-0.05;
      delta.hidden=c==null;
      delta.dataset.direction=up?'up':down?'down':'flat';
      delta.textContent=c==null?'':(up?'▲ ':down?'▼ ':'')+Math.abs(c).toFixed(1)+'% vs last year';
      delta.setAttribute('aria-label',c==null?'':(up?'Up ':down?'Down ':'Unchanged, ')+Math.abs(c).toFixed(1)+'% versus last year');
    }
    const rows=ahead>0?fclyBuildRows('ALL','',ahead):[];
    const revenue=fclyPricing(rows,'avgPrice'), discount=fclyPricing(rows,'avgDiscount');
    put('ovKpiRevenue',fclyCompact(revenue));
    put('ovKpiRevenueNote',revenue==null?(has?'No selling prices in your sales data':''):'Next '+ahead+' weeks, at usual prices');
    put('ovKpiDiscount',discount==null?'—':discount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}));
    put('ovKpiDiscountNote',discount==null?(has?'No discounts in your sales data':''):'Historical average');
    const lblEl=document.getElementById('ovKpiWapeLabel');
    if(lblEl)lblEl.textContent=n+'W';
    const btEl=document.getElementById('ovKpiBacktest');
    if(btEl)btEl.textContent=has?used+' wks':'—';
    drawOverviewTrend();
    document.dispatchEvent(new CustomEvent('apra:overview',{detail:{horizon:n,loaded:has}}));
  };

  // Plan & Scenario Comparison Matrix — collapsible group headers. Pure UI
  // affordance ported from the redesign mockup as-is; no data dependency.
  window.ovToggleGroup=function(groupName, headerEl){
    const rows=document.querySelectorAll('[data-group-item="'+groupName+'"]');
    if(!rows.length)return;
    const nowHidden=!rows[0].classList.contains('ov-row-hidden');
    rows.forEach(r=>r.classList.toggle('ov-row-hidden',nowHidden));
    headerEl.classList.toggle('collapsed',nowHidden);
  };

  window.ovToggleAllGroups=function(){
    const btn=document.getElementById('ovToggleAllGroupsBtn');
    if(!btn)return;
    const collapsing=btn.textContent.indexOf('Collapse')===0;
    document.querySelectorAll('.ov-group-header').forEach(header=>{
      const groupName=header.dataset.group;
      document.querySelectorAll('[data-group-item="'+groupName+'"]').forEach(r=>r.classList.toggle('ov-row-hidden',collapsing));
      header.classList.toggle('collapsed',collapsing);
    });
    btn.textContent=collapsing?'Expand all groups':'Collapse all groups';
  };

  // Switches the sidebar to the given panel by reusing its real click
  // handler (js inline in dashboard/index.html), so active state, the
  // report-menu visibility, and the saved-panel localStorage entry all
  // stay in sync exactly like a manual nav click would.
  function goToPanel(name){
    const li=Array.from(document.querySelectorAll('.dnav li')).find(el=>el.textContent.trim()===name);
    if(li)li.click();
  }

  function initDashboard(){
    renderDashboardData();
    drawOverviewTrend();
    if(dashReady){selectSku(getSeries(curSel)?curSel:'ALL');return;}
    dashReady=true;

    document.getElementById('ovTrendCard')?.addEventListener('click',()=>goToPanel('Forecasts'));
    document.getElementById('ovMoversList')?.addEventListener('click',e=>{
      const li=e.target.closest('li'); if(!li)return;
      goToPanel('Forecasts');
      const skuInput=document.getElementById('skuInput');
      if(skuInput)skuInput.value=li.dataset.sku;
      selectSku(li.dataset.sku);
    });
    const ovChartBox=document.querySelector('#ovTrendCard .dchart');
    if(ovChartBox)new ResizeObserver(()=>drawOverviewTrend()).observe(ovChartBox);

    // wire interactions
    const input=document.getElementById('skuInput');
    const apply=()=>selectSku(input.value.trim());
    input.addEventListener('change',apply);
    input.addEventListener('keydown',e=>{if(e.key==='Enter')apply();});
    document.getElementById('zipInput').addEventListener('change',e=>{
      const baseSkuId=(curSel||'').split('|')[0];
      selectSku(e.target.value?baseSkuId+'|'+e.target.value:baseSkuId);
    });
    const hideBtBtn=document.getElementById('hideBacktestBtn');
    if(hideBtBtn && DATA.backtestWeeks!=null && DATA.backtestWeeks<DATA.weeks.length){
      hideBtBtn.style.display='';
      document.getElementById('fcBacktestBtn').style.display='';
      hideBtBtn.addEventListener('click',()=>{
        hideBacktest=!hideBacktest;
        hideBtBtn.classList.toggle('on',hideBacktest);
        hideBtBtn.textContent=hideBacktest?'Full history':'Recent weeks';
        hideBtBtn.setAttribute('aria-pressed',String(!hideBacktest));
        drawChart();
      });
    }
    // hover + resize
    const cv=document.getElementById('fcCanvas');
    cv.addEventListener('mousemove',onHover);
    cv.addEventListener('mouseleave',()=>{document.getElementById('fcTip').style.opacity=0;drawChart();});
    new ResizeObserver(()=>drawChart()).observe(document.getElementById('forecastChart'));

    initFcly();
    selectSku('');
  }

  // Period-over-period compares the forward window with weekday-aligned historical shipments.
  let fclyHorizon=4, fclyPage=1;
  const fclyPageSize=25;
  const fclySort={key:'units',dir:'desc'};

  // Update the forward window and trailing backtest accuracy for the chosen horizon.
  window.fclyPickHorizon=function(btn){
    if(!btn||!window.DATA)return;
    fclyHorizon=+btn.dataset.h;
    fclyPage=1;
    document.querySelectorAll('#fclyHorizonSeg button').forEach(b=>{
      b.classList.toggle('active',b===btn);
      b.setAttribute('aria-pressed',String(b===btn));
    });
    const lblEl=document.getElementById('fclyKpiWapeLabel');
    if(lblEl)lblEl.textContent=String(fclyHorizon);
    fclyRender();
    drawChart();
  };

  // Per-SKU WAPE over the trailing fclyHorizon actual weeks (mirrors
  // trailingWape() above, but scoped to one SKU's a/f arrays instead of
  // DATA.all) — the results table's WAPE column needs per-row numbers,
  // not just the one aggregate KPI chip.
  function fclySkuTrailingWape(o,n){
    const bt=DATA.backtestWeeks||DATA.weeks.length;
    const st=Math.max(0,bt-n);
    return seriesWape(o.a.slice(st,bt),o.f.slice(st,bt)).overall;
  }

  function fclyPeriod(series, weekCount){
    const start=DATA.backtestWeeks??DATA.weeks.length;
    const sumComplete=values=>{
      const window=values?.slice(start,start+weekCount);
      return weekCount>0&&window?.length===weekCount&&window.every(Number.isFinite)
        ?window.reduce((sum,value)=>sum+value,0):null;
    };
    const units=sumComplete(series.f), prior=sumComplete(series.lastYear);
    return {units,prior,change:units!=null&&prior>0?100*(units-prior)/prior:null};
  }

  function fclyPricing(rows,field){
    if(!rows.length||rows.some(row=>row.units==null))return null;
    const selling=rows.filter(row=>row.units>0);
    if(selling.some(row=>!Number.isFinite(DATA.skus[row.sku][field])))return null;
    const amount=selling.reduce((sum,row)=>sum+row.units*DATA.skus[row.sku][field],0);
    return field==='avgPrice'?amount:selling.length
      ?amount/selling.reduce((sum,row)=>sum+row.units,0):null;
  }

  function fclyChange(value){
    return value==null?'—':(value>0?'+':'')+value.toFixed(1)+'%';
  }

  function fclyBuildRows(skuId,zip,weekCount){
    const ids=skuId==='ALL'?Object.keys(DATA.skus):[skuId];
    return ids.flatMap(id=>{
      const series=zip?DATA.skus[id]?.byZip?.[zip]:DATA.skus[id];
      if(!series)return [];
      const period=fclyPeriod(series,weekCount);
      // Same estimate as the Revenue card: forecast units × the SKU's
      // historical average selling price (null when either is missing).
      const price=DATA.skus[id]?.avgPrice;
      const revenue=period.units!=null&&Number.isFinite(price)?period.units*price:null;
      return [{sku:id,...period,revenue,wape:fclySkuTrailingWape(series,fclyHorizon)}];
    });
  }

  // Compact money-style figure for the KPI card (no currency symbol: the
  // input data doesn't say which currency its prices are in).
  function fclyCompact(value){
    if(value==null)return '—';
    const abs=Math.abs(value);
    if(abs>=1e9)return (value/1e9).toFixed(2)+'B';
    if(abs>=1e6)return (value/1e6).toFixed(2)+'M';
    if(abs>=1e4)return (value/1e3).toFixed(1)+'K';
    return value.toLocaleString(undefined,{maximumFractionDigits:2});
  }

  function fclyRender(){
    if(!window.DATA)return;
    const [skuId,zip]=curSel.split('|');
    const series=zip?forecastZipSeries(skuId,zip):skuId==='ALL'?DATA.all:DATA.skus[skuId];
    if(!series)return;
    const forecastStart=DATA.backtestWeeks??DATA.weeks.length;
    const future=(zip?series:DATA.all).f.slice(forecastStart,forecastStart+fclyHorizon);
    const gap=future.findIndex(value=>!Number.isFinite(value));
    const weekCount=gap<0?future.length:gap;
    const period=fclyPeriod(series,weekCount);
    const setTxt=(id,v)=>{const el=document.getElementById(id); if(el)el.textContent=v;};
    const comparison=period.change!=null;
    const horizon=weekCount<fclyHorizon?weekCount+' of '+fclyHorizon+' weeks available':'';
    const span='Next '+(weekCount||fclyHorizon)+' week'+((weekCount||fclyHorizon)===1?'':'s');
    const kpi=(id,text,dim)=>{const el=document.getElementById(id); if(!el)return; el.textContent=text; el.classList.toggle('fc-dim',!!dim);};

    kpi('fclyKpiUnits',period.units==null?'—':nfFull(period.units),period.units==null);
    const delta=document.getElementById('fclyYoY');
    delta.hidden=!comparison;
    delta.textContent=comparison?fclyChange(period.change)+' vs LY':'';
    delta.dataset.direction=period.change>0?'up':period.change<0?'down':'';
    setTxt('fclyUnitsDetail',period.units==null?'Forecast units unavailable':
      (comparison?span+' · last year '+nfFull(period.prior):span+' · no last-year data')+(horizon?' · '+horizon:''));

    const w=series===DATA.all?trailingWape(fclyHorizon):fclySkuTrailingWape(series,fclyHorizon);
    kpi('fclyKpiWape',w==null?'—':w.toFixed(1)+'%',w==null);

    let rows=fclyBuildRows(skuId,zip,weekCount);
    const revenue=fclyPricing(rows,'avgPrice');
    const discount=fclyPricing(rows,'avgDiscount');
    kpi('fclyKpiRevenue',fclyCompact(revenue),revenue==null);
    document.getElementById('fclyKpiRevenue').title=revenue==null?'':revenue.toLocaleString(undefined,{maximumFractionDigits:2});
    setTxt('fclyRevenueDetail',revenue==null?'Price data unavailable':'Estimated from historical prices');
    kpi('fclyKpiDiscount',discount==null?'—':discount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}),discount==null);
    setTxt('fclyDiscountDetail',discount==null?'Discount data unavailable':'Historical average, weighted by forecast units');
    rows.sort((a,b)=>{
      const av=a[fclySort.key],bv=b[fclySort.key];
      const dir=fclySort.dir==='asc'?1:-1;
      if(typeof av==='string')return av.localeCompare(bv)*dir;
      if(av==null&&bv==null)return 0;
      if(av==null)return 1; if(bv==null)return -1;
      return (av-bv)*dir;
    });

    const total=rows.length, pageCount=Math.max(1,Math.ceil(total/fclyPageSize));
    fclyPage=Math.min(fclyPage,pageCount);
    const start=(fclyPage-1)*fclyPageSize;
    rows=rows.slice(start,start+fclyPageSize);
    setTxt('fclyResultsCount',total
      ? 'Showing '+(start+1).toLocaleString()+'–'+(start+rows.length).toLocaleString()+' of '+total.toLocaleString()+' SKUs'
      : 'No SKUs');
    const previous=document.getElementById('fclyPrevPage');
    const next=document.getElementById('fclyNextPage');
    previous.hidden=next.hidden=pageCount===1;
    previous.disabled=fclyPage===1;
    next.disabled=fclyPage===pageCount;
    document.getElementById('fclyTableScroll').scrollTop=0;

    document.querySelectorAll('#fclyResultsTable .amp-sortable').forEach(th=>{
      const icon=th.querySelector('.ov-sort-ic'); if(!icon)return;
      if(th.dataset.sortKey===fclySort.key){
        icon.textContent=fclySort.dir==='asc'?'↑':'↓';
        icon.style.opacity='';
        th.setAttribute('aria-sort',fclySort.dir==='asc'?'ascending':'descending');
      } else {
        icon.textContent='⇅'; icon.style.opacity='';
        th.removeAttribute('aria-sort');
      }
    });

    const body=document.getElementById('fclyResultsBody');
    if(!body)return;
    if(!rows.length){
      body.innerHTML='<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted);font-family:var(--body)">No SKUs match your current filter.</td></tr>';
      return;
    }
    const cell=(value,text,cls)=>`<td class="fcly-number${value==null?' ov-dim':cls?' '+cls:''}">${value==null?'—':text}</td>`;
    body.innerHTML=rows.map(r=>
      `<tr><th scope="row" class="skucell">${escHtml(r.sku)}</th>`+
      cell(r.units,r.units==null?'':nfFull(r.units))+
      cell(r.prior,r.prior==null?'':nfFull(r.prior))+
      cell(r.change,fclyChange(r.change),r.change>0?'fc-up':r.change<0?'fc-down':'')+
      cell(r.revenue,r.revenue==null?'':Math.round(r.revenue).toLocaleString())+
      cell(r.wape,r.wape==null?'':r.wape.toFixed(1)+'%')+
      '</tr>'
    ).join('');
  }

  function initFcly(){
    const skuSel=document.getElementById('fclySkuFilter');
    if(!skuSel)return; // this tab's markup isn't on the current page
    skuSel.innerHTML='<option value="ALL">All SKUs</option>'+
      Object.keys(DATA.skus).sort().map(id=>`<option value="${id}">${id}</option>`).join('');
    skuSel.addEventListener('change',e=>{
      const id=e.target.value;
      const zip=document.getElementById('zipInput').value;
      selectSku(zip&&(id==='ALL'||DATA.skus[id]?.byZip?.[zip])?id+'|'+zip:id);
    });
    document.getElementById('fclyPrevPage').addEventListener('click',()=>{fclyPage=Math.max(1,fclyPage-1);fclyRender();});
    document.getElementById('fclyNextPage').addEventListener('click',()=>{fclyPage++;fclyRender();});
    document.querySelectorAll('#fclyResultsTable .amp-sortable').forEach(th=>{
      th.addEventListener('click',()=>{
        const key=th.dataset.sortKey;
        if(fclySort.key===key)fclySort.dir=fclySort.dir==='asc'?'desc':'asc';
        else{fclySort.key=key;fclySort.dir=(key==='sku'||key==='wape')?'asc':'desc';}
        fclyPage=1;
        fclyRender();
      });
    });
  }

  function selectSku(sel){
    const s=getSeries(sel||'ALL');
    if(!s){ document.getElementById('selName').textContent='SKU “'+sel+'” not found';
            document.getElementById('selWape').textContent='—'; return; }
    if(curSel!==(sel||'ALL'))fclyPage=1;
    curSel=sel||'ALL';
    document.getElementById('selName').textContent=s.name;
    document.getElementById('selWape').textContent=s.overall==null?'—':s.overall.toFixed(2)+'%';
    drawChart();
    const [baseSkuId,zip]=curSel.split('|');
    document.getElementById('skuInput').value=baseSkuId==='ALL'?'':baseSkuId;
    document.getElementById('fclySkuFilter').value=baseSkuId;
    renderZipFilter(baseSkuId,zip||'');
    fclyRender();
  }

  function renderZipFilter(skuId,selectedZip){
    const sel=document.getElementById('zipInput');
    const skus=skuId==='ALL'?Object.values(DATA.skus):[DATA.skus[skuId]];
    const zips=[...new Set(skus.flatMap(sku=>Object.keys(sku?.byZip||{})))].sort();
    sel.replaceChildren(new Option('All ZIP codes',''),...zips.map(zip=>new Option(zip,zip)));
    sel.disabled=!zips.length;
    sel.title=zips.length?'Filter by ZIP code':'ZIP code data unavailable';
    sel.value=zips.includes(selectedZip)?selectedZip:'';
  }

  function drawChart(){
    const s=getSeries(curSel); if(!s)return;
    const fcSkel=document.getElementById('fcChartSkel');
    if(fcSkel)fcSkel.style.display='none';
    const length=DATA.weeks.length;
    const boundaryIndex=DATA.backtestWeeks ?? length;
    const hasForward=boundaryIndex<length;
    // Default view: a few recent actual weeks for context, then the forecast
    // horizon. "Full history" shows the whole backtest as well.
    const context=hasForward?Math.min(boundaryIndex,Math.max(8,Math.min(fclyHorizon,26))):0;
    const end=hasForward?Math.min(length,boundaryIndex+fclyHorizon):length;
    const start=hasForward?fcBacktest.from(hideBacktest?boundaryIndex-context:0,boundaryIndex,fcVisible.a):Math.max(0,length-fclyHorizon);
    const N=end-start, st=start;
    const weeks=DATA.weeks.slice(st,end), a=s.a.slice(st,end);
    const shown=v=>hasForward?fcBacktest.past(v.slice(st,end),boundaryIndex-st):v.slice(st,end);
    const f=shown(s.f), w=shown(s.w);
    const hasA=s.a.some(Number.isFinite), hasW=w.some(Number.isFinite);
    document.querySelectorAll('#fcLegend .lgd-item').forEach(el=>{
      el.hidden=(el.dataset.k==='a'&&!hasA)||(el.dataset.k==='w'&&!hasW);
    });
    const sub=document.getElementById('fcChartSub');
    if(sub)sub.textContent=!hasForward?'Last '+N+' weeks of the backtest'
      :fcBacktest.subtitle(!hideBacktest,context,end-boundaryIndex,fcVisible.a);
    const box=document.getElementById('forecastChart'), cv=document.getElementById('fcCanvas');
    fcGeom=paintForecast(box,cv,{weeks,a,f,w,boundary:(DATA.backtestWeeks||DATA.weeks.length)-st,visible:fcVisible});
  }

  // The weekly forecast chart, drawn the same way on Forecasts and in the
  // Scenario workspace (which adds `plan`, the approved forecast).
  function paintForecast(box,cv,{weeks,a,f,w,plan=[],boundary,visible}){
    const N=weeks.length;
    const showW=w.some(Number.isFinite)&&visible.w;
    const showPlan=plan.some(Number.isFinite)&&visible.p;
    const cw=box.clientWidth||720, ch=box.clientHeight||260, dpr=window.devicePixelRatio||1;
    cv.width=cw*dpr; cv.height=ch*dpr; const ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,cw,ch);
    const padL=52,padR=showW?46:18,padT=16,padB=26;
    const P=fcPalette();
    const uMax=Math.max(1,...a.filter(Number.isFinite),...f.filter(Number.isFinite),...(showPlan?plan.filter(Number.isFinite):[]))*1.12;
    const wVals=w.filter(x=>x!=null); const wMax=(wVals.length?Math.max(1,...wVals):100)*1.15;
    const X=i=>padL+i*(cw-padL-padR)/(N-1||1);
    const Yu=v=>padT+(ch-padT-padB)*(1-v/uMax);
    const Yw=v=>padT+(ch-padT-padB)*(1-v/wMax);
    // grid + left axis (units) + right axis (wape)
    ctx.font='10px JetBrains Mono';
    for(let g=0;g<=4;g++){const y=padT+(ch-padT-padB)*g/4;
      ctx.strokeStyle=P.grid;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(cw-padR,y);ctx.stroke();
      ctx.fillStyle=P.axis;ctx.textAlign='right';ctx.fillText(nf(uMax*(1-g/4)),padL-8,y+3);
      if(showW){ctx.textAlign='left';ctx.fillStyle=P.wape;ctx.fillText(Math.round(wMax*(1-g/4))+'%',cw-padR+8,y+3);}}
    // x labels (~7)
    ctx.fillStyle=P.axis;ctx.textAlign='center';
    const step=Math.max(1,Math.round(N/7));
    for(let i=0;i<N;i+=step){const d=weeks[i].slice(5);ctx.fillText(d,X(i),ch-8);}
    const line=(arr,Y,color,dash)=>{ctx.strokeStyle=color;ctx.lineWidth=2.2;ctx.setLineDash(dash||[]);
      ctx.beginPath();let started=false;
      arr.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Y(v);if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);});
      ctx.stroke();ctx.setLineDash([]);};
    // area under actual
    if(visible.a){
      const grad=ctx.createLinearGradient(0,padT,0,ch-padB);
      grad.addColorStop(0,'rgba('+P.actualFill+',.22)');grad.addColorStop(1,'rgba('+P.actualFill+',0)');
      ctx.beginPath();let sx=null;a.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Yu(v);if(sx===null){ctx.moveTo(x,y);sx=x;}else ctx.lineTo(x,y);});
      let lastA=-1; a.forEach((v,i)=>{if(v!=null)lastA=i;});
      if(sx!==null){ctx.lineTo(X(lastA),Yu(0));ctx.lineTo(sx,Yu(0));ctx.closePath();ctx.fillStyle=grad;ctx.fill();}
    }
    if(showW) line(w,Yw,P.wape);                          // wape (right axis)
    if(showPlan) line(plan,Yu,P.plan,[2,4]);             // approved plan (dotted)
    if(visible.a) line(a,Yu,P.actual);                  // actual
    const fcLime=P.forecast;
    if(visible.f) line(f,Yu,fcLime,[7,5]);              // forecast (dashed)
    // Short ranges get point markers so individual weeks are readable.
    if(N<=16){
      const dots=(arr,color)=>{ctx.fillStyle=color;arr.forEach((v,i)=>{if(v==null)return;ctx.beginPath();ctx.arc(X(i),Yu(v),2.6,0,7);ctx.fill();});};
      if(visible.a)dots(a,P.actual);
      if(showPlan)dots(plan,P.plan);
      if(visible.f)dots(f,fcLime);
    }
    // "today" divider — backtest ends, forward-only forecast begins (skip if data has no forward portion, e.g. older cached format)
    if(boundary>0&&boundary<N){
      const bx=X(boundary-0.5);
      ctx.strokeStyle=P.divider;ctx.setLineDash([3,3]);
      ctx.beginPath();ctx.moveTo(bx,padT);ctx.lineTo(bx,ch-padB);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle=P.axis;ctx.font='9px JetBrains Mono';ctx.textAlign='left';
      ctx.fillText('FORECAST →',bx+4,padT+10);
    }
    return {weeks,a,f,w,plan,X,Yu,Yw,N,padL,padR,cw,ch,padT,padB,showW,showPlan};
  }

  function onHover(e){
    forecastHover(e,()=>{drawChart();return fcGeom;},document.getElementById('fcCanvas'),document.getElementById('fcTip'));
  }

  // Crosshair, dots and tooltip for a paintForecast chart.
  function forecastHover(e,redraw,cv,tip){
    const x=e.clientX, rect=e.currentTarget.getBoundingClientRect();
    const g=redraw(); if(!g?.N)return;
    const mx=x-rect.left;
    let i=Math.round((mx-g.padL)/((g.cw-g.padL-g.padR)/(g.N-1||1)));
    i=Math.max(0,Math.min(g.N-1,i));
    const ctx=cv.getContext('2d');
    ctx.strokeStyle='rgba(200,242,78,.35)';ctx.setLineDash([3,4]);ctx.beginPath();
    ctx.moveTo(g.X(i),g.padT);ctx.lineTo(g.X(i),g.ch-g.padB);ctx.stroke();ctx.setLineDash([]);
    const dot=(v,Y,c)=>{if(v==null)return;ctx.fillStyle=c;ctx.beginPath();ctx.arc(g.X(i),Y(v),3.5,0,7);ctx.fill();};
    const P=fcPalette();
    dot(g.a[i],g.Yu,P.actual);if(g.showPlan)dot(g.plan[i],g.Yu,P.plan);dot(g.f[i],g.Yu,P.forecast);if(g.showW)dot(g.w[i],g.Yw,P.wape);
    const row=(c,l,val)=>`<div class="rw"><i style="background:${c}"></i>${l}<b>${val}</b></div>`;
    tip.innerHTML=`<div class="wk">${g.weeks[i]}</div>`+
      row(P.actual,'Actual',g.a[i]==null?'—':nfFull(g.a[i]))+
      row(P.forecast,'Forecast',g.f[i]==null?'—':nfFull(g.f[i]))+
      (g.showPlan?row(P.plan,'Approved plan',g.plan[i]==null?'—':nfFull(g.plan[i])):'')+
      row(P.wape,'WAPE',g.w[i]==null?'—':g.w[i].toFixed(1)+'%');
    tip.style.opacity=1;
    let tx=g.X(i); const half=tip.offsetWidth/2;
    tx=Math.max(half+4,Math.min(g.cw-half-4,tx));
    tip.style.left=tx+'px'; tip.style.top=(g.padT+6)+'px';
  }

  /* ===== AI ANALYST CHATBOT (offline, grounded in DATA) ===== */
  let cbStats=null;
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
    + '<ellipse cx="16" cy="19" rx="7.8" ry="9" fill="#E8B685"/>'
    + '<circle cx="16" cy="8" r="7.2" fill="#2B2118"/>'
    + '<rect x="6" y="16" width="7" height="5.6" rx="2" stroke="var(--lyra-frame,#54E6C4)" stroke-width="1.3" fill="var(--lyra-frame-fill,rgba(84,230,196,0.1))"/>'
    + '<rect x="19" y="16" width="7" height="5.6" rx="2" stroke="var(--lyra-frame,#54E6C4)" stroke-width="1.3" fill="var(--lyra-frame-fill,rgba(84,230,196,0.1))"/>'
    + '<line x1="13" y1="18.6" x2="19" y2="18.6" stroke="var(--lyra-frame,#54E6C4)" stroke-width="1.3" stroke-linecap="round"/>'
    + '<line x1="6" y1="18" x2="4" y2="17" stroke="var(--lyra-frame,#54E6C4)" stroke-width="1.1" stroke-linecap="round"/>'
    + '<line x1="26" y1="18" x2="28" y2="17" stroke="var(--lyra-frame,#54E6C4)" stroke-width="1.1" stroke-linecap="round"/>'
    + '<ellipse cx="9.4" cy="18.8" rx="1.4" ry="1.6" fill="#1a1a2e"/>'
    + '<ellipse cx="22.6" cy="18.8" rx="1.4" ry="1.6" fill="#1a1a2e"/>'
    + '<circle cx="10.1" cy="18.1" r="0.5" fill="white"/>'
    + '<circle cx="23.3" cy="18.1" r="0.5" fill="white"/>'
    + '<circle cx="10.5" cy="22" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<circle cx="12" cy="22.6" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<circle cx="20" cy="22.6" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<circle cx="21.5" cy="22" r="0.35" fill="#c47a5a" opacity=".5"/>'
    + '<path d="M13 24.5 Q16 27 19 24.5" stroke="#a5623f" stroke-width="1.2" stroke-linecap="round" fill="none"/>'
    + '<path d="M9 31 Q13 28 16 27.5 Q19 28 23 31" fill="#7AA2FF" opacity="0.65"/>'
    + '</svg>';

  /* ===== Voice narration (Web Speech API) — read a reply, the AI Insights
     brief, or a scenario summary aloud. No backend, no new dependency;
     nothing else in the product uses audio. One utterance at a time —
     starting a new one cancels whatever's already playing, which also
     resets that button's own state via its onend/onerror handler. ===== */
  const CB_SPEAK_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  const CB_COPY_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const CB_CHECK_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  let cbSpeakingBtn=null;
  function cbStripHtml(html){
    const tmp=document.createElement('div');
    tmp.innerHTML=String(html).replace(/<br\s*\/?>/gi,' ');
    return (tmp.textContent||tmp.innerText||'').replace(/\s+/g,' ').trim();
  }
  function cbSpeak(text,btn){
    if(!('speechSynthesis' in window)||!text)return;
    const synth=window.speechSynthesis;
    const wasThisBtn=(cbSpeakingBtn===btn);
    synth.cancel(); // stops whatever's playing; that utterance's own onend/onerror clears ITS button's state
    if(wasThisBtn){ cbSpeakingBtn=null; return; } // clicking the active button again just stops it
    const utter=new SpeechSynthesisUtterance(text);
    utter.onend=utter.onerror=()=>{
      if(btn)btn.classList.remove('speaking');
      if(cbSpeakingBtn===btn)cbSpeakingBtn=null;
    };
    if(btn)btn.classList.add('speaking');
    cbSpeakingBtn=btn;
    synth.speak(utter);
  }
  // Reusable "🔊 read this" button — call with the plain text to speak and
  // (optionally) an extra CSS class for context-specific sizing/placement.
  function cbSpeakBtn(text,extraClass){
    if(!('speechSynthesis' in window))return null;
    const btn=document.createElement('button');
    btn.type='button'; btn.className='cb-speak-btn'+(extraClass?' '+extraClass:'');
    btn.setAttribute('aria-label','Read this aloud');
    btn.innerHTML=CB_SPEAK_ICON;
    btn.onclick=()=>cbSpeak(text,btn);
    return btn;
  }

  // Copy-to-clipboard for a message bubble — plain text (HTML tags/line
  // breaks stripped via cbStripHtml, same source cbSpeakBtn already reads
  // for narration) rather than the raw HTML, so pasting elsewhere doesn't
  // carry markup. Reuses .cb-speak-btn's base look (same circular button)
  // rather than inventing new sizing/hover rules for a second small icon
  // button living in the same spot.
  function cbCopyBtn(text,extraClass){
    if(!text)return null;
    const btn=document.createElement('button');
    btn.type='button'; btn.className='cb-speak-btn cb-copy-btn'+(extraClass?' '+extraClass:'');
    btn.setAttribute('aria-label','Copy this message');
    btn.title='Copy';
    btn.innerHTML=CB_COPY_ICON;
    let resetTimer=null;
    btn.onclick=()=>{
      if(!navigator.clipboard||!navigator.clipboard.writeText)return;
      navigator.clipboard.writeText(text).then(()=>{
        clearTimeout(resetTimer);
        btn.innerHTML=CB_CHECK_ICON; btn.classList.add('copied');
        btn.setAttribute('aria-label','Copied');
        resetTimer=setTimeout(()=>{
          btn.innerHTML=CB_COPY_ICON; btn.classList.remove('copied');
          btn.setAttribute('aria-label','Copy this message');
        },1400);
      }).catch(()=>{});
    };
    return btn;
  }

  const cbBody=()=>document.getElementById('cbBody');
  function cbPush(text,who){
    const d=document.createElement('div'); d.className='cb-msg '+who; d.innerHTML=text;
    cbBody().appendChild(d); cbBody().scrollTop=cbBody().scrollHeight;
    d.querySelectorAll('.lk').forEach(l=>l.onclick=()=>cbChart(l.dataset.sku));
    // Copy applies to both sides of the conversation (this is what "I can't
    // copy the text I send to Lyra" was actually about — turns out manual
    // select+copy already worked, but there was no visible affordance for
    // it, same gap most chat products solve with exactly this button);
    // narration stays bot-only, unchanged.
    const plainText=cbStripHtml(text);
    const actions=document.createElement('div'); actions.className='cb-msg-actions';
    const copyBtn=cbCopyBtn(plainText);
    if(copyBtn)actions.appendChild(copyBtn);
    if(who==='bot'){
      const speakBtn=cbSpeakBtn(plainText);
      if(speakBtn)actions.appendChild(speakBtn);
    }
    if(actions.children.length)d.appendChild(actions);
    return d;
  }

  // Renders a small inline chart INTO an existing bot message bubble —
  // chart is {type:'sku_compare', a:{sku,series}, b:{sku,series}} or
  // {type:'range_trend', series, weeks, actual, forecast} from the chat
  // response. Same canvas-color convention as the real dashboard charts
  // (fixed hex, not theme-driven — drawChart/drawOverviewTrend do the
  // same, since a mid-gray/brand palette reads fine on both light and
  // dark card backgrounds without branching).
  function cbRenderChart(container,chart){
    if(!chart||!container)return;
    const wrap=document.createElement('div'); wrap.className='cb-chart';
    const cv=document.createElement('canvas');
    const W=246,H=72,dpr=window.devicePixelRatio||1;
    cv.width=W*dpr; cv.height=H*dpr; cv.style.width=W+'px'; cv.style.height=H+'px';
    const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
    wrap.appendChild(cv); container.appendChild(wrap);

    if(chart.type==='sku_compare'){
      cbDrawTwoLines(ctx,W,H,chart.a.series,'#54E6C4',chart.b.series,'#C8F24E');
      const legend=document.createElement('div'); legend.className='cb-chart-legend';
      legend.innerHTML=`<span><i style="background:#54E6C4"></i>${chart.a.sku}</span>`+
                        `<span><i style="background:#C8F24E"></i>${chart.b.sku}</span>`;
      wrap.appendChild(legend);
    } else if(chart.type==='range_trend'){
      const weeks=chart.weeks||[], actual=chart.actual||[], forecast=chart.forecast||[];
      const hasActual=actual.some(v=>v!=null);
      if(weeks.length<=1){
        // A single matched week has no trend to draw (a line needs 2+
        // points) — fall back to a plain bar pair for that one week,
        // same shape as before, just scoped to the one-week case where
        // it's actually the right visualization instead of the only one.
        cbDrawSingleWeekBars(ctx,W,H,actual[0],forecast[0]);
      } else {
        // Forecast dashed to match the real dashboard chart's own
        // actual(solid)/forecast(dashed) convention — unlike sku_compare,
        // these two lines ARE an actual/forecast pair, not two peers.
        cbDrawTwoLines(ctx,W,H,actual,'#54E6C4',forecast,'#C8F24E',[5,3]);
      }
      const legend=document.createElement('div'); legend.className='cb-chart-legend';
      legend.innerHTML=(hasActual?'<span><i style="background:#54E6C4"></i>Actual</span>':'')+
                        '<span><i style="background:#C8F24E"></i>Forecast</span>';
      wrap.appendChild(legend);
    } else { return; }
    cbBody().scrollTop=cbBody().scrollHeight;
  }

  // Shared by both chart types — two lines over the same index axis,
  // nulls skipped rather than interpolated (a gap in the line is more
  // honest than pretending there's a value where there isn't one).
  function cbDrawTwoLines(ctx,W,H,a,colorA,b,colorB,dashB){
    a=a||[]; b=b||[];
    const all=a.concat(b).filter(v=>v!=null);
    if(!all.length)return;
    const max=Math.max(...all)*1.1||1, pad=6;
    const N=Math.max(a.length,b.length,1);
    const X=i=>pad+i*(W-pad*2)/(N-1||1), Y=v=>H-pad-(v/max)*(H-pad*2);
    const line=(arr,color,dash)=>{
      ctx.strokeStyle=color; ctx.lineWidth=1.8; ctx.setLineDash(dash||[]); ctx.beginPath();
      let started=false;
      arr.forEach((v,i)=>{
        if(v==null)return;
        const x=X(i),y=Y(v);
        if(!started){ctx.moveTo(x,y);started=true;} else ctx.lineTo(x,y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    };
    line(a,colorA); line(b,colorB,dashB);
  }

  function cbDrawSingleWeekBars(ctx,W,H,actualV,forecastV){
    const vals=[{label:'Actual',v:actualV,color:'#54E6C4'},{label:'Forecast',v:forecastV,color:'#C8F24E'}]
      .filter(x=>x.v!=null);
    if(!vals.length)return;
    const max=Math.max(...vals.map(x=>x.v))*1.2||1;
    const padTop=16,padBottom=16,barW=54,gap=30;
    const totalW=vals.length*barW+(vals.length-1)*gap;
    const startX=(W-totalW)/2;
    vals.forEach((x,i)=>{
      const bx=startX+i*(barW+gap);
      const bh=(H-padTop-padBottom)*(x.v/max);
      const by=H-padBottom-bh;
      ctx.fillStyle=x.color; ctx.fillRect(bx,by,barW,bh);
      ctx.fillStyle='#5C6878'; ctx.font='10px JetBrains Mono'; ctx.textAlign='center';
      ctx.fillText(x.label,bx+barW/2,H-4);
      ctx.font='600 11px JetBrains Mono';
      ctx.fillText(nfFull(x.v),bx+barW/2,by-6); // full digits — nf()'s K/M rounding
                                                  // can make two distinct totals both read "5K"
    });
  }

  const CHAT_API = 'https://ktksptlz75.execute-api.us-east-1.amazonaws.com/chat';

  // Chat tabs — multiple independent conversations in the same panel, like
  // browser tabs. Each tab owns its own API-context history (same shape
  // cbHistory used to be) and a replay `log` of what's been shown on
  // screen (rendered html + optional chart), used to reconstruct cbBody
  // when switching back to a tab rather than re-fetching anything. Kept
  // in-memory only (same as the old single-conversation cbHistory was) —
  // reloading the page resets every tab, not just the active one.
  let cbTabs = [];
  let cbActiveTabId = null;
  let cbTabSeq = 0;

  function cbNewTabObj(){
    cbTabSeq++;
    return {id:'t'+cbTabSeq, title:'New chat', history:[], log:[], booted:false};
  }
  function cbActiveTab(){
    return cbTabs.find(t=>t.id===cbActiveTabId) || null;
  }
  // Auto-names a tab from its first user message, once — later messages
  // don't rename it, same as most chat products' "first message = title".
  function cbSetTabTitle(t, text){
    if(t.title!=='New chat')return;
    t.title = text.length>28 ? text.slice(0,28)+'…' : text;
    cbRenderTabsStrip();
  }
  // Pushes to cbBody AND records into the active tab's replay log, so a
  // later switch back to this tab can reconstruct it. Plain cbPush (no
  // logging) is used only during that reconstruction itself, to avoid
  // re-recording what's already in the log.
  function cbLog(html, who, chart){
    const el = cbPush(html, who);
    const t = cbActiveTab();
    if(t) t.log.push({html:html, who:who, chart:chart||null});
    if(chart) cbRenderChart(el, chart);
    return el;
  }
  function cbRenderActiveTab(){
    const body = cbBody(); if(!body)return;
    body.innerHTML = '';
    const t = cbActiveTab();
    if(!t)return;
    if(!t.booted){
      t.booted = true;
      cbLog(`Hi — I'm <b>Lyra</b>, your AI demand analyst. Ask me anything about the 2024 forecast backtest, or tap a suggestion below. 👇`, 'bot');
    } else {
      t.log.forEach(function(entry){
        const el = cbPush(entry.html, entry.who);
        if(entry.chart) cbRenderChart(el, entry.chart);
      });
    }
  }
  function cbRenderTabsStrip(){
    const wrap = document.getElementById('cbTabsScroll');
    if(!wrap)return;
    wrap.innerHTML = '';
    cbTabs.forEach(function(t){
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'cb-tab' + (t.id===cbActiveTabId ? ' active' : '');
      pill.title = t.title;
      const label = document.createElement('span');
      label.className = 'cb-tab-label'; label.textContent = t.title;
      const x = document.createElement('span');
      x.className = 'cb-tab-x'; x.setAttribute('aria-label','Close chat'); x.textContent = '×';
      pill.appendChild(label); pill.appendChild(x);
      pill.onclick = function(e){
        if(e.target===x){ e.stopPropagation(); cbCloseTab(t.id); return; }
        cbSwitchTab(t.id);
      };
      wrap.appendChild(pill);
    });
  }
  function cbSwitchTab(id){
    if(id===cbActiveTabId)return;
    cbActiveTabId = id;
    cbRenderActiveTab();
    cbRenderTabsStrip();
  }
  function cbNewTab(){
    const t = cbNewTabObj();
    cbTabs.push(t);
    cbActiveTabId = t.id;
    cbRenderActiveTab();
    cbRenderTabsStrip();
    setTimeout(()=>{const i=document.getElementById('cbText'); if(i)i.focus();},50);
  }
  // Always leaves at least one tab open — closing the last one starts a
  // fresh one instead of leaving the panel with no active conversation.
  function cbCloseTab(id){
    const idx = cbTabs.findIndex(t=>t.id===id);
    if(idx===-1)return;
    cbTabs.splice(idx,1);
    if(cbTabs.length===0){ cbNewTab(); return; }
    if(id===cbActiveTabId){
      const next = cbTabs[Math.max(0, idx-1)];
      cbActiveTabId = next.id;
      cbRenderActiveTab();
    }
    cbRenderTabsStrip();
  }

  function cbNavLi(name){
    var items=document.querySelectorAll('.dnav li');
    for(var i=0;i<items.length;i++){ if(items[i].textContent.trim()===name) return items[i]; }
    return null;
  }
  var cbPointTimer=null, cbPointEl=null, cbPointArrow=null, cbPointBackdrop=null, cbBackdropTimer=null;
  function cbClearPoint(){
    if(cbPointTimer){ clearTimeout(cbPointTimer); cbPointTimer=null; }
    if(cbBackdropTimer){ clearTimeout(cbBackdropTimer); cbBackdropTimer=null; }
    if(cbPointEl){ cbPointEl.classList.remove('cb-nav-point'); cbPointEl=null; }
    if(cbPointArrow){ cbPointArrow.remove(); cbPointArrow=null; }
    if(cbPointBackdrop){ cbPointBackdrop.remove(); cbPointBackdrop=null; }
  }
  // The sidebar page the user is on, so Lyra can resolve "this page".
  function cbCurrentPage(){
    var li=document.querySelector('.dnav li.active');
    return li ? li.textContent.trim() : '';
  }
  function cbPointTo(name){
    cbClearPoint();
    var li=cbNavLi(name);
    if(!li) return; // no matching nav item on this page — silent no-op
    // Items in a collapsed sidebar group (Ads, Forecast) are hidden — open
    // the group first so the highlight and arrow land on a visible item.
    if(li.offsetParent===null){
      var groupToggle=li.hasAttribute('data-ads-nav') ? document.getElementById('ads-nav-toggle')
        : li.hasAttribute('data-forecast-nav') ? document.getElementById('forecast-nav-toggle') : null;
      if(groupToggle && groupToggle.getAttribute('aria-expanded')!=='true') groupToggle.click();
    }
    li.classList.add('cb-nav-point');
    cbPointEl=li;
    var r=li.getBoundingClientRect();
    var arrow=document.createElement('div');
    arrow.className='cb-arrow'; arrow.textContent='←';
    arrow.style.left=(r.right+12)+'px'; arrow.style.top=(r.top+r.height/2-21)+'px';
    document.body.appendChild(arrow);
    cbPointArrow=arrow;

    // Blurs the rest of the dashboard for 3s so the arrow+glow actually
    // register instead of blending into the page — shorter than the 6s
    // highlight itself, which stays up a bit longer once attention's caught.
    var backdrop=document.createElement('div');
    backdrop.className='cb-point-backdrop';
    document.body.appendChild(backdrop);
    cbPointBackdrop=backdrop;
    cbBackdropTimer=setTimeout(function(){
      if(cbPointBackdrop){ cbPointBackdrop.remove(); cbPointBackdrop=null; }
      cbBackdropTimer=null;
    },3000);

    cbPointTimer=setTimeout(cbClearPoint,6000);
    li.addEventListener('click',cbClearPoint,{once:true});
    document.addEventListener('click',function dismissOnce(e){
      if(e.target===li||li.contains(e.target)) return; // the li's own click listener already handles this case
      cbClearPoint();
    },{once:true});
  }

  // Draws a pulsing ring + callout right on the real forecast chart, at the
  // exact point explain_forecast_day is talking about — annot is
  // {sku, week_of, label} from the chat response. Switches to Forecasts and
  // selects the right series first (or the all-SKU view when sku is null),
  // widens the visible window so the target week is guaranteed on screen
  // regardless of whatever period was showing, then positions the overlay
  // using the SAME axis geometry (fcGeom) drawChart() itself just computed
  // — not a reimplementation of the chart's math.
  var cbAnnotEl=null, cbAnnotTimer=null;
  function cbClearAnnotation(){
    if(cbAnnotTimer){ clearTimeout(cbAnnotTimer); cbAnnotTimer=null; }
    if(cbAnnotEl){ cbAnnotEl.remove(); cbAnnotEl=null; }
  }
  function cbAnnotateChart(annot){
    if(!annot||!annot.week_of)return;
    cbClearAnnotation();
    goToPanel('Forecasts');

    // Include the backtest before drawing the annotated selection.
    hideBacktest=false;
    fcBacktest.set(false,false);
    const hideBtBtn=document.getElementById('hideBacktestBtn');
    if(hideBtBtn){ hideBtBtn.classList.remove('on'); hideBtBtn.textContent='Recent weeks'; hideBtBtn.setAttribute('aria-pressed','true'); }

    const input=document.getElementById('skuInput');
    if(annot.sku){ if(input)input.value=annot.sku; selectSku(annot.sku); }
    else { if(input)input.value=''; selectSku('ALL'); }
    // selectSku leaves curSel untouched (rather than throwing) when the SKU
    // isn't found — this catches that silent-failure case instead of
    // annotating against a stale, unrelated chart draw.
    if(curSel!==(annot.sku||'ALL'))return;

    if(!fcGeom)return;
    const idx=fcGeom.weeks.indexOf(annot.week_of);
    if(idx<0)return; // shouldn't happen (the week came from this same forecast), but don't guess a position
    const v=fcGeom.a[idx]!=null?fcGeom.a[idx]:fcGeom.f[idx];
    if(v==null)return;
    const x=fcGeom.X(idx), y=fcGeom.Yu(v);

    const wrap=document.createElement('div');
    wrap.className='cb-chart-annot';
    wrap.style.left=x+'px'; wrap.style.top=y+'px';
    const safeLabel=(annot.label||annot.week_of).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    wrap.innerHTML='<div class="cb-chart-ring"></div><div class="cb-chart-callout">'+safeLabel+'</div>';
    document.getElementById('forecastChart').appendChild(wrap);
    cbAnnotEl=wrap;
    cbAnnotTimer=setTimeout(cbClearAnnotation,7000);
  }

  // A brief, tasteful confetti burst for real milestones — a scenario Lyra
  // just approved, or one of the user's own runs flipping to completed
  // while they're still around (see checkRunCompletion in scenarios.js).
  // Bursts from the chat launcher's corner so it visually ties back to
  // Lyra rather than reading as a generic page-wide effect. Pure canvas,
  // no dependencies, self-removing — never blocks input (pointer-events:none)
  // and never outlives its own ~1.2s animation.
  window.cbCelebrate=function(){
    var cv=document.createElement('canvas');
    cv.style.cssText='position:fixed;inset:0;z-index:9996;pointer-events:none';
    cv.width=innerWidth; cv.height=innerHeight;
    document.body.appendChild(cv);
    var ctx=cv.getContext('2d');
    var colors=['#C8F24E','#54E6C4','#7AA2FF','#ff8585','#ffcf5c'];
    var particles=[];
    for(var i=0;i<90;i++){
      particles.push({
        x:innerWidth-70+(Math.random()-0.5)*60,
        y:innerHeight-70+(Math.random()-0.5)*30,
        vx:(Math.random()-0.5)*6-2,
        vy:Math.random()*-9-4,
        g:0.18+Math.random()*0.08,
        size:4+Math.random()*4,
        color:colors[i%colors.length],
        rot:Math.random()*Math.PI*2,
        vr:(Math.random()-0.5)*0.3,
      });
    }
    var DUR=1200, start=performance.now();
    (function frame(now){
      var t=now-start, alpha=Math.max(0,1-t/DUR);
      ctx.clearRect(0,0,cv.width,cv.height);
      particles.forEach(function(p){
        p.vy+=p.g; p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr;
        ctx.save(); ctx.globalAlpha=alpha; ctx.translate(p.x,p.y); ctx.rotate(p.rot);
        ctx.fillStyle=p.color; ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size*0.6);
        ctx.restore();
      });
      if(t<DUR) requestAnimationFrame(frame); else cv.remove();
    })(start);
  };

  function cbMd(text){
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\n\n+/g,'<br><br>')
      .replace(/\n/g,'<br>');
  }

  function cbAsk(q){
    if(!q.trim())return;
    // Captured now, not read again later — the response arrives async and
    // the user may have switched (or closed) tabs by then. Every use below
    // targets THIS tab specifically, not "whatever's active when the
    // response lands".
    const askedTab = cbActiveTab();
    if(!askedTab)return;
    const qEsc = q.replace(/</g,'&lt;');
    cbLog(qEsc,'user');
    askedTab.history.push({role:'user',content:q});
    cbSetTabTitle(askedTab, q);

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

    var chatFetch=location.pathname.startsWith('/dashboard') ? APRA_SESSION.fetch : fetch;
    chatFetch(CHAT_API,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        message: q,
        history: askedTab.history.slice(0,-1).slice(-8),
        extra_instructions: extraHint,
        page: cbCurrentPage(),
        temperature: tp.temperature,
        max_tokens: sp.max_tokens
      })
    })
    .then(function(r){return r.json();})
    .then(function(d){
      // Still the visible tab? Render live (and run the on-screen side
      // effects below). Otherwise just record it into that tab's own log/
      // history — cbRenderActiveTab() replays it correctly whenever the
      // user switches back, and side effects that touch the rest of the
      // page (annotate/point-to/open a scenario/confetti) are skipped
      // rather than firing for a question the user isn't looking at.
      const stillActive = askedTab.id===cbActiveTabId;
      if(stillActive){ typ.remove(); if(cbOrbEl) cbOrbEl.classList.remove('cb-thinking'); }
      const reply=d.reply||'Sorry, something went wrong — please try again.';
      if(stillActive){
        cbLog(cbMd(reply),'bot',d.chart);
      } else {
        askedTab.log.push({html:cbMd(reply), who:'bot', chart:d.chart||null});
      }
      askedTab.history.push({role:'assistant',content:reply});
      if(d.schemes_changed && window.loadDiscountSchemes) window.loadDiscountSchemes();
      if(d.scenarios_changed) document.dispatchEvent(new Event('apra:scenarios-changed'));
      if(!stillActive)return;
      if(d.annotate) cbAnnotateChart(d.annotate);
      if(d.point_to) cbPointTo(d.point_to);
      if(d.generate_report) generateReport();
      if(d.open_scenario_id && typeof viewScenario==='function') viewScenario(d.open_scenario_id);
      if(d.celebrate) cbCelebrate();
    })
    .catch(function(){
      const stillActive = askedTab.id===cbActiveTabId;
      if(stillActive){
        typ.remove(); if(cbOrbEl) cbOrbEl.classList.remove('cb-thinking');
        cbLog('Connection error — please try again.','bot');
      } else {
        askedTab.log.push({html:'Connection error — please try again.', who:'bot', chart:null});
      }
    });
  }
  function cbOpen(){
    document.getElementById('cbPanel').classList.add('open');
    document.getElementById('cbLaunch').classList.add('hide');
    if(cbTabs.length===0) cbNewTab(); // first-ever open — start the first tab
    setTimeout(()=>document.getElementById('cbText').focus(),120);
  }
  function cbCloseFn(){document.getElementById('cbPanel').classList.remove('open');
    document.getElementById('cbLaunch').classList.remove('hide');
    closeLyraOnlyMode(); // don't let it leak into the next open — closing chat always exits it
  }
  // Maximize — grows the panel to fill most of the viewport (see the
  // .maximized CSS) instead of the usual small floating box. State just
  // lives on the class, so it deliberately carries over across close/
  // reopen within the session (closing doesn't reset it), same as a
  // remembered window size.
  const CB_MAXIMIZE_ICON = '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>';
  const CB_RESTORE_ICON   = '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>';
  function cbToggleMaximize(){
    // While in Lyra-only mode, this same button (already showing the
    // Restore icon, since lyra-only implies maximized-or-bigger) backs out
    // of lyra-only instead of doing a normal maximize/restore toggle — one
    // click returns to the ordinary floating panel, matching what Restore
    // already means everywhere else in this button.
    if(cbLyraOnlyActive){ closeLyraOnlyMode(); return; }
    const panel = document.getElementById('cbPanel');
    const btn = document.getElementById('cbMaximize');
    const isMax = panel.classList.toggle('maximized');
    btn.querySelector('svg').innerHTML = isMax ? CB_RESTORE_ICON : CB_MAXIMIZE_ICON;
    btn.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
    btn.setAttribute('title', isMax ? 'Restore' : 'Maximize');
  }
  // Easter egg: 5 clicks on Lyra's header avatar within a short window
  // opens "Lyra-only mode" — a full-viewport, chrome-free takeover of the
  // chat with a full-body illustration of her alongside it (see the
  // .cb-lyra-figure/.lyra-only CSS). #cbOrb only exists on the dashboard's
  // real Lyra panel — the marketing page reuses this same script for its
  // own "Apy" widget, whose orb is an empty, id-less span, so this simply
  // never wires there (same existence-guard pattern as cbMaximizeBtn below).
  let cbLyraOnlyActive = false;
  function openLyraOnlyMode(){
    if(!document.getElementById('cbPanel').classList.contains('open')) cbOpen();
    cbLyraOnlyActive = true;
    document.getElementById('cbPanel').classList.add('lyra-only');
    const badge = document.getElementById('cbLyraOnlyBadge');
    if(badge) badge.hidden = false;
    const btn = document.getElementById('cbMaximize');
    if(btn){ btn.querySelector('svg').innerHTML = CB_RESTORE_ICON; btn.setAttribute('aria-label','Restore'); btn.setAttribute('title','Restore'); }
    setTimeout(()=>document.getElementById('cbText').focus(),150);
  }
  function closeLyraOnlyMode(){
    if(!cbLyraOnlyActive) return;
    cbLyraOnlyActive = false;
    document.getElementById('cbPanel').classList.remove('lyra-only');
    const badge = document.getElementById('cbLyraOnlyBadge');
    if(badge) badge.hidden = true;
    const btn = document.getElementById('cbMaximize');
    if(btn){ btn.querySelector('svg').innerHTML = CB_MAXIMIZE_ICON; btn.setAttribute('aria-label','Maximize'); btn.setAttribute('title','Maximize'); }
  }
  // Frame color cycle — a lighter click bonus alongside the 5x Lyra-only
  // trigger below: every click on her avatar cycles her glasses frame to
  // the next color here, applied via the --lyra-frame/--lyra-frame-fill
  // CSS custom properties that every copy of her artwork's stroke/fill
  // attributes reference (var(--lyra-frame,#54E6C4) etc.) — one place to
  // set, and it updates the launcher icon, header orb, tour card, full-
  // body figure, and any freshly-created thinking-indicator avatar all at
  // once, with no per-element DOM work. Deliberately session-only: a
  // plain in-memory index, never written to localStorage, so it resets to
  // the default teal on every fresh page load rather than becoming a
  // saved preference.
  const FRAME_COLORS = ['#54E6C4', '#C8F24E', '#7AA2FF', '#FF6B9D', '#B18CFF', '#FFA94D'];
  let frameColorIdx = 0;
  function cycleFrameColor(){
    frameColorIdx = (frameColorIdx + 1) % FRAME_COLORS.length;
    const c = FRAME_COLORS[frameColorIdx];
    const n = parseInt(c.slice(1), 16);
    document.documentElement.style.setProperty('--lyra-frame', c);
    document.documentElement.style.setProperty('--lyra-frame-fill', `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},0.1)`);
  }
  (function(){
    const orbEl = document.getElementById('cbOrb');
    if(!orbEl) return;
    let clicks = 0, resetTimer = null;
    orbEl.addEventListener('click', function(){
      cycleFrameColor();
      clicks++;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(()=>{ clicks = 0; }, 1100);
      if(clicks >= 5){
        clicks = 0;
        clearTimeout(resetTimer);
        cbLyraOnlyActive ? closeLyraOnlyMode() : openLyraOnlyMode();
      }
    });
  })();
  document.getElementById('cbLaunch').onclick=cbOpen;
  document.getElementById('cbClose').onclick=cbCloseFn;
  // cbMaximize/cbTabAdd only exist on the dashboard's own copy of this chat
  // panel — the marketing page (index.html) reuses this same main.js
  // against an older, simpler markup (no maximize button, no tabs bar), so
  // an unguarded lookup here throws and kills every line after it in this
  // script, including the chips/slash-command/voice-input setup further
  // down (confirmed 2026-09-05: this was silently broken on the marketing
  // page until this guard was added).
  const cbMaximizeBtn=document.getElementById('cbMaximize');
  if(cbMaximizeBtn) cbMaximizeBtn.onclick=cbToggleMaximize;
  const cbTabAddBtn=document.getElementById('cbTabAdd');
  if(cbTabAddBtn) cbTabAddBtn.onclick=cbNewTab;
  document.getElementById('cbForm').addEventListener('submit',e=>{
    e.preventDefault(); const i=document.getElementById('cbText'); const v=i.value; i.value=''; cbCloseSlashMenu(); cbAsk(v);});
  document.getElementById('cbChips').querySelectorAll('button').forEach(b=>b.onclick=()=>cbAsk(b.textContent));

  // Slash-command palette — see the .cb-slash-menu CSS comment for the
  // full rationale. Maps directly to Lyra's existing tool set (one entry
  // per toolSpec in chat-api/handler.py's TOOL_CONFIG) so a power user
  // doesn't have to compose a full sentence for things they do often.
  // Purely a text-composition aid: picking one just fills the input with
  // a template and selects its first [placeholder] for easy overtyping —
  // sending is still the normal form submit, so it can't skip Lyra's own
  // tool selection or approve_scenario's confirm gate.
  const CB_SLASH_COMMANDS = [
    {cmd:'run',      label:'Run a new scenario',        template:'Run a new scenario forecast'},
    {cmd:'status',   label:'Check a scenario’s status', template:'Check the status of [scenario name]'},
    {cmd:'open',     label:'Open a scenario',           template:'Open the [scenario name] scenario'},
    {cmd:'approve',  label:'Approve a scenario',        template:'Approve the [scenario name] scenario'},
    {cmd:'validate', label:'Check data quality',        template:'Any data quality issues with [scenario name]?'},
    {cmd:'compare',  label:'Compare two SKUs',          template:'Compare [SKU-A] and [SKU-B]'},
    {cmd:'compare-scenarios', label:'Compare two scenarios', template:'Compare [scenario A] and [scenario B]'},
    {cmd:'explain',  label:'Explain a date',            template:'Why is the forecast high or low on [YYYY-MM-DD]?'},
    {cmd:'range',    label:'Forecast over a date range', template:'What does the forecast look like from [YYYY-MM-DD] to [YYYY-MM-DD]?'},
    {cmd:'zip',      label:'Look up a SKU in a ZIP',    template:'What is the forecast for [SKU] in zip [postal code]?'},
    {cmd:'report',   label:'Generate the report',       template:'Generate the downloadable report'},
    {cmd:'goto',     label:'Jump to a dashboard section', template:'Take me to [Scenarios / Forecasts / AI Insights / Overview / Settings / Knowledge Base / Getting Started]'},
  ];
  (function(){
    const cbTextEl = document.getElementById('cbText');
    const menuEl = document.getElementById('cbSlashMenu');
    // cbSlashMenu doesn't exist on the marketing page's older copy of this
    // panel (see the cbMaximize/cbTabAdd comment above for why that's
    // possible at all) — without this, typing "/" in that page's own demo
    // chat would throw the first time closeMenu()/renderMenu() touched a
    // null menuEl. window.cbCloseSlashMenu still needs to exist either way
    // since the form-submit handler above calls it unconditionally.
    if(!cbTextEl || !menuEl){ window.cbCloseSlashMenu=function(){}; return; }
    let matches = [];
    let activeIdx = 0;

    function closeMenu(){ menuEl.hidden = true; menuEl.innerHTML=''; matches=[]; }
    window.cbCloseSlashMenu = closeMenu; // used by the submit handler above

    function renderMenu(){
      menuEl.innerHTML = '';
      matches.forEach(function(c,i){
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'cb-slash-item' + (i===activeIdx ? ' active' : '');
        const cmdEl = document.createElement('span'); cmdEl.className='cb-slash-cmd'; cmdEl.textContent='/'+c.cmd;
        const lblEl = document.createElement('span'); lblEl.className='cb-slash-label'; lblEl.textContent=c.label;
        item.appendChild(cmdEl); item.appendChild(lblEl);
        // mousedown (not click) fires before the input's blur, so
        // selecting an item never loses the text field's focus first.
        item.addEventListener('mousedown', function(e){ e.preventDefault(); pick(c); });
        menuEl.appendChild(item);
      });
      menuEl.hidden = matches.length===0;
    }

    function pick(c){
      cbTextEl.value = c.template;
      const m = /\[[^\]]*\]/.exec(c.template);
      if(m) cbTextEl.setSelectionRange(m.index, m.index+m[0].length);
      else  cbTextEl.setSelectionRange(c.template.length, c.template.length);
      cbTextEl.focus();
      closeMenu();
    }

    cbTextEl.addEventListener('input', function(){
      const v = cbTextEl.value;
      if(v[0]!=='/'){ closeMenu(); return; }
      const filter = v.slice(1).toLowerCase();
      matches = CB_SLASH_COMMANDS.filter(c=>c.cmd.startsWith(filter));
      activeIdx = 0;
      renderMenu();
    });

    cbTextEl.addEventListener('keydown', function(e){
      if(menuEl.hidden || !matches.length)return;
      if(e.key==='ArrowDown'){ e.preventDefault(); activeIdx=(activeIdx+1)%matches.length; renderMenu(); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); activeIdx=(activeIdx-1+matches.length)%matches.length; renderMenu(); }
      else if(e.key==='Enter' || e.key==='Tab'){ e.preventDefault(); pick(matches[activeIdx]); }
      // stopPropagation so this Escape closes only the menu, not also the
      // whole panel via the document-level Esc-closes-panel shortcut below
      // in the same keystroke — a second, separate Escape closes that.
      else if(e.key==='Escape'){ e.stopPropagation(); closeMenu(); }
    });

    document.addEventListener('click', function(e){
      if(!menuEl.hidden && e.target!==cbTextEl && !menuEl.contains(e.target)) closeMenu();
    });
  })();

  // Keyboard shortcuts — makes Lyra a command surface reachable without
  // clicking the launcher first, not just a click target:
  //   Cmd/Ctrl+K        opens Lyra and focuses the input, from anywhere
  //                      on the dashboard (the same pattern as Slack/
  //                      Linear/Notion/GitHub's own command palettes).
  //   Cmd/Ctrl+Shift+]  next chat tab (wraps around).
  //   Cmd/Ctrl+Shift+[  previous chat tab (wraps around).
  //   Esc               closes the panel.
  // Global (document-level), not scoped to the panel or input, since
  // Cmd+K in particular needs to work no matter what's focused. Ctrl+K
  // doubles for Cmd+K here so Windows/Linux users have an equivalent —
  // same tradeoff those products above make, accepting that Ctrl+K
  // shadows Mac's native "delete to end of line" text-field binding
  // while this page has focus (not a text-field-specific exception here,
  // for the same "anywhere on the dashboard" reason).
  (function(){
    function cycleTab(dir){
      if(!cbTabs.length)return;
      const idx = cbTabs.findIndex(t=>t.id===cbActiveTabId);
      cbSwitchTab(cbTabs[((idx===-1?0:idx)+dir+cbTabs.length)%cbTabs.length].id);
    }
    document.addEventListener('keydown', function(e){
      const mod = e.metaKey || e.ctrlKey;
      if(mod && !e.shiftKey && e.key.toLowerCase()==='k'){
        e.preventDefault(); // otherwise Chrome focuses its own address bar
        cbOpen();
        return;
      }
      const panelOpen = document.getElementById('cbPanel').classList.contains('open');
      if(mod && e.shiftKey && (e.code==='BracketRight' || e.code==='BracketLeft')){
        if(!panelOpen)return; // nothing to cycle if it isn't even showing
        e.preventDefault();
        cycleTab(e.code==='BracketRight' ? 1 : -1);
        return;
      }
      if(e.key==='Escape' && panelOpen){
        // First Escape backs out of Lyra-only mode (to the ordinary panel);
        // only a second one, once no longer in it, closes the panel outright
        // — matches how the maximize/restore button behaves in this mode.
        if(cbLyraOnlyActive){ closeLyraOnlyMode(); return; }
        cbCloseFn();
      }
    });
  })();

  // Voice INPUT — the complement to voice narration above: speak an
  // instruction instead of typing it, via the browser's built-in
  // SpeechRecognition. Fills the input box live as interim results come
  // in, but deliberately does NOT auto-submit on a final result — some of
  // what you can ask Lyra to do is real (approve a scenario, kick off a
  // run), so a mis-transcription gets a chance to be reviewed/edited
  // before it's ever sent, same caution as everywhere else here.
  (function(){
    const micBtn=document.getElementById('cbMicBtn');
    const CB_SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!micBtn)return;
    if(!CB_SR){ micBtn.style.display='none'; return; } // Firefox/Safari mainly — no crash, just no button

    let recognizer=null, listening=false;
    micBtn.onclick=()=>{
      if(listening){ recognizer&&recognizer.stop(); return; } // toggle off — same click-again-to-stop pattern as cbSpeak
      const input=document.getElementById('cbText');
      recognizer=new CB_SR();
      recognizer.lang='en-US';
      recognizer.interimResults=true;
      recognizer.continuous=false; // auto-stops after a pause — no manual stop needed for the common case
      recognizer.onstart=()=>{ listening=true; micBtn.classList.add('listening'); };
      recognizer.onresult=(e)=>{
        let transcript='';
        for(let i=0;i<e.results.length;i++) transcript+=e.results[i][0].transcript;
        input.value=transcript;
      };
      recognizer.onerror=()=>{}; // e.g. mic permission denied, no speech heard — onend still fires and resets the button
      recognizer.onend=()=>{ listening=false; micBtn.classList.remove('listening'); input.focus(); };
      recognizer.start();
    };
  })();

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

  function computeForwardStats(){
    const bt=DATA.backtestWeeks!=null?DATA.backtestWeeks:DATA.weeks.length;
    const totalWeeks=DATA.weeks.length, fwdWeeks=totalWeeks-bt;
    const sumRange=(arr,s,e)=>arr.slice(s,e).reduce((acc,x)=>acc+(x||0),0);
    const trailWin=Math.min(fwdWeeks||1,bt)||1;

    const hasForward=fwdWeeks>0;
    const trailingActual=sumRange(DATA.all.a,Math.max(0,bt-trailWin),bt);
    const forwardForecast=hasForward?sumRange(DATA.all.f,bt,totalWeeks):0;
    const trendPct=(hasForward&&trailingActual)?100*(forwardForecast-trailingActual)/trailingActual:0;

    const skuRows=Object.keys(DATA.skus).map(id=>{
      const o=DATA.skus[id];
      const backtestVol=sumRange(o.a,0,bt);
      const fwdVol=hasForward?sumRange(o.f,bt,totalWeeks):0;
      const trailVol=sumRange(o.a,Math.max(0,bt-trailWin),bt);
      const trend=(hasForward&&trailVol)?100*(fwdVol-trailVol)/trailVol:null;
      return {id,backtestVol,fwdVol,trend};
    }).filter(r=>r.backtestVol>0);

    // Forward-looking confidence, ranked by backtest volume: this pipeline's
    // recursive forecast is only validated at short horizons, and error
    // compounds fastest for lower-volume/sparser series over a long horizon
    // — high-volume SKUs hold up; the long tail drifts. Top ~15% by volume
    // = High, next ~35% = Medium, the rest = Lower. Purely a volume-rank
    // signal, not a model change.
    const byBacktestVol=[...skuRows].sort((x,y)=>y.backtestVol-x.backtestVol);
    const n=byBacktestVol.length||1;
    const confidenceOf={};
    byBacktestVol.forEach((r,i)=>{
      const pct=i/n;
      confidenceOf[r.id]=pct<0.15?'High':pct<0.5?'Medium':'Lower';
    });
    skuRows.forEach(r=>{ r.confidence=confidenceOf[r.id]; });

    const byFwdVol=[...skuRows].sort((x,y)=>y.fwdVol-x.fwdVol);
    const withTrend=skuRows.filter(r=>r.trend!=null);
    const growing=[...withTrend].sort((x,y)=>y.trend-x.trend).slice(0,5);
    const declining=[...withTrend].sort((x,y)=>x.trend-y.trend).slice(0,5);

    return {bt,totalWeeks,fwdWeeks,trailWin,trailingActual,forwardForecast,trendPct,byFwdVol,growing,declining,confidenceOf};
  }

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

  // Report customization — set from Settings > Downloadable Report, read fresh
  // each time so a change there takes effect on the next Generate Report click
  // without needing a page reload.
  function getReportPrefs(){
    const onOff=(key)=>(localStorage.getItem(key)||'on')!=='off';
    const rowsRaw=localStorage.getItem('report_rows')||'15';
    return {
      insights: onOff('report_insights'),
      chart:    onOff('report_chart'),
      movers:   onOff('report_movers'),
      backtest: onOff('report_backtest'),
      rows: rowsRaw==='all' ? Infinity : (parseInt(rowsRaw,10)||15),
    };
  }

  function buildReportHTML(insights){
    const S=cbGetStats();
    const F=computeForwardStats();
    const P=getReportPrefs();
    const acc=(100-DATA.overallWape).toFixed(1);
    const user=document.getElementById('greetName').textContent||'—';
    const dt=new Date().toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});
    const tn=n=>Math.round(n).toLocaleString();
    const card=(l,v,s)=>`<div class="mc"><div class="mc-l">${l}</div><div class="mc-v">${v}</div><div class="mc-s">${s||''}</div></div>`;
    const smCard=(l,v,s)=>`<div class="mc sm"><div class="mc-l">${l}</div><div class="mc-v sm">${v}</div><div class="mc-s">${s||''}</div></div>`;
    const trendPill=t=>{if(t==null)return '<span class="pill warn">n/a</span>';
      const cls=t>=0?'ok':'risk'; return `<span class="pill ${cls}">${t>=0?'+':''}${t.toFixed(1)}%</span>`;};
    const confPill=id=>{const c=F.confidenceOf[id];
      const cls=c==='High'?'ok':c==='Medium'?'warn':'risk'; return `<span class="pill ${cls}">${c||'—'}</span>`;};
    const fwdRow=r=>`<tr><td class="mono">${r.id}</td><td>${tn(r.backtestVol)}</td><td>${tn(r.fwdVol)}</td><td>${trendPill(r.trend)}</td><td>${confPill(r.id)}</td></tr>`;
    const trendLi=r=>`<li><span class="mono">${r.id}</span><b style="color:${r.trend>=0?'#1aa179':'#d35454'}">${r.trend>=0?'+':''}${r.trend.toFixed(1)}%</b></li>`;
    const top=S.byVol.slice(0,P.rows);
    const trow=r=>{const a2=Math.max(0,100-r.wape);const cls=r.wape<=30?'ok':r.wape<=45?'warn':'risk';
      const lab=r.wape<=30?'Strong':r.wape<=45?'Fair':'High error';
      return `<tr><td class="mono">${r.a}</td><td>${tn(r.vol)}</td><td>${r.wape.toFixed(1)}%</td><td>${a2.toFixed(0)}%</td><td><span class="pill ${cls}">${lab}</span></td></tr>`;};
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>APRABot — Demand Forecast Outlook</title>
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
      h2.sec{color:#0A0E15;border-bottom-color:#C8F24E}
      .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
      .mc{border:1px solid #e9edf2;border-radius:10px;padding:16px}
      .mc-l{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7787}
      .mc-v{font-size:26px;font-weight:700;color:#0A0E15;margin-top:4px}
      .mc-v.sm{font-size:18px}
      .mc.sm{padding:12px 14px}
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
      .refsec{background:#f7f8fa;border-radius:12px;padding:20px 22px;margin-top:34px}
      .refsec h2{margin-top:0}
      .foot{font-size:11px;color:#8b97a6;border-top:1px solid #e9edf2;margin-top:20px;padding-top:14px}
      .toolbar{position:fixed;top:14px;right:14px;display:flex;gap:8px}
      .toolbar button{background:#1b66d6;color:#fff;border:none;border-radius:7px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer}
      .toolbar button.sec{background:#fff;color:#1b66d6;border:1px solid #c7ced8}
      @media print{.toolbar{display:none}body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}}
    </style></head><body>
    <div class="toolbar"><button onclick="window.print()">Save as PDF / Print</button><button class="sec" onclick="window.close()">Close</button></div>
    <div class="page">
      <div class="hd">
        <div><div class="logo">APRA<b>Bot</b></div><h1>Demand Forecast Outlook</h1></div>
        <div class="meta">${F.fwdWeeks}-week forward view<br>Generated ${dt}<br>Prepared for: ${user}</div>
      </div>
      <div class="body">
        <h2 class="sec">Forward Outlook</h2>
        <p class="lead">What we predict for the business over the next ${F.fwdWeeks} weeks, based on the full demand model across the catalog.</p>
        <div class="cards" style="margin-top:18px">
          ${card('Forecasted volume',tn(F.forwardForecast),`next ${F.fwdWeeks} wks, shipped units`)}
          ${card('Volume trend',(F.trendPct>=0?'+':'')+F.trendPct.toFixed(1)+'%',`vs trailing ${F.trailWin} wks`)}
          ${card('SKUs forecasted',S.skuCount.toLocaleString(),'full catalog')}
        </div>
        ${P.insights?buildInsightsSection(insights):''}
        ${P.chart?`<h2 class="sec">Forecast trend — shipped units</h2>
        <img class="chart" src="${reportChartPNG()}" alt="Shipped units, historical and forecast">
        <p class="lead" style="margin-top:10px;font-size:12px;color:#6b7787">Blue: actuals to date · Orange (dashed): forecast, including the ${F.fwdWeeks}-week forward view · Green: weekly model error (WAPE), for reference.</p>`:''}
        <h2 class="sec">Top SKUs — forward volume</h2>
        <table><thead><tr><th>SKU</th><th>Backtest volume</th><th>Forward forecast</th><th>Trend</th><th>Confidence</th></tr></thead>
        <tbody>${F.byFwdVol.slice(0,P.rows).map(fwdRow).join('')}</tbody></table>
        <p class="lead" style="margin-top:8px;font-size:12px;color:#6b7787">Confidence is a volume rank, not a probability — this pipeline's long-horizon forecast is validated at high volume and holds up best for top sellers; long-tail SKUs compound more error over ${F.fwdWeeks} weeks and should be treated as directional.</p>
        ${P.movers?`<h2 class="sec">Fastest movers</h2>
        <div class="two">
          <div><h3>Fastest growing</h3><ul>${F.growing.map(trendLi).join('')}</ul></div>
          <div><h3>Fastest declining</h3><ul>${F.declining.map(trendLi).join('')}</ul></div>
        </div>`:''}

        ${P.backtest?`<div class="refsec">
          <h2>Model performance (reference)</h2>
          <p class="lead" style="font-size:13px">Backtest accuracy behind this forecast — included for transparency, not the headline. WAPE is computed only over the historical backtest window; the forward view above carries no actuals to score against yet.</p>
          <div class="cards" style="margin-top:14px">
            ${smCard('Overall WAPE',DATA.overallWape.toFixed(2)+'%','volume-weighted error')}
            ${smCard('Volume-wtd accuracy',acc+'%','100 − WAPE')}
            ${smCard('Forecast bias',(S.bias>0?'+':'')+S.bias.toFixed(1)+'%',S.bias<0?'under-forecast':'over-forecast')}
          </div>
          <h3 style="font-size:12px;color:#6b7787;margin:16px 0 8px">${Number.isFinite(P.rows)?'Top '+P.rows:'All'} SKUs by backtest volume</h3>
          <table><thead><tr><th>SKU</th><th>Total units</th><th>WAPE</th><th>Accuracy</th><th>Status</th></tr></thead>
          <tbody>${top.map(trow).join('')}</tbody></table>
        </div>`:''}
        <div class="foot">Methodology: forward volume and trend come from the demand model's forecast beyond the backtest window, compared against the trailing ${F.trailWin}-week actuals. WAPE = Σ|actual − forecast| / Σactual, computed per week over the backtest only and aggregated by volume. This report is generated from a live scenario snapshot.</div>
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
        a.download='APRABot_Forecast_Outlook.html';a.click();URL.revokeObjectURL(a.href);
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
