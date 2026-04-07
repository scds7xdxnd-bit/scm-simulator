(() => {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const AGENT_NAMES   = ['Retailer', 'Distributor', 'Manufacturer', 'Supplier'];
  const AGENT_COLORS  = ['#FF2D7B', '#00D4FF', '#A8FF00', '#7C3AED'];
  const BASE_DEMAND   = 10;
  const INIT_INV      = 40;
  const LEAD_TIME     = 2;
  const VISIBLE_TICKS = 80;

  const PARAM_HELP = {
    shockMagnitude : 'Multiplies consumer demand per Chaos hit (1.0–4.0×). At 1.0 a hit has no demand effect. At 2× a single Chaos click doubles demand for that one tick. Multiple clicks before a tick stack linearly — two 2× hits produce 30 units demand vs. the 10-unit baseline.',
    panicThreshold : 'Inventory level below which an agent panic-orders (0–40 units). At 0 agents never panic, representing near-normal behaviour with no fear-driven amplification. Higher thresholds trigger panic earlier across more nodes, strongly amplifying the bullwhip — a common cause of real-world inventory crises.',
    panicMultiplier: 'Order multiplier while an agent is in panic mode (1.0–4.0×). At 1.0 there is no panic amplification, producing near-normal reorder behaviour. Procurement teams facing low stock often over-order to avoid future shortages, creating upstream supply oscillation.',
    safetyStock    : 'Target buffer inventory each node tries to hold above expected demand (0–40 units). Zero safety stock reduces holding costs but leaves the chain vulnerable to service failures. Higher values amplify order swings when demand shifts, since every node simultaneously tries to rebuild buffers.',
  };

  // ── Simulation config ─────────────────────────────────────────────────────────
  const simulationConfig = {
    shockMagnitude  : 2.0,
    panicThreshold  : 20,
    panicMultiplier : 2.0,
    safetyStock     : 10,
    leadTimeCoverage: LEAD_TIME,
    speedTps        : 4,
    pendingChanges  : {},
  };

  // ── Simulation state ──────────────────────────────────────────────────────────
  const simulationState = {
    running              : false,
    tick                 : 0,
    lastTickTime         : 0,
    rafId                : null,
    consumerDemandHistory: [],
    pendingChaosHits     : 0,    // queued hits not yet applied
    chaosHitTicks        : [],   // tick indices where chaos was applied
  };

  // ── Per-agent starting conditions (persists across resets) ────────────────────
  const startingConditions = AGENT_NAMES.map(() => ({
    inventory    : INIT_INV,
    backlog      : 0,
    outgoingOrder: BASE_DEMAND,
  }));

  // ── Global starting condition: customer demand baseline ───────────────────────
  const startingGlobal = {
    customerDemand: BASE_DEMAND,
  };

  const agentState = {
    agents: [],
  };

  const chartState = {
    hoveredTick       : null,   // shared across both charts
    hoverInInv        : false,
    hoverInOrd        : false,
    userScrolled      : false,
    programmaticScroll: false,
    visibleTicks      : VISIBLE_TICKS,
  };

  const insightState = {
    events : [],
    summary: '',
  };

  const agentVisibility = [true, true, true, true];

  // ── Panic overlay UI state ────────────────────────────────────────────────────
  const panicOverlayState = {
    globalEnabled: true,
  };

  // ── getInitialAgentState ──────────────────────────────────────────────────────
  function getInitialAgentState(i) {
    const sc  = startingConditions[i];
    const inv = Math.max(0, Math.min(500, sc.inventory));
    const blg = Math.max(0, Math.min(500, sc.backlog));
    const ord = Math.max(0, Math.min(500, sc.outgoingOrder));
    return {
      name             : AGENT_NAMES[i],
      inventory        : inv,
      backlog          : blg,
      incomingOrder    : ord,
      outgoingOrder    : ord,
      onOrderPipeline  : [ord, ord],
      orderHistory     : [ord, ord, ord],
      historyInventory : [],
      historyOrders    : [],
      historyBacklog   : [],
      historyPanic     : [],
      isPanicking      : false,
      _panicFired      : false,
      _backlogMilestone: 0,
    };
  }

  // ── Agent factory ─────────────────────────────────────────────────────────────
  function createAgents() {
    return AGENT_NAMES.map((_, i) => getInitialAgentState(i));
  }

  // ── RAF loop ──────────────────────────────────────────────────────────────────
  function loop(timestamp) {
    if (!simulationState.running) return;
    const elapsed  = timestamp - simulationState.lastTickTime;
    const interval = 1000 / simulationConfig.speedTps;
    if (elapsed >= interval) {
      simulateTick();
      simulationState.lastTickTime = timestamp;
    }
    simulationState.rafId = requestAnimationFrame(loop);
  }

  // ── initApp ───────────────────────────────────────────────────────────────────
  function initApp() {
    agentState.agents = createAgents();
    initControls();
    initStartingConditionsControls();
    renderParameterHelp();
    updateAgentCards();
    renderCharts();
    renderInsights();
    updateStatusIndicator();
    _updateButtonStates();
    initScrollSync();

    let _resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(handleResize, 150);
    });
  }

  // ── initControls ──────────────────────────────────────────────────────────────
  function initControls() {
    // Speed
    const speedSlider = document.getElementById('speed_slider');
    const speedVal    = document.getElementById('speed_val');
    speedSlider.addEventListener('input', () => {
      const v = parseInt(speedSlider.value, 10);
      simulationConfig.speedTps = v;
      speedVal.textContent = v + ' tps';
    });

    // Parameter sliders
    const sliderDefs = [
      { id: 'shock_magnitude', key: 'shockMagnitude',  fmt: v => v.toFixed(1) + '×'   },
      { id: 'panic_threshold', key: 'panicThreshold',  fmt: v => String(Math.round(v)) },
      { id: 'panic_multiplier',key: 'panicMultiplier', fmt: v => v.toFixed(1) + '×'   },
      { id: 'safety_stock',    key: 'safetyStock',     fmt: v => String(Math.round(v)) },
    ];

    sliderDefs.forEach(({ id, key, fmt }) => {
      const slider  = document.getElementById(id);
      const display = document.getElementById(id + '_val');
      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        display.textContent = fmt(val);
        if (simulationState.running) {
          simulationConfig.pendingChanges[key] = val;
          recordEvent('param', key + ' → ' + fmt(val) + ' (queued)');
        } else {
          simulationConfig[key] = val;
          renderInsights();
        }
      });
    });

    // Playback buttons
    document.getElementById('btn_play_pause').addEventListener('click', () => {
      if (simulationState.running) pauseSimulation();
      else if (simulationState.tick === 0) startSimulation();
      else resumeSimulation();
    });
    document.getElementById('btn_step').addEventListener('click', stepSimulation);
    document.getElementById('btn_reset').addEventListener('click', resetSimulation);

    // Chaos button — always enabled; queues a hit for next tick
    document.getElementById('btn_chaos_hit').addEventListener('click', queueChaosHit);

    // Shared agent legend — controls both charts and panic shading simultaneously
    AGENT_NAMES.forEach((_, i) => {
      const chip = document.getElementById('toggle_agent_' + i);
      if (!chip) return;
      chip.addEventListener('click', () => {
        agentVisibility[i] = !agentVisibility[i];
        chip.dataset.active = String(agentVisibility[i]);
        chip.setAttribute('aria-pressed', String(agentVisibility[i]));
        renderCharts();
      });
    });

    // Panic overlay — global checkbox
    const globalChk = document.getElementById('panic_overlay_global');
    if (globalChk) {
      globalChk.addEventListener('change', () => {
        panicOverlayState.globalEnabled = globalChk.checked;
        renderCharts();
      });
    }

    // Chart hover — shared hover state
    _attachChartHover('chart_inventory', 'inventory');
    _attachChartHover('chart_orders',    'orders');
  }

  // ── queueChaosHit ─────────────────────────────────────────────────────────────
  function queueChaosHit() {
    simulationState.pendingChaosHits++;
    const count = simulationState.pendingChaosHits;
    recordEvent('chaos',
      `Chaos queued (${count} hit${count > 1 ? 's' : ''} pending — applies at week ${simulationState.tick})`
    );
  }

  // ── applyQueuedChaosHits ──────────────────────────────────────────────────────
  // Drains the pending hit counter and returns the count for this tick.
  function applyQueuedChaosHits() {
    const hits = simulationState.pendingChaosHits;
    simulationState.pendingChaosHits = 0;
    return hits;
  }

  // ── initStartingConditionsControls ────────────────────────────────────────────
  function initStartingConditionsControls() {
    AGENT_NAMES.forEach((_, i) => {
      ['inv', 'blg', 'ord'].forEach(field => {
        const input = document.getElementById('start_' + field + '_' + i);
        if (!input) return;
        input.addEventListener('change', () => {
          let v = parseInt(input.value, 10);
          if (isNaN(v) || v < 0) v = 0;
          if (v > 500)           v = 500;
          input.value = v;
        });
      });
    });
    const cdInput = document.getElementById('start_customer_demand');
    if (cdInput) {
      cdInput.addEventListener('change', () => {
        let v = parseInt(cdInput.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        if (v > 500)           v = 500;
        cdInput.value = v;
      });
    }
    document.getElementById('btn_apply_starts').addEventListener('click', applyStartingConditions);
  }

  // ── applyStartingConditions ───────────────────────────────────────────────────
  function applyStartingConditions() {
    const clamp = (v, def) => Math.max(0, Math.min(500, isNaN(v) ? def : v));
    AGENT_NAMES.forEach((_, i) => {
      const inv = parseInt(document.getElementById('start_inv_' + i).value, 10);
      const blg = parseInt(document.getElementById('start_blg_' + i).value, 10);
      const ord = parseInt(document.getElementById('start_ord_' + i).value, 10);
      startingConditions[i] = {
        inventory    : clamp(inv, INIT_INV),
        backlog      : clamp(blg, 0),
        outgoingOrder: clamp(ord, BASE_DEMAND),
      };
    });
    const cdInput = document.getElementById('start_customer_demand');
    if (cdInput) {
      const cd = parseInt(cdInput.value, 10);
      startingGlobal.customerDemand = Math.max(0, Math.min(500, isNaN(cd) ? BASE_DEMAND : cd));
    }
    recordEvent('info', 'Starting conditions saved — press Reset to apply');
  }

  // ── initScrollSync ────────────────────────────────────────────────────────────
  // Attaches scroll listeners that keep both chart containers in lock-step.
  // A closure lock prevents the sync from triggering an infinite event loop.
  function initScrollSync() {
    const invEl = document.getElementById('scroll_inv');
    const ordEl = document.getElementById('scroll_ord');
    if (!invEl || !ordEl) return;

    let syncLock = false;

    function syncChartScroll(source, target) {
      if (syncLock) return;
      syncLock = true;
      target.scrollLeft = source.scrollLeft;
      syncLock = false;
    }

    invEl.addEventListener('scroll', () => {
      if (!chartState.programmaticScroll) {
        const atEnd = invEl.scrollLeft >= invEl.scrollWidth - invEl.clientWidth - 4;
        chartState.userScrolled = !atEnd;
      }
      syncChartScroll(invEl, ordEl);
    });

    ordEl.addEventListener('scroll', () => {
      if (!chartState.programmaticScroll) {
        const atEnd = ordEl.scrollLeft >= ordEl.scrollWidth - ordEl.clientWidth - 4;
        chartState.userScrolled = !atEnd;
      }
      syncChartScroll(ordEl, invEl);
    });
  }

  // ── _attachChartHover ─────────────────────────────────────────────────────────
  function _attachChartHover(canvasId, chartKey) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    canvas.addEventListener('mousemove', e => {
      if (chartKey === 'inventory') chartState.hoverInInv = true;
      else                          chartState.hoverInOrd = true;
      handleChartHover(e, canvas, chartKey);
    });

    canvas.addEventListener('mouseleave', () => {
      if (chartKey === 'inventory') chartState.hoverInInv = false;
      else                          chartState.hoverInOrd = false;

      // Only clear hover when pointer is over neither chart
      if (!chartState.hoverInInv && !chartState.hoverInOrd) {
        chartState.hoveredTick = null;
        document.getElementById('tooltip_inventory').classList.add('hidden');
        document.getElementById('tooltip_orders').classList.add('hidden');
        renderCharts();
      }
    });
  }

  // ── startSimulation ───────────────────────────────────────────────────────────
  function startSimulation() {
    if (simulationState.running) return;
    simulationState.running      = true;
    simulationState.lastTickTime = 0;
    simulationState.rafId        = requestAnimationFrame(loop);
    updateStatusIndicator();
    _updateButtonStates();
  }

  // ── pauseSimulation ───────────────────────────────────────────────────────────
  function pauseSimulation() {
    if (!simulationState.running) return;
    simulationState.running = false;
    if (simulationState.rafId !== null) {
      cancelAnimationFrame(simulationState.rafId);
      simulationState.rafId = null;
    }
    updateStatusIndicator();
    _updateButtonStates();
    renderInsights();
  }

  // ── resumeSimulation ──────────────────────────────────────────────────────────
  function resumeSimulation() {
    if (simulationState.running || simulationState.tick === 0) return;
    simulationState.running      = true;
    simulationState.lastTickTime = 0;
    simulationState.rafId        = requestAnimationFrame(loop);
    updateStatusIndicator();
    _updateButtonStates();
  }

  // ── stepSimulation ────────────────────────────────────────────────────────────
  function stepSimulation() {
    if (simulationState.running) return;
    simulateTick();
  }

  // ── resetSimulation ───────────────────────────────────────────────────────────
  function resetSimulation() {
    pauseSimulation();

    simulationConfig.shockMagnitude   = 2.0;
    simulationConfig.panicThreshold   = 20;
    simulationConfig.panicMultiplier  = 2.0;
    simulationConfig.safetyStock      = 10;
    simulationConfig.speedTps         = 4;
    simulationConfig.leadTimeCoverage = LEAD_TIME;
    simulationConfig.pendingChanges   = {};

    simulationState.tick                  = 0;
    simulationState.lastTickTime          = 0;
    simulationState.consumerDemandHistory = [];
    simulationState.pendingChaosHits      = 0;
    simulationState.chaosHitTicks         = [];

    // Re-create agents using currently stored starting conditions
    agentState.agents = createAgents();

    insightState.events  = [];
    insightState.summary = '';

    agentVisibility.fill(true);
    AGENT_NAMES.forEach((_, i) => {
      const chip = document.getElementById('toggle_agent_' + i);
      if (chip) { chip.dataset.active = 'true'; chip.setAttribute('aria-pressed', 'true'); }
    });

    // Reset panic overlay to default enabled state
    panicOverlayState.globalEnabled = true;
    const globalChk = document.getElementById('panic_overlay_global');
    if (globalChk) globalChk.checked = true;

    chartState.hoveredTick        = null;
    chartState.hoverInInv         = false;
    chartState.hoverInOrd         = false;
    chartState.userScrolled       = false;
    chartState.programmaticScroll = false;

    document.getElementById('tooltip_inventory').classList.add('hidden');
    document.getElementById('tooltip_orders').classList.add('hidden');

    // Scroll both containers back to start
    ['scroll_inv', 'scroll_ord'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.scrollLeft = 0;
    });

    _syncSlidersToConfig();
    // Sync starting condition inputs to the stored (applied) values
    _syncStartInputsToConditions();
    updateAgentCards();
    renderCharts();
    renderInsights();
    updateStatusIndicator();
    _updateButtonStates();
    updateEventTimeline();
  }

  // ── applyPendingParameterChanges ──────────────────────────────────────────────
  function applyPendingParameterChanges() {
    const pending = simulationConfig.pendingChanges;
    const keys    = Object.keys(pending);
    if (keys.length === 0) return;
    keys.forEach(k => { simulationConfig[k] = pending[k]; });
    simulationConfig.pendingChanges = {};
  }

  // ── simulateTick ──────────────────────────────────────────────────────────────
  function simulateTick() {
    applyPendingParameterChanges();

    const tick   = simulationState.tick;
    const cfg    = simulationConfig;
    const agents = agentState.agents;

    // Consumer demand — chaos-driven impulse (returns to base between hits)
    const hits           = applyQueuedChaosHits();
    const baseDemand     = startingGlobal.customerDemand;
    const consumerDemand = baseDemand + baseDemand * (cfg.shockMagnitude - 1) * hits;

    if (hits > 0) {
      simulationState.chaosHitTicks.push(tick);
      recordEvent('chaos',
        `Chaos ×${hits}: demand spiked to ${consumerDemand.toFixed(0)} units (week ${tick})`
      );
    }
    simulationState.consumerDemandHistory.push(consumerDemand);

    /*
      Daily operations view:
      Think of each tick as one business day (or week) in a real supply chain. Each node first receives trucks that were already in transit,
      then processes today's demand from downstream partners. The retailer reacts to customer purchases directly, while distributor,
      manufacturer, and supplier react to purchase orders sent by the next node down the chain.

      Managers then reconcile what they could ship versus what they could not. Unfilled demand becomes backlog (open orders) that carries
      into the next period. Replenishment is planned from three practical inputs: recent demand trend, desired safety buffer, and stock
      already on the way. This mirrors common S&OP behavior where planners avoid double-ordering by subtracting pipeline inventory.

      If stock falls below a risk threshold, teams switch into defensive behavior and order more aggressively (panic mode), similar to how
      buyers react during shortage signals. After placing the new order upstream, the system records inventory, ordering, and backlog KPIs,
      and emits event alerts when stress indicators (panic entry, backlog milestones) cross important operational thresholds.
    */
   
    // Capture previous outgoing orders (1-tick order propagation delay)
    const prevOutgoing = agents.map(a => a.outgoingOrder);

    agents.forEach((agent, i) => {
      // 1. Receive shipment arriving this tick
      const arriving = agent.onOrderPipeline.shift();
      agent.inventory += arriving;

      // 2. Incoming order
      agent.incomingOrder = i === 0 ? consumerDemand : prevOutgoing[i - 1];

      // 3. Fulfill demand + backlog
      const totalDemand = agent.incomingOrder + agent.backlog;
      const shipped     = Math.min(agent.inventory, totalDemand);
      agent.inventory  -= shipped;
      agent.backlog     = Math.max(0, totalDemand - shipped);

      // 4. Rolling demand estimate (last 3 incoming orders)
      agent.orderHistory.push(agent.incomingOrder);
      if (agent.orderHistory.length > 3) agent.orderHistory.shift();
      const demandEst = agent.orderHistory.reduce((s, v) => s + v, 0) / agent.orderHistory.length;

      // 5. On-order after receiving (before placing new order)
      const onOrder = agent.onOrderPipeline.reduce((s, v) => s + v, 0);

      // 6. Reorder target
      let reorderQty = Math.max(0,
        demandEst * cfg.leadTimeCoverage + cfg.safetyStock - agent.inventory - onOrder
      );

      // 7. Panic override
      const wasPanicking = agent.isPanicking;
      agent.isPanicking  = agent.inventory < cfg.panicThreshold;
      if (agent.isPanicking) reorderQty *= cfg.panicMultiplier;
      reorderQty = Math.max(0, Math.round(reorderQty));

      // Record first-time panic per episode
      if (agent.isPanicking && !wasPanicking && tick > 0) {
        if (!agent._panicFired) {
          agent._panicFired = true;
          recordEvent('panic', `${agent.name} entered panic: inventory at ${agent.inventory.toFixed(0)} units`);
        }
      }
      if (!agent.isPanicking) agent._panicFired = false;

      // 8. Place order
      agent.outgoingOrder = reorderQty;
      agent.onOrderPipeline.push(reorderQty);

      // 9. Record history
      agent.historyInventory.push(agent.inventory);
      agent.historyOrders.push(agent.outgoingOrder);
      agent.historyBacklog.push(agent.backlog);
      agent.historyPanic.push(agent.isPanicking);

      // Backlog milestone events (every 20-unit step)
      const milestone = Math.floor(agent.backlog / 20) * 20;
      if (agent.backlog >= 20 && milestone > agent._backlogMilestone) {
        agent._backlogMilestone = milestone;
        recordEvent('backlog', `${agent.name} backlog reached ${agent.backlog.toFixed(0)} units`);
      }
    });

    simulationState.tick++;
    updateAgentCards();
    renderCharts();
    _autoScrollCharts();
    renderInsights();
    updateStatusIndicator();
  }

  // ── updateAgentCards ──────────────────────────────────────────────────────────
  function updateAgentCards() {
    agentState.agents.forEach((agent, i) => {
      const invEl   = document.getElementById('inv_'   + i);
      const ordEl   = document.getElementById('ord_'   + i);
      const blgEl   = document.getElementById('blg_'   + i);
      const panicEl = document.getElementById('panic_' + i);
      if (invEl)   invEl.textContent   = agent.inventory.toFixed(0);
      if (ordEl)   ordEl.textContent   = agent.outgoingOrder.toFixed(0);
      if (blgEl)   blgEl.textContent   = agent.backlog.toFixed(0);
      if (panicEl) panicEl.classList.toggle('hidden', !agent.isPanicking);
    });
  }

  // ── renderCharts ──────────────────────────────────────────────────────────────
  function renderCharts() {
    const agents  = agentState.agents;
    const invData = agents.map(a => a.historyInventory);
    const ordData = agents.map(a => a.historyOrders);
    drawLineChart(document.getElementById('chart_inventory'), invData, 'units');
    drawLineChart(document.getElementById('chart_orders'),    ordData, 'units');
  }

  // ── hexToRgba ─────────────────────────────────────────────────────────────────
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // ── drawLineChart ─────────────────────────────────────────────────────────────
  // canvas is inside .chart-scroll-outer which is inside .chart-wrap.
  // For ticks ≤ VISIBLE_TICKS the canvas fills the viewport (stretch mode).
  // For ticks > VISIBLE_TICKS the canvas expands and the scroll container scrolls.
  // The Y-axis and legend are drawn at the current scroll position so they
  // always appear at the left/right edges of the visible viewport.
  function drawLineChart(canvas, seriesData, yLabel) {
    const dpr        = window.devicePixelRatio || 1;
    const scrollEl   = canvas.parentElement;          // .chart-scroll-outer
    const viewportW  = Math.max(1, scrollEl.clientWidth);
    const cssH       = Math.max(100, scrollEl.clientHeight);
    const scrollLeft = scrollEl.scrollLeft;

    const PL = 50, PR = 12, PT = 12, PB = 30;
    const plotViewportW = Math.max(1, viewportW - PL - PR);
    const plotH         = cssH - PT - PB;

    const totalTicks = simulationState.tick;

    // Compute canvas width and pixels-per-tick
    let cssW, pxPerTick;
    if (totalTicks <= VISIBLE_TICKS) {
      // Stretch: all ticks fit within viewport width
      cssW      = viewportW;
      pxPerTick = totalTicks > 1 ? plotViewportW / (totalTicks - 1) : plotViewportW;
    } else {
      // Scroll: fixed density — plotViewportW shows exactly VISIBLE_TICKS ticks
      pxPerTick = plotViewportW / VISIBLE_TICKS;
      cssW      = Math.ceil(PL + totalTicks * pxPerTick + PR);
    }

    // Resize canvas if needed
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width        = pxW;
      canvas.height       = pxH;
      canvas.style.width  = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Y-axis canvas x: PL + scrollLeft → always appears at viewport x = PL
    const yAxisX = PL + scrollLeft;

    // toX: maps tick index → canvas x coordinate
    const toX = t => PL + t * pxPerTick;

    // Full-width X-axis baseline
    const dataEndX = totalTicks > 0 ? toX(Math.max(0, totalTicks - 1)) : PL + plotViewportW;
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(PL, PT + plotH);
    ctx.lineTo(Math.max(dataEndX, PL + plotViewportW), PT + plotH);
    ctx.stroke();

    // Sticky Y-axis line
    ctx.beginPath();
    ctx.moveTo(yAxisX, PT);
    ctx.lineTo(yAxisX, PT + plotH);
    ctx.stroke();

    if (totalTicks === 0) return;

    // Y range — computed from ALL history of visible agents for stable scale
    let yMin = Infinity, yMax = -Infinity;
    seriesData.forEach((s, idx) => {
      if (!agentVisibility[idx]) return;
      for (let t = 0; t < s.length; t++) {
        if (s[t] < yMin) yMin = s[t];
        if (s[t] > yMax) yMax = s[t];
      }
    });
    if (!isFinite(yMin)) { yMin = 0; yMax = 10; }
    yMin = Math.min(0, Math.floor(yMin / 10) * 10);
    yMax = Math.max(10, Math.ceil(yMax / 10) * 10);
    const yRange = yMax - yMin || 10;

    const toY = v => PT + plotH - ((v - yMin) / yRange) * plotH;

    // Horizontal grid lines + Y labels — drawn at sticky Y-axis position
    ctx.font         = '10px Inter, sans-serif';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const gv = yMin + (yRange / 4) * i;
      const gy = toY(gv);
      ctx.strokeStyle = '#f3f4f6';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(yAxisX, gy);
      ctx.lineTo(yAxisX + plotViewportW, gy);
      ctx.stroke();
      ctx.fillStyle = '#9ca3af';
      ctx.fillText(Math.round(gv), yAxisX - 4, gy);
    }

    // X labels — only the visible tick range to keep performance acceptable
    const safePpt    = Math.max(0.001, pxPerTick);
    const vTickStart = Math.max(0, Math.floor(scrollLeft / safePpt) - 1);
    const vTickEnd   = Math.min(totalTicks - 1, Math.ceil((scrollLeft + viewportW) / safePpt) + 1);
    const step       = Math.max(1, Math.ceil((vTickEnd - vTickStart + 1) / 6));

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = '#9ca3af';
    ctx.font         = '10px Inter, sans-serif';
    for (let t = vTickStart; t <= vTickEnd; t++) {
      if ((t - vTickStart) % step === 0 || t === totalTicks - 1) {
        ctx.fillText(t, toX(t), PT + plotH + 4);
      }
    }

    // Y-axis label (rotated), sticky at left edge of viewport
    ctx.save();
    ctx.translate(yAxisX - 36, PT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#6b7280';
    ctx.font         = '600 10px Inter, sans-serif';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    // Re-draw Y-axis line on top of grid
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(yAxisX, PT);
    ctx.lineTo(yAxisX, PT + plotH);
    ctx.stroke();

    // ── Chaos hit markers — one dashed line per hit tick ─────────────────────
    simulationState.chaosHitTicks.forEach(hitTick => {
      if (hitTick >= totalTicks) return;
      const hx = toX(hitTick);
      ctx.strokeStyle = '#7C3AED';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, PT + 8);
      ctx.lineTo(hx, PT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      // Small dot at top of marker
      ctx.beginPath();
      ctx.arc(hx, PT + 4, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#7C3AED';
      ctx.fill();
    });

    // ── Panic shading — semi-transparent agent-colored regions ───────────────
    if (panicOverlayState.globalEnabled) {
      agentState.agents.forEach((agent, idx) => {
        if (!agentVisibility[idx]) return;
        const panicHist = agent.historyPanic;
        if (!panicHist || panicHist.length === 0) return;
        ctx.fillStyle = hexToRgba(AGENT_COLORS[idx], 0.12);
        let segStart = null;
        for (let t = 0; t < panicHist.length; t++) {
          if (panicHist[t] && segStart === null) {
            segStart = t;
          } else if (!panicHist[t] && segStart !== null) {
            const x1 = toX(segStart) - pxPerTick * 0.5;
            const x2 = toX(t - 1)   + pxPerTick * 0.5;
            ctx.fillRect(x1, PT, Math.max(0, x2 - x1), plotH);
            segStart = null;
          }
        }
        if (segStart !== null) {
          const x1 = toX(segStart) - pxPerTick * 0.5;
          const x2 = toX(panicHist.length - 1) + pxPerTick * 0.5;
          ctx.fillRect(x1, PT, Math.max(0, x2 - x1), plotH);
        }
      });
    }

    // ── Series lines ──────────────────────────────────────────────────────────
    seriesData.forEach((series, idx) => {
      if (!agentVisibility[idx]) return;
      const color = AGENT_COLORS[idx];
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      ctx.beginPath();
      let started = false;
      for (let t = 0; t < series.length; t++) {
        const x = toX(t), y = toY(series[t]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else          { ctx.lineTo(x, y); }
      }
      if (started) ctx.stroke();
    });

    // ── Hover crosshair (shared hoveredTick) ──────────────────────────────────
    const hT = chartState.hoveredTick;
    if (hT !== null && hT >= 0 && hT < totalTicks) {
      const cx = toX(hT);
      ctx.strokeStyle = 'rgba(17,17,17,0.15)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, PT);
      ctx.lineTo(cx, PT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      seriesData.forEach((series, idx) => {
        if (!agentVisibility[idx]) return;
        const v = series[hT];
        if (v === undefined) return;
        const cy = toY(v);
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle   = AGENT_COLORS[idx];
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      });
    }

  }

  // ── handleChartHover ──────────────────────────────────────────────────────────
  // getBoundingClientRect on the canvas accounts for scroll offset automatically:
  // when scrolled, the canvas's left edge shifts left in viewport space, so
  // e.clientX - rect.left gives the correct canvas-space x including scroll.
  function handleChartHover(e, canvas, chartKey) {
    const rect         = canvas.getBoundingClientRect();
    const mouseXCanvas = e.clientX - rect.left;

    const scrollEl   = canvas.parentElement;
    const viewportW  = Math.max(1, scrollEl.clientWidth);
    const totalTicks = simulationState.tick;

    const PL = 50, PR = 12;
    const plotViewportW = Math.max(1, viewportW - PL - PR);

    let pxPerTick;
    if (totalTicks <= VISIBLE_TICKS) {
      pxPerTick = totalTicks > 1 ? plotViewportW / (totalTicks - 1) : plotViewportW;
    } else {
      pxPerTick = plotViewportW / VISIBLE_TICKS;
    }

    // Boundary of the data plot area in canvas coordinates
    const plotEndX = totalTicks > 1
      ? PL + (totalTicks - 1) * pxPerTick
      : PL;

    if (totalTicks === 0 || mouseXCanvas < PL || mouseXCanvas > plotEndX + 4) {
      chartState.hoveredTick = null;
      document.getElementById('tooltip_inventory').classList.add('hidden');
      document.getElementById('tooltip_orders').classList.add('hidden');
      renderCharts();
      return;
    }

    let hT;
    if (totalTicks <= 1) {
      hT = 0;
    } else {
      hT = Math.round((mouseXCanvas - PL) / Math.max(0.001, pxPerTick));
    }
    hT = Math.max(0, Math.min(totalTicks - 1, hT));
    chartState.hoveredTick = hT;

    // Canvas x of the snapped tick — used for tooltip placement in both charts
    const canvasX = PL + hT * pxPerTick;

    if (chartKey === 'inventory') {
      _updateChartTooltip('tooltip_inventory', 'scroll_inv', hT, canvasX);
      document.getElementById('tooltip_orders').classList.add('hidden');
    } else {
      _updateChartTooltip('tooltip_orders', 'scroll_ord', hT, canvasX);
      document.getElementById('tooltip_inventory').classList.add('hidden');
    }

    renderCharts();
  }

  // ── _updateChartTooltip ───────────────────────────────────────────────────────
  function _updateChartTooltip(tooltipId, scrollId, hT, canvasX) {
    const tooltipEl = document.getElementById(tooltipId);
    const scrollEl  = document.getElementById(scrollId);

    const demand = simulationState.consumerDemandHistory[hT];
    let html = `<div class="tooltip-head">Week ${hT}</div>`;
    html    += `<div class="tooltip-demand">Consumer demand: ${demand !== undefined ? demand.toFixed(0) : '—'}</div>`;
    html    += `<div class="tooltip-hint">inv | blg | ord</div>`;
    agentState.agents.forEach((agent, i) => {
      if (!agentVisibility[i]) return;
      const inv = agent.historyInventory[hT];
      const blg = agent.historyBacklog[hT];
      const ord = agent.historyOrders[hT];
      const fmt = v => (v !== undefined ? Math.round(v) : '—');
      html += `<div><span style="color:${AGENT_COLORS[i]};font-weight:600">${agent.name}</span>: ${fmt(inv)} | ${fmt(blg)} | ${fmt(ord)}</div>`;
    });
    tooltipEl.innerHTML = html;
    tooltipEl.classList.remove('hidden');

    // Position tooltip using viewport coordinates (position:fixed bypasses overflow clipping)
    const rect       = scrollEl ? scrollEl.getBoundingClientRect() : { left: 0, top: 0, right: 600, width: 600 };
    const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0;
    const wrapX      = canvasX - scrollLeft;
    let tx = wrapX + 12;
    if (tx + 165 > rect.width) tx = wrapX - 177;
    if (tx < 0) tx = 4;
    tooltipEl.style.left = (rect.left + tx) + 'px';
    tooltipEl.style.top  = (rect.top  + 8)  + 'px';
  }

  // ── _autoScrollCharts ─────────────────────────────────────────────────────────
  // Scrolls both charts to the rightmost position together.
  function _autoScrollCharts() {
    if (chartState.userScrolled) return;
    const invEl = document.getElementById('scroll_inv');
    const ordEl = document.getElementById('scroll_ord');
    if (!invEl || !ordEl) return;
    chartState.programmaticScroll = true;
    // Use the larger scrollWidth so both land at the true end
    const target = Math.max(invEl.scrollWidth, ordEl.scrollWidth);
    invEl.scrollLeft = target;
    ordEl.scrollLeft = target;
    requestAnimationFrame(() => { chartState.programmaticScroll = false; });
  }

  // ── renderParameterHelp ───────────────────────────────────────────────────────
  function renderParameterHelp() {
    const map = {
      shockMagnitude : 'help_shockMagnitude',
      panicThreshold : 'help_panicThreshold',
      panicMultiplier: 'help_panicMultiplier',
      safetyStock    : 'help_safetyStock',
    };
    Object.keys(map).forEach(key => {
      const el = document.getElementById(map[key]);
      if (el) el.textContent = PARAM_HELP[key];
    });
  }

  // ── renderInsights ────────────────────────────────────────────────────────────
  function renderInsights() {
    const el = document.getElementById('insight_text');
    if (!el) return;

    const tick   = simulationState.tick;
    const cfg    = simulationConfig;
    const agents = agentState.agents;

    if (tick === 0) {
      el.textContent = 'Press Play or Step to begin. Use the Chaos button to inject demand spikes at any time. Configure per-agent starting conditions and click Reset to apply them.';
      return;
    }

    const baseDemand    = startingGlobal.customerDemand;
    const maxOrdByAgent = agents.map(a =>
      a.historyOrders.reduce((m, v) => (v > m ? v : m), 0)
    );
    const maxSupplierOrd = maxOrdByAgent[3];
    const ampRatio       = (maxSupplierOrd / baseDemand).toFixed(1);

    const maxBlgByAgent = agents.map(a =>
      a.historyBacklog.reduce((m, v) => (v > m ? v : m), 0)
    );
    const peakBlgIdx = maxBlgByAgent.indexOf(maxBlgByAgent.reduce((m, v) => (v > m ? v : m), 0));
    const peakBlg    = maxBlgByAgent[peakBlgIdx];

    const panicAgents = agents.filter(a => a.isPanicking);
    const allStable   = agents.every(a => a.inventory > cfg.panicThreshold && a.backlog === 0);

    const hitCount    = simulationState.chaosHitTicks.length;
    const lastHitTick = hitCount > 0 ? simulationState.chaosHitTicks[hitCount - 1] : null;
    const peakDemand  = simulationState.consumerDemandHistory.reduce(
      (m, v) => (v > m ? v : m), baseDemand
    );

    let text = '';

    if (hitCount === 0) {
      text  = `Week ${tick}: the chain is running at steady-state demand of ${baseDemand} units/week. `;
      text += `No chaos hits applied yet. Press the Chaos button to inject demand spikes and observe upstream amplification. `;
      text += `Each hit multiplies demand by ${cfg.shockMagnitude.toFixed(1)}× for that tick. Multiple hits stack linearly.`;
    } else {
      text  = `${hitCount} chaos hit${hitCount > 1 ? 's' : ''} applied — last at week ${lastHitTick}. `;
      text += `Consumer demand peaked at ${peakDemand.toFixed(0)} units/week (${(peakDemand / baseDemand).toFixed(1)}× baseline). `;

      if (maxSupplierOrd > baseDemand * 1.3) {
        text += `Each node amplified its orders upstream to rebuild safety buffers and cover lead-time uncertainty. `;
        text += `The Supplier's orders peaked at ${maxSupplierOrd.toFixed(0)} units — a ${ampRatio}× amplification of the original ${baseDemand}-unit baseline. `;
      } else {
        text += `The chain absorbed the shock with moderate amplification (Supplier peak: ${maxSupplierOrd.toFixed(0)} units, ${ampRatio}× baseline). `;
      }

      if (peakBlg > 0) {
        text += `The ${agents[peakBlgIdx].name} accumulated up to ${peakBlg.toFixed(0)} units of unfulfilled backlog, `;
        text += `meaning downstream deliveries were delayed and service levels fell. `;
      }

      if (panicAgents.length > 0) {
        const names = panicAgents.map(a => a.name).join(' and ');
        text += `${names} ${panicAgents.length === 1 ? 'is' : 'are'} currently in panic mode, `;
        text += `inflating orders by ${cfg.panicMultiplier.toFixed(1)}×. Once shipments catch up, this risks an overcorrection into excess inventory.`;
      } else if (allStable) {
        text += `At week ${tick}, all nodes are above the panic threshold with no active backlogs — the chain is stabilising.`;
      } else {
        text += `At week ${tick}, the chain is still adjusting. Monitor inventory levels for signs of recovery or further oscillation.`;
      }
    }

    insightState.summary = text;
    el.textContent       = text;
  }

  // ── recordEvent ───────────────────────────────────────────────────────────────
  function recordEvent(type, message) {
    const tick = simulationState.tick;
    const last = insightState.events[insightState.events.length - 1];
    if (last && last.message === message) return;
    insightState.events.push({ tick, type, message });
    if (insightState.events.length > 100) insightState.events.shift();
    updateEventTimeline();
  }

  // ── updateStatusIndicator ─────────────────────────────────────────────────────
  function updateStatusIndicator() {
    const dot     = document.getElementById('status_dot');
    const label   = document.getElementById('status_label');
    const counter = document.getElementById('tick_counter');
    const state   = simulationState;

    const cls  = state.running ? 'running' : (state.tick > 0 ? 'paused' : 'idle');
    const text = state.running ? 'Running' : (state.tick > 0 ? 'Paused'  : 'Idle');

    if (dot)     dot.className       = 'status-dot ' + cls;
    if (label)   label.textContent   = text;
    if (counter) counter.textContent = 'Week ' + state.tick;
  }

  // ── handleResize ──────────────────────────────────────────────────────────────
  function handleResize() {
    renderCharts();
  }

  // ── updateEventTimeline ───────────────────────────────────────────────────────
  function updateEventTimeline() {
    const el = document.getElementById('event_timeline');
    if (!el) return;
    if (insightState.events.length === 0) {
      el.innerHTML = '<p class="empty-state">Events will appear as the simulation runs.</p>';
      return;
    }
    const recent = insightState.events.slice(-40).reverse();
    el.innerHTML  = recent.map(ev =>
      `<div class="event-item event-${ev.type}">` +
      `<span class="event-tick">W${ev.tick}</span>` +
      `<span class="event-msg">${ev.message}</span>` +
      `</div>`
    ).join('');
  }

  // ── _updateButtonStates ───────────────────────────────────────────────────────
  function updatePlaybackControls() {
    const btn = document.getElementById('btn_play_pause');
    if (!btn) return;
    btn.textContent = simulationState.running ? 'Pause' : 'Play';
    btn.disabled    = false;
  }

  function _updateButtonStates() {
    const running = simulationState.running;
    const tick    = simulationState.tick;
    document.getElementById('btn_step').disabled  = running;
    document.getElementById('btn_reset').disabled = !running && tick === 0;
    updatePlaybackControls();
  }

  // ── _syncSlidersToConfig ──────────────────────────────────────────────────────
  function _syncSlidersToConfig() {
    const cfg = simulationConfig;
    _setSlider('shock_magnitude',  cfg.shockMagnitude.toFixed(1),  cfg.shockMagnitude.toFixed(1) + '×');
    _setSlider('panic_threshold',  String(cfg.panicThreshold),     String(cfg.panicThreshold));
    _setSlider('panic_multiplier', cfg.panicMultiplier.toFixed(1), cfg.panicMultiplier.toFixed(1) + '×');
    _setSlider('safety_stock',     String(cfg.safetyStock),        String(cfg.safetyStock));
    _setSlider('speed_slider',     String(cfg.speedTps),           cfg.speedTps + ' tps', 'speed_val');
  }

  function _setSlider(id, val, label, valId) {
    const slider  = document.getElementById(id);
    const display = document.getElementById(valId || id + '_val');
    if (slider)  slider.value        = val;
    if (display) display.textContent = label;
  }

  // ── _syncStartInputsToConditions ──────────────────────────────────────────────
  // Reflects the stored startingConditions back into the input fields.
  // Called on Reset so inputs show what was actually used.
  function _syncStartInputsToConditions() {
    AGENT_NAMES.forEach((_, i) => {
      const sc  = startingConditions[i];
      const inv = document.getElementById('start_inv_' + i);
      const blg = document.getElementById('start_blg_' + i);
      const ord = document.getElementById('start_ord_' + i);
      if (inv) inv.value = sc.inventory;
      if (blg) blg.value = sc.backlog;
      if (ord) ord.value = sc.outgoingOrder;
    });
    const cdInput = document.getElementById('start_customer_demand');
    if (cdInput) cdInput.value = startingGlobal.customerDemand;
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', initApp);
})();
