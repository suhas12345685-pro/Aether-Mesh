/**
 * Aether Mesh — Marketing Site JavaScript
 * Features:
 *  - Sticky nav glassmorphism on scroll
 *  - Smooth scroll for anchor links
 *  - Intersection Observer scroll animations
 *  - Terminal typing animation (looping demo)
 *  - Pricing toggle: local ↔ cloud with animated price flip
 *  - Live task counter animation
 */

'use strict';

/* ============================================================
   STICKY NAV
   ============================================================ */
(function initStickyNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;

  const onScroll = () => {
    if (window.scrollY > 24) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll(); // Check on load
})();


/* ============================================================
   SMOOTH SCROLL
   ============================================================ */
(function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href === '#' || href === '#!') return;
      const target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      const navHeight = document.getElementById('nav')?.offsetHeight ?? 72;
      const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });
})();


/* ============================================================
   SCROLL-TRIGGERED ANIMATIONS (Intersection Observer)
   ============================================================ */
(function initScrollAnimations() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          // Unobserve once visible for performance
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.12,
      rootMargin: '0px 0px -40px 0px'
    }
  );

  document.querySelectorAll('.fade-up, .fade-in, .stagger-children').forEach(el => {
    observer.observe(el);
  });
})();


/* ============================================================
   TERMINAL TYPING ANIMATION
   ============================================================ */
(function initTerminal() {
  const output = document.getElementById('terminal-output');
  if (!output) return;

  const DEMO_FRAMES = [
    { type: 'system',  text: '[00:00:00] Aether Mesh v2.1.4 — heartbeat starting...' },
    { type: 'system',  text: '[00:00:01] Connecting to Slack workspace: acme-corp...' },
    { type: 'success', text: '[00:00:02] ✓ Connected. Monitoring 8 channels.' },
    { type: 'muted',   text: '─'.repeat(52) },
    { type: 'system',  text: '[00:01:00] ⟳ Heartbeat tick #247' },
    { type: 'prompt',  text: 'Scanning #dev-backend (23 new messages)...' },
    { type: 'user',    text: 'jess: "Can someone write up the API migration docs?"' },
    { type: 'user',    text: 'alex: "+1 that, been meaning to ask too"' },
    { type: 'task',    text: '⚡ TASK DETECTED: "Write API migration documentation"' },
    { type: 'system',  text: '[00:01:03] Routing to Brain: claude-3-5-sonnet...' },
    { type: 'muted',   text: '  Gathering context: last 50 messages, codebase refs...' },
    { type: 'muted',   text: '  Drafting deliverable...' },
    { type: 'success', text: '[00:01:08] ✓ Deliverable ready (1,847 tokens)' },
    { type: 'success', text: '[00:01:09] ✓ Posted to #dev-backend' },
    { type: 'success', text: '  Reactions: 👍 5  🚀 3  ❤️ 2' },
    { type: 'muted',   text: '─'.repeat(52) },
    { type: 'system',  text: '[00:01:10] Memory updated. Score: +0.94' },
    { type: 'system',  text: '[00:02:00] ⟳ Heartbeat tick #248 — scanning...' },
  ];

  const COLORS = {
    system:  '#a5b4fc',
    success: '#10b981',
    muted:   '#4d5566',
    prompt:  '#6366f1',
    user:    '#7d8590',
    task:    '#f59e0b',
  };

  let frameIndex = 0;
  let charIndex = 0;
  let lines = [];
  let currentLineEl = null;
  const MAX_LINES = 16;
  const FRAME_PAUSE = 480;   // ms between lines
  const CHAR_SPEED = 18;     // ms per character

  function createLineEl(type) {
    const el = document.createElement('div');
    el.className = 'term-line';
    el.style.color = COLORS[type] || COLORS.system;

    if (type === 'prompt') {
      const prompt = document.createElement('span');
      prompt.className = 'term-prompt';
      prompt.textContent = '$ ';
      el.appendChild(prompt);
    }

    const textSpan = document.createElement('span');
    el.appendChild(textSpan);
    return { el, textSpan };
  }

  function typeNextChar() {
    if (frameIndex >= DEMO_FRAMES.length) {
      // Restart after pause
      setTimeout(() => {
        frameIndex = 0;
        charIndex = 0;
        lines = [];
        currentLineEl = null;
        output.innerHTML = '';
        setTimeout(typeNextChar, 800);
      }, 2500);
      return;
    }

    const frame = DEMO_FRAMES[frameIndex];

    if (charIndex === 0) {
      // Start a new line
      const { el, textSpan } = createLineEl(frame.type);
      currentLineEl = textSpan;
      output.appendChild(el);
      lines.push(el);

      // Trim old lines
      if (lines.length > MAX_LINES) {
        const removed = lines.shift();
        removed.remove();
      }

      // Keep scroll at bottom
      output.scrollTop = output.scrollHeight;
    }

    const text = frame.text;

    if (charIndex < text.length) {
      currentLineEl.textContent += text[charIndex];
      charIndex++;
      setTimeout(typeNextChar, CHAR_SPEED);
    } else {
      // Finished this line — add cursor blink then move to next
      charIndex = 0;
      frameIndex++;
      output.scrollTop = output.scrollHeight;
      setTimeout(typeNextChar, FRAME_PAUSE);
    }
  }

  // Add blinking cursor placeholder
  const cursorEl = document.createElement('span');
  cursorEl.className = 'term-cursor';
  output.appendChild(cursorEl);

  setTimeout(typeNextChar, 600);
})();


