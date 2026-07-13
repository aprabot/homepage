/* ============================================================
   APY — APRABot Concierge Chatbot
   Self-contained widget — include on any page
============================================================ */

(function () {
  'use strict';

  /* Hide on any page where the user is already signed in */
  try {
    var _t = localStorage.getItem('apra_id');
    if (_t) {
      var _p = JSON.parse(atob(_t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      if (_p.exp && _p.exp * 1000 > Date.now()) return;
    }
  } catch(e) {}

  /* ── Knowledge base ── */
  const KB = [
    {
      match: /\b(hi|hello|hey|howdy|good morning|good afternoon)\b/i,
      reply: () => `Hi there! 👋 I'm **Apy**, your APRABot concierge. I can tell you about our AI demand forecasting platform, pricing, integrations, or help you book a demo. What brings you here today?`
    },
    {
      match: /\b(what is|what does|tell me about|explain|how does|overview|about)\b.*\b(aprabot|platform|product|it)\b/i,
      reply: () => `**APRABot** is an AI-native demand forecasting platform built for supply chain, finance, and sales teams.\n\nAt its core:\n• **ML ensemble** (XGBoost + LightGBM) runs weekly batch inference across millions of SKU×location time series\n• **Multi-agent AI** (powered by Amazon Bedrock) lets your planners ask natural-language questions and get instant analysis\n• **Amazon Athena** provides serverless SQL over your forecast data — fast and cost-efficient\n• **Planner portal** with WAPE trends, scenario planning, and S&OP commentary\n\nWant to see a live demo?`
    },
    {
      match: /\b(forecast|forecasting|accuracy|wape|prediction|predict)\b/i,
      reply: () => `APRABot generates **SKU × zipcode level** weekly forecasts using a two-model ensemble:\n\n• **XGBoost** — handles tabular features, promotions, pricing signals\n• **LightGBM** — complements XGBoost with faster leaf-wise splits\n\nThe ensemble achieves **15–25% lower WAPE** than single-model approaches. Forecasts include P50, P80, and P95 quantiles for safety stock planning.\n\nTypical clients see accuracy improvements within the first 4-week cycle.`
    },
    {
      match: /\b(price|pricing|cost|how much|plan|plans|tier|tiers|subscription)\b/i,
      reply: () => `APRABot is priced per client per month based on your scale:\n\n| Tier | Price/mo | SKUs | Zipcodes |\n|------|----------|------|----------|\n| **Starter** | $500 | up to 5K | up to 5K |\n| **Growth** | $1,000 | up to 15K | up to 15K |\n| **Enterprise** | Custom | 20K+ | 20K+ |\n\nAll tiers include the full multi-agent AI, portal access, and weekly inference. AWS infrastructure runs in **your own account** — you pay AWS directly, typically $60–150/month.\n\nWant a detailed cost breakdown?`
    },
    {
      match: /\b(demo|book|trial|try|see it|schedule|meeting|call)\b/i,
      reply: () => `I'd love to set that up! 🎯\n\nYou can book a 30-minute demo directly:\n👉 **[Book a demo →](#demo)**\n\nOr drop us a line at **contact@aprabot.com** and we'll get back within one business day.\n\nWhat's your primary use case — retail forecasting, S&OP alignment, or something else?`
    },
    {
      match: /\b(integrat|connect|data|ingest|sftp|edi|erp|sap|api)\b/i,
      reply: () => `APRABot ingests data from your existing systems with zero disruption:\n\n• **AWS Transfer Family** — SFTP/FTPS for partners and 3PLs\n• **REST API** — direct push from your ERP or data warehouse\n• **S3 pre-signed URLs** — for CSV uploads and batch delivery\n• **AWS Glue ETL** — cleans, normalises, and partitions your data automatically\n\nWe support SAP, Oracle, NetSuite, and most CSV-based legacy systems. Typical integration time: **2–4 weeks**.`
    },
    {
      match: /\b(agent|ai agent|multi.?agent|bedrock|orchestrator|llm|gpt|claude)\b/i,
      reply: () => `The **multi-agent system** is one of APRABot's key differentiators:\n\n1. **Query Agent** — understands your natural-language question\n2. **Orchestrator** — routes the task, retrieves context from the Knowledge Base\n3. **Executor Agent** — runs SQL queries via Amazon Athena over your forecast data\n4. **Analysis Agent** — interprets results and generates S&OP commentary\n\nAll powered by **Amazon Bedrock** (Claude models). A typical query costs ~$0.006 and returns in under 3 seconds.`
    },
    {
      match: /\b(security|soc|compliance|gdpr|privacy|iso|encrypt)\b/i,
      reply: () => `Security is foundational to APRABot:\n\n• **SOC 2 Type II** certified\n• Data runs in **your AWS account** — we never store your data on our infra\n• **Amazon Cognito** with MFA and SSO/SAML for per-tenant isolation\n• All data encrypted at rest (S3 SSE-S3) and in transit (TLS 1.3)\n• CloudFront + WAF on the portal\n• Full audit trail via CloudWatch\n\nHave a specific compliance requirement? Our security team is happy to help.`
    },
    {
      match: /\b(how long|implement|onboard|deploy|setup|get started|start)\b/i,
      reply: () => `Most clients are fully live in **4–6 weeks**:\n\n**Week 1–2** — Data ingestion setup (SFTP or API), historical backfill\n**Week 3** — First forecast run, model validation, WAPE benchmarking\n**Week 4** — Portal onboarding, user training, Knowledge Base population\n**Week 5–6** — S&OP workflow integration, scenario planning setup\n\nWe assign a dedicated solutions engineer for the entire implementation. No black-box handoffs.`
    },
    {
      match: /\b(human|person|speak|talk|someone|team|support|contact|email)\b/i,
      reply: () => `Absolutely — I'll connect you with the team right away.\n\n📧 **contact@aprabot.com**\n📅 **[Book a call →](#demo)**\n\nWe typically respond within a few hours during business hours (9am–6pm ET, Mon–Fri).\n\nIs there anything else I can help clarify in the meantime?`
    },
    {
      match: /\b(sku|skus|product|catalogue|item|variant)\b/i,
      reply: () => `APRABot handles up to **20,000 SKUs × 20,000 zipcodes** per client — that's 400 million time series. We apply sparse filtering so only active SKU×location combos are scored each week, keeping costs low even at that scale.\n\nSKU-level features include lag demand, rolling averages, price, promotions, seasonality, and external signals (weather, events). What's your current SKU count?`
    },
    {
      match: /\b(thank|thanks|great|awesome|perfect|nice|cool|helpful)\b/i,
      reply: () => `You're very welcome! 😊 Feel free to reach out any time — I'm here 24/7.\n\nIf you're ready to take the next step, **[book a demo →](#demo)** and our team will walk you through a live forecast run with your own data.`
    },
  ];

  const FALLBACK = [
    `That's a great question — let me get the right person to help. You can reach our team at **contact@aprabot.com** or **[book a demo →](#demo)** for a live walkthrough.\n\nI can also tell you about our **forecasting accuracy**, **pricing**, **integrations**, or **security**. What would be most useful?`,
    `I want to make sure you get the best answer! Our solutions team at **contact@aprabot.com** can dive deep on that.\n\nMeanwhile, can I help with something like **how APRABot works**, **pricing**, or **booking a demo**?`,
    `Good one! That's a bit outside my knowledge base 😅 but the team at **contact@aprabot.com** will have a great answer.\n\nAnything else I can help with — **forecasting**, **integrations**, or **getting started**?`
  ];

  let fallbackIdx = 0;

  function getReply(text) {
    for (const entry of KB) {
      if (entry.match.test(text)) return entry.reply();
    }
    return FALLBACK[fallbackIdx++ % FALLBACK.length];
  }

  /* ── Render markdown-lite ── */
  function renderMd(text) {
    const light = document.documentElement.dataset.theme === 'light';
    const linkClr  = light ? '#5A9200' : '#C8F24E';
    const tdBorder = light ? 'rgba(0,0,0,.12)' : '#333';
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(.+?)\]\((.+?)\)/g, `<a href="$2" style="color:${linkClr};text-underline-offset:3px">$1</a>`)
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n•/g, '<br>•')
      .replace(/\n/g, '<br>')
      .replace(/\|(.+)\|/g, (_, row) => {
        const cells = row.split('|').map(c => `<td style="padding:3px 8px;border:1px solid ${tdBorder}">${c.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      });
  }

  /* ── Inject styles ── */
  const style = document.createElement('style');
  style.textContent = `
    #apy-root { position:fixed; bottom:28px; right:28px; z-index:9999; font-family:'Hanken Grotesk',system-ui,sans-serif; }

    /* ── Trigger button ── */
    #apy-btn {
      display:flex; align-items:center; gap:10px;
      background:#0a0a0a; border:1.5px solid rgba(200,242,78,.35);
      color:#C8F24E; font-family:inherit; font-size:14px; font-weight:600;
      padding:10px 18px 10px 12px; border-radius:100px; cursor:pointer;
      box-shadow:0 4px 24px rgba(0,0,0,.5); transition:all .2s;
      position:relative; letter-spacing:-.01em;
    }
    #apy-btn:hover { border-color:#C8F24E; background:#111; box-shadow:0 6px 32px rgba(200,242,78,.18); }
    #apy-btn .apy-icon { position:relative; width:36px; height:36px; flex-shrink:0; }
    #apy-btn .apy-icon svg { width:36px; height:36px; display:block; border-radius:50%; background:#0e0820; }
    #apy-btn .apy-ripple {
      position:absolute; inset:-6px; border-radius:50%;
      border:1.5px solid rgba(200,242,78,.4);
      animation:apy-ripple 2s ease-out infinite;
    }
    #apy-btn .apy-ripple2 {
      position:absolute; inset:-6px; border-radius:50%;
      border:1.5px solid rgba(200,242,78,.2);
      animation:apy-ripple 2s ease-out infinite .7s;
    }
    @keyframes apy-ripple {
      0%  { transform:scale(.85); opacity:1; }
      100%{ transform:scale(1.5); opacity:0; }
    }
    #apy-btn .apy-label { line-height:1; }
    #apy-btn .apy-sub { font-size:10px; font-weight:400; color:#6a8830; letter-spacing:.03em; display:block; margin-top:1px; }

    /* ── Chat window ── */
    #apy-window {
      position:absolute; bottom:calc(100% + 16px); right:0;
      width:370px; height:530px;
      background:#0e0e0e; border:1px solid #1e1e1e;
      border-radius:20px; overflow:hidden;
      box-shadow:0 20px 60px rgba(0,0,0,.7), 0 0 0 1px rgba(200,242,78,.08);
      display:flex; flex-direction:column;
      transform:scale(.92) translateY(12px); opacity:0; pointer-events:none;
      transition:transform .22s cubic-bezier(.34,1.56,.64,1), opacity .18s ease;
    }
    #apy-window.open {
      transform:scale(1) translateY(0); opacity:1; pointer-events:all;
    }

    /* ── Header ── */
    .apy-head {
      display:flex; align-items:center; gap:12px;
      padding:16px 18px; border-bottom:1px solid #1a1a1a;
      background:#0a0a0a; flex-shrink:0;
    }
    .apy-head-icon { position:relative; flex-shrink:0; }
    .apy-head-icon svg { width:40px; height:40px; display:block; border-radius:50%; background:#0e0820; }
    .apy-head-icon .apy-online {
      position:absolute; bottom:1px; right:1px;
      width:9px; height:9px; border-radius:50%;
      background:#C8F24E; border:2px solid #0a0a0a;
      animation:apy-blink 2.5s ease-in-out infinite;
    }
    @keyframes apy-blink { 0%,100%{opacity:1} 50%{opacity:.4} }
    .apy-head-info { flex:1; min-width:0; }
    .apy-head-name { font-size:15px; font-weight:700; color:#fff; letter-spacing:-.01em; }
    .apy-head-status { font-size:11px; color:#6a8830; margin-top:1px; font-family:'JetBrains Mono',monospace; letter-spacing:.04em; }
    .apy-close-btn {
      width:32px; height:32px; border-radius:50%; border:1px solid #222;
      background:transparent; color:#555; font-size:18px; cursor:pointer;
      display:flex; align-items:center; justify-content:center; transition:all .15s;
      flex-shrink:0;
    }
    .apy-close-btn:hover { background:#1a1a1a; color:#ccc; }

    /* ── Messages ── */
    .apy-msgs {
      flex:1; overflow-y:auto; padding:16px 16px 8px;
      display:flex; flex-direction:column; gap:10px;
      scrollbar-width:thin; scrollbar-color:#222 transparent;
    }
    .apy-msgs::-webkit-scrollbar { width:4px; }
    .apy-msgs::-webkit-scrollbar-thumb { background:#222; border-radius:4px; }

    .apy-msg { display:flex; gap:8px; align-items:flex-end; max-width:90%; }
    .apy-msg.bot { align-self:flex-start; }
    .apy-msg.user { align-self:flex-end; flex-direction:row-reverse; }

    .apy-avatar-sm {
      width:28px; height:28px; border-radius:50%;
      background:#0e0820; border:1px solid #2a1a50;
      display:flex; align-items:center; justify-content:center; flex-shrink:0;
      overflow:hidden; position:relative;
    }
    .apy-avatar-sm svg { width:28px; height:28px; }
    .apy-avatar-sm.apy-thinking { animation:apy-think-bounce 1s ease-in-out infinite; overflow:visible; }
    @keyframes apy-think-bounce {
      0%,100% { transform:translateY(0) rotate(0deg); }
      25%     { transform:translateY(-3px) rotate(-6deg); }
      75%     { transform:translateY(-3px) rotate(6deg); }
    }
    .apy-think-badge {
      position:absolute; top:-5px; right:-5px; font-size:11px; line-height:1;
      opacity:0; animation:apy-think-fade 1.6s ease-in-out infinite;
    }
    @keyframes apy-think-fade {
      0%,100% { opacity:0; transform:translateY(2px) scale(.7); }
      50%     { opacity:1; transform:translateY(-3px) scale(1); }
    }
    .apy-head-icon.apy-thinking svg { animation:apy-think-bounce 1s ease-in-out infinite; }

    .apy-bubble {
      padding:10px 13px; border-radius:16px; font-size:13px; line-height:1.55;
      max-width:280px;
    }
    .bot .apy-bubble {
      background:#141414; border:1px solid #222; color:#ddd;
      border-bottom-left-radius:4px;
    }
    .bot .apy-bubble strong { color:#C8F24E; }
    .bot .apy-bubble table { border-collapse:collapse; margin:6px 0; font-size:12px; width:100%; }
    .user .apy-bubble {
      background:#1a2d08; border:1px solid #2a4010; color:#C8F24E;
      border-bottom-right-radius:4px;
    }

    /* ── Typing indicator ── */
    .apy-typing { display:flex; align-items:center; gap:4px; padding:8px 12px; }
    .apy-typing span {
      width:6px; height:6px; border-radius:50%; background:#444;
      animation:apy-dot 1.2s ease-in-out infinite;
    }
    .apy-typing span:nth-child(2) { animation-delay:.2s; }
    .apy-typing span:nth-child(3) { animation-delay:.4s; }
    @keyframes apy-dot { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-5px)} }

    /* ── Suggestions ── */
    .apy-suggestions {
      padding:4px 14px 8px; display:flex; flex-wrap:wrap; gap:6px; flex-shrink:0;
    }
    .apy-chip {
      font-size:11.5px; font-family:'JetBrains Mono',monospace;
      color:#6a8830; background:transparent; border:1px solid #1e2e0a;
      border-radius:100px; padding:5px 12px; cursor:pointer; transition:all .15s;
      letter-spacing:.02em; white-space:nowrap;
    }
    .apy-chip:hover { border-color:#C8F24E; color:#C8F24E; background:rgba(200,242,78,.06); }

    /* ── Input ── */
    .apy-input-area {
      padding:12px 14px; border-top:1px solid #1a1a1a;
      display:flex; gap:8px; align-items:center; flex-shrink:0;
    }
    #apy-input {
      flex:1; background:#141414; border:1px solid #222; border-radius:12px;
      padding:10px 14px; color:#e8e8e8; font-family:inherit; font-size:13px;
      outline:none; transition:border-color .15s;
    }
    #apy-input::placeholder { color:#444; }
    #apy-input:focus { border-color:rgba(200,242,78,.4); }
    #apy-send {
      width:38px; height:38px; border-radius:50%; border:none; cursor:pointer;
      background:#C8F24E; display:flex; align-items:center; justify-content:center;
      flex-shrink:0; transition:all .15s;
    }
    #apy-send:hover { background:#d4f860; transform:scale(1.06); }
    #apy-send svg { width:16px; height:16px; }

    /* ── Unread badge ── */
    #apy-badge {
      position:absolute; top:-4px; right:-4px;
      width:18px; height:18px; border-radius:50%;
      background:#C8F24E; color:#0a0a0a; font-size:10px; font-weight:700;
      display:none; align-items:center; justify-content:center;
      border:2px solid #0a0a0a;
    }
    #apy-badge.show { display:flex; }

    /* ══════════════════════════════════════════
       LIGHT THEME OVERRIDES
       Button fills (#C8F24E) are identical to dark mode — no override needed.
       Only surfaces, text colours, and borders change.
    ══════════════════════════════════════════ */
    /* Trigger button */
    [data-theme="light"] #apy-btn {
      background:#fff; border-color:rgba(0,0,0,.14);
      color:#111318; box-shadow:0 2px 8px rgba(0,0,0,.08),0 4px 20px rgba(0,0,0,.06);
    }
    [data-theme="light"] #apy-btn:hover {
      background:#fafaf8; border-color:rgba(0,0,0,.22);
      box-shadow:0 4px 12px rgba(0,0,0,.1),0 8px 28px rgba(0,0,0,.08);
    }
    [data-theme="light"] #apy-btn .apy-icon svg { background:#F5F4EE; }
    [data-theme="light"] #apy-btn .apy-ripple  { border-color:rgba(200,242,78,.55); }
    [data-theme="light"] #apy-btn .apy-ripple2 { border-color:rgba(200,242,78,.28); }
    [data-theme="light"] #apy-btn .apy-sub { color:#7E8C9A; }

    /* Chat window */
    [data-theme="light"] #apy-window {
      background:#fff; border:1px solid rgba(0,0,0,.09);
      box-shadow:0 4px 6px rgba(0,0,0,.04),0 20px 50px rgba(0,0,0,.1);
    }

    /* Header */
    [data-theme="light"] .apy-head { background:#fafaf8; border-bottom-color:rgba(0,0,0,.07); }
    [data-theme="light"] .apy-head-icon svg { background:#F5F4EE; }
    [data-theme="light"] .apy-head-icon .apy-online { background:#C8F24E; border-color:#fafaf8; }
    [data-theme="light"] .apy-head-name { color:#111318; }
    [data-theme="light"] .apy-head-status { color:#5A9200; }
    [data-theme="light"] .apy-close-btn { border-color:rgba(0,0,0,.1); color:#7E8C9A; }
    [data-theme="light"] .apy-close-btn:hover { background:#F5F4EE; color:#111318; }

    /* Messages */
    [data-theme="light"] .apy-msgs { scrollbar-color:rgba(0,0,0,.12) transparent; }
    [data-theme="light"] .apy-msgs::-webkit-scrollbar-thumb { background:rgba(0,0,0,.12); }

    /* Avatars */
    [data-theme="light"] .apy-avatar-sm { background:#F5F4EE; border-color:rgba(0,0,0,.1); }

    /* Bubbles */
    [data-theme="light"] .bot .apy-bubble {
      background:#ECEAE3; border-color:rgba(0,0,0,.08); color:#111318;
    }
    [data-theme="light"] .bot .apy-bubble strong { color:#5A9200; }
    [data-theme="light"] .user .apy-bubble {
      background:#C8F24E; border-color:rgba(160,210,0,.3); color:#0A0E15;
    }

    /* Typing dots */
    [data-theme="light"] .apy-typing span { background:#C0BEB8; }

    /* Suggestion chips */
    [data-theme="light"] .apy-chip { color:#52606E; border-color:rgba(0,0,0,.12); background:#fafaf8; }
    [data-theme="light"] .apy-chip:hover {
      border-color:#5A9200; color:#5A9200; background:rgba(200,242,78,.08);
    }

    /* Input area */
    [data-theme="light"] .apy-input-area { border-top-color:rgba(0,0,0,.07); background:#fafaf8; }
    [data-theme="light"] #apy-input {
      background:#fff; border-color:rgba(0,0,0,.12); color:#111318;
    }
    [data-theme="light"] #apy-input::placeholder { color:#7E8C9A; }
    [data-theme="light"] #apy-input:focus { border-color:rgba(200,242,78,.5); box-shadow:0 0 0 3px rgba(200,242,78,.12); }

    /* Badge */
    [data-theme="light"] #apy-badge { border-color:#fff; }
  `;
  document.head.appendChild(style);

  /* ── Logo SVG (matches site logo) ── */
  function logoSvg(size) {
    return `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <!-- Long hair flow - left -->
      <path d="M7 10.5 Q2 15 2.6 21.5 Q3.2 27 7.5 30 L10 26 Q7.4 22.5 7.2 17.5 Q7 13.5 9.5 10.8 Z" fill="#C42020"/>
      <!-- Long hair flow - right -->
      <path d="M25 10.5 Q30 15 29.4 21.5 Q28.8 27 24.5 30 L22 26 Q24.6 22.5 24.8 17.5 Q25 13.5 22.5 10.8 Z" fill="#C42020"/>
      <!-- Hair back (thick crown volume) -->
      <ellipse cx="16" cy="13.2" rx="10" ry="8.2" fill="#C42020"/>
      <!-- Strand shading for thickness -->
      <path d="M5.5 17 Q5 23 8.5 28.5" stroke="#8B1010" stroke-width="0.9" stroke-linecap="round" fill="none" opacity="0.45"/>
      <path d="M26.5 17 Q27 23 23.5 28.5" stroke="#8B1010" stroke-width="0.9" stroke-linecap="round" fill="none" opacity="0.45"/>
      <!-- Side-swept fringe -->
      <path d="M6.3 11.3 Q9.8 4 16 5 Q12.8 8.2 12 13.3 Q9 11.1 6.3 11.3 Z" fill="#8B1010" opacity="0.85"/>
      <!-- Face (thin) -->
      <ellipse cx="16" cy="18.5" rx="6.8" ry="9.8" fill="#FFD4A3"/>
      <!-- Sleek brows -->
      <path d="M8.9 15.4 Q10.6 14.3 12.3 15.1" stroke="#8B1010" stroke-width="0.9" stroke-linecap="round" fill="none"/>
      <path d="M19.7 15.1 Q21.4 14.3 23.1 15.4" stroke="#8B1010" stroke-width="0.9" stroke-linecap="round" fill="none"/>
      <!-- Eyes with lash flick -->
      <ellipse cx="10.6" cy="17.7" rx="1.5" ry="1.8" fill="#1a1a2e"/>
      <ellipse cx="21.4" cy="17.7" rx="1.5" ry="1.8" fill="#1a1a2e"/>
      <path d="M9.1 16.7 L8.3 15.9" stroke="#1a1a2e" stroke-width="0.7" stroke-linecap="round"/>
      <path d="M22.9 16.7 L23.7 15.9" stroke="#1a1a2e" stroke-width="0.7" stroke-linecap="round"/>
      <circle cx="11.2" cy="17" r="0.5" fill="white"/>
      <circle cx="22.0" cy="17" r="0.5" fill="white"/>
      <!-- Hoop earrings -->
      <circle cx="7.8" cy="20.2" r="1.1" stroke="#C8F24E" stroke-width="0.8" fill="none"/>
      <circle cx="24.2" cy="20.2" r="1.1" stroke="#C8F24E" stroke-width="0.8" fill="none"/>
      <!-- Tiny nose -->
      <path d="M15.3 20.7 Q16 21.7 16.7 20.7" stroke="#c47a5a" stroke-width="0.9" stroke-linecap="round" fill="none" opacity="0.6"/>
      <!-- Bold lip smile -->
      <path d="M13.2 23.3 Q16 25.9 18.8 23.3" stroke="#D6336C" stroke-width="1.7" stroke-linecap="round" fill="none"/>
      <!-- Blush -->
      <ellipse cx="10.1" cy="21.6" rx="1.6" ry="1" fill="#ffaaa0" opacity="0.4"/>
      <ellipse cx="21.9" cy="21.6" rx="1.6" ry="1" fill="#ffaaa0" opacity="0.4"/>
      <!-- Collar hint (teal shirt) -->
      <path d="M10 31 Q13 28.5 16 28 Q19 28.5 22 31" fill="#54E6C4" opacity="0.65"/>
    </svg>`;
  }

  /* ── Build DOM ── */
  const root = document.createElement('div');
  root.id = 'apy-root';
  root.innerHTML = `
    <div id="apy-window">
      <div class="apy-head">
        <div class="apy-head-icon">
          ${logoSvg(36)}
          <div class="apy-online"></div>
        </div>
        <div class="apy-head-info">
          <div class="apy-head-name">Apy</div>
          <div class="apy-head-status">● APRABot Concierge</div>
        </div>
        <button class="apy-close-btn" id="apy-close" aria-label="Close">×</button>
      </div>

      <div class="apy-msgs" id="apy-msgs"></div>

      <div class="apy-suggestions" id="apy-chips">
        <button class="apy-chip" data-q="How does APRABot work?">How it works</button>
        <button class="apy-chip" data-q="What's the pricing?">Pricing</button>
        <button class="apy-chip" data-q="How accurate are the forecasts?">Accuracy</button>
        <button class="apy-chip" data-q="Book a demo">Book a demo</button>
        <button class="apy-chip" data-q="How do you handle integrations?">Integrations</button>
      </div>

      <div class="apy-input-area">
        <input id="apy-input" type="text" placeholder="Ask Apy anything…" autocomplete="off" maxlength="300"/>
        <button id="apy-send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z"/>
          </svg>
        </button>
      </div>
    </div>

    <button id="apy-btn" aria-label="Chat with Apy">
      <div class="apy-icon">
        ${logoSvg(32)}
        <div class="apy-ripple"></div>
        <div class="apy-ripple2"></div>
      </div>
      <div class="apy-label">
        Apy
        <span class="apy-sub">Ask me anything</span>
      </div>
      <div id="apy-badge">1</div>
    </button>
  `;
  document.body.appendChild(root);

  /* ── State ── */
  const win   = document.getElementById('apy-window');
  const msgs  = document.getElementById('apy-msgs');
  const input = document.getElementById('apy-input');
  const badge = document.getElementById('apy-badge');
  let isOpen  = false;
  let greeted = false;

  /* ── Helpers ── */
  function scrollBottom() {
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addMsg(text, role) {
    const div = document.createElement('div');
    div.className = `apy-msg ${role}`;
    if (role === 'bot') {
      div.innerHTML = `
        <div class="apy-avatar-sm">${logoSvg(16)}</div>
        <div class="apy-bubble">${renderMd(text)}</div>`;
    } else {
      div.innerHTML = `<div class="apy-bubble">${text.replace(/</g, '&lt;')}</div>`;
    }
    msgs.appendChild(div);
    scrollBottom();
    return div;
  }

  function showTyping() {
    const t = document.createElement('div');
    t.className = 'apy-msg bot';
    t.id = 'apy-typing';
    t.innerHTML = `
      <div class="apy-avatar-sm apy-thinking">${logoSvg(16)}<span class="apy-think-badge">💭</span></div>
      <div class="apy-bubble apy-typing"><span></span><span></span><span></span></div>`;
    msgs.appendChild(t);
    scrollBottom();
    const headIcon = document.querySelector('.apy-head-icon');
    if (headIcon) headIcon.classList.add('apy-thinking');
  }

  function removeTyping() {
    const t = document.getElementById('apy-typing');
    if (t) t.remove();
    const headIcon = document.querySelector('.apy-head-icon');
    if (headIcon) headIcon.classList.remove('apy-thinking');
  }

  function hideChips() {
    document.getElementById('apy-chips').style.display = 'none';
  }

  function botReply(text, delay = 900) {
    showTyping();
    setTimeout(() => {
      removeTyping();
      addMsg(text, 'bot');
    }, delay);
  }

  /* ── Toggle ── */
  function toggle() {
    isOpen = !isOpen;
    win.classList.toggle('open', isOpen);
    badge.classList.remove('show');
    if (isOpen && !greeted) {
      greeted = true;
      setTimeout(() => {
        addMsg(`Hi! I'm **Apy**, your APRABot concierge 👋\n\nI can help with questions about our AI demand forecasting platform — pricing, how it works, integrations, or booking a demo.\n\nWhat can I help you with today?`, 'bot');
      }, 300);
    }
    if (isOpen) setTimeout(() => input.focus(), 300);
  }

  /* ── Send message ── */
  function send(text) {
    text = (text || input.value).trim();
    if (!text) return;
    input.value = '';
    hideChips();
    addMsg(text, 'user');
    const reply = getReply(text);
    botReply(reply, 800 + Math.random() * 400);
  }

  /* ── Events ── */
  document.getElementById('apy-btn').addEventListener('click', toggle);
  document.getElementById('apy-close').addEventListener('click', toggle);
  document.getElementById('apy-send').addEventListener('click', () => send());
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

  document.getElementById('apy-chips').addEventListener('click', e => {
    const chip = e.target.closest('.apy-chip');
    if (chip) send(chip.dataset.q);
  });

  /* ── Show badge after 4s if not opened ── */
  setTimeout(() => {
    if (!isOpen) badge.classList.add('show');
  }, 4000);

})();