/* ============================================================
   PRICING CONFIGURATOR
   ============================================================ */
(function initPricingConfigurator() {
  const devicePC = document.getElementById('device-pc');
  const deviceMobile = document.getElementById('device-mobile');
  const deployLocal = document.getElementById('deploy-local');
  const deployCloud = document.getElementById('deploy-cloud');
  const hintEl = document.getElementById('advisor-hint');

  if (!devicePC || !deviceMobile || !deployLocal || !deployCloud) return;

  const PRICES = {
    local: {
      intern:     { num: '$19',    period: '/month' },
      manager:    { num: '$49',    period: '/month' },
      enterprise: { num: 'Custom', period: 'contact us' },
    },
    cloud: {
      intern:     { num: '$34',    period: '/month' },
      manager:    { num: '$78',    period: '/month' },
      enterprise: { num: 'Custom', period: 'cloud SLA' },
    }
  };

  let selectedDevice = 'pc';
  let selectedDeploy = 'local';

  function flipPrice(elId, newText) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.classList.remove('flip');
    void el.offsetWidth; // force reflow
    el.textContent = newText;
    el.classList.add('flip');
    el.addEventListener('animationend', () => el.classList.remove('flip'), { once: true });
  }

  function updateDisplay() {
    const mode = selectedDeploy;
    const isCloud = mode === 'cloud';
    const tiers = ['intern', 'manager', 'enterprise'];

    // Update pricing numbers
    tiers.forEach(tier => {
      flipPrice(`price-${tier}`, PRICES[mode][tier].num);
      const periodEl = document.getElementById(`period-${tier}`);
      if (periodEl) periodEl.textContent = PRICES[mode][tier].period;

      const deltaEl = document.getElementById(`cloud-delta-${tier}`);
      if (deltaEl) {
        if (isCloud) {
          deltaEl.classList.remove('hidden');
        } else {
          deltaEl.classList.add('hidden');
        }
      }

      // Update CTA buttons text dynamically
      const cardEl = document.getElementById(`price-${tier}`)?.closest('.price-card');
      if (cardEl) {
        const ctaBtn = cardEl.querySelector('.plan-cta');
        if (ctaBtn && tier !== 'enterprise') {
          if (isCloud) {
            ctaBtn.textContent = 'Deploy to Cloud →';
            ctaBtn.setAttribute('href', 'dashboard.html?deploy=cloud');
          } else {
            ctaBtn.textContent = 'Download App →';
            ctaBtn.setAttribute('href', 'dashboard.html?deploy=local');
          }
        }
      }
    });

    // Update advisor hint text
    if (selectedDevice === 'pc') {
      if (selectedDeploy === 'local') {
        hintEl.textContent = '🖥️ Laptop / PC deployment uses our Tauri v2 app with secure local Docker/WSL2 sandboxing.';
      } else {
        hintEl.textContent = '☁️ PC Cloud hosting runs your agent 24/7 on our zero-knowledge infra. Manage via any web console.';
      }
    } else {
      if (selectedDeploy === 'local') {
        hintEl.textContent = '📱 Android runs locally via PRoot Alpine Linux container APK. Note: iOS devices require Cloud Hosted deployment.';
      } else {
        hintEl.textContent = '☁️ Mobile Cloud hosting runs your agent 24/7. Connect your Slack/Teams/WhatsApp, access via mobile PWA.';
      }
    }
  }

  // Event listeners for device selection
  devicePC.addEventListener('click', () => {
    selectedDevice = 'pc';
    devicePC.classList.add('active');
    deviceMobile.classList.remove('active');
    updateDisplay();
  });

  deviceMobile.addEventListener('click', () => {
    selectedDevice = 'mobile';
    deviceMobile.classList.add('active');
    devicePC.classList.remove('active');
    updateDisplay();
  });

  // Event listeners for deployment selection
  deployLocal.addEventListener('click', () => {
    selectedDeploy = 'local';
    deployLocal.classList.add('active');
    deployCloud.classList.remove('active');
    updateDisplay();
  });

  deployCloud.addEventListener('click', () => {
    selectedDeploy = 'cloud';
    deployCloud.classList.add('active');
    deployLocal.classList.remove('active');
    updateDisplay();
  });

  updateDisplay(); // initial run
})();


/* ============================================================
   LIVE TASK COUNTER (cosmetic animation)
   ============================================================ */
(function initTaskCounter() {
  const el = document.getElementById('task-counter');
  if (!el) return;

  let count = 247;

  function tick() {
    const increment = Math.floor(Math.random() * 3); // 0-2 per tick
    if (increment > 0) {
      count += increment;
      el.textContent = `${count.toLocaleString()} tasks completed today`;
    }
    setTimeout(tick, 8000 + Math.random() * 12000);
  }

  tick();
})();
