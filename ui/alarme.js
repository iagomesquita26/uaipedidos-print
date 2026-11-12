'use strict';
// Janelinha do alarme de pedido novo (1.1.0). Os sons sao os mesmos do painel
// (abas/_nucleo/notificacoes-som.js), gerados na hora, sem arquivo de audio.
(function () {
  let ctx = null;
  function audio() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } }
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }
  function nota(c, freq, t0, dur, vol, tipo) {
    try {
      const o = c.createOscillator(), g = c.createGain();
      o.type = tipo || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  function sweep(c, f1, f2, t0, dur, vol, tipo) {
    try {
      const o = c.createOscillator(), g = c.createGain();
      o.type = tipo || 'sawtooth';
      o.frequency.setValueAtTime(f1, t0);
      o.frequency.linearRampToValueAtTime(f2, t0 + dur / 2);
      o.frequency.linearRampToValueAtTime(f1, t0 + dur);
      g.gain.setValueAtTime(Math.max(0.001, vol), t0);
      g.gain.setValueAtTime(Math.max(0.001, vol), t0 + Math.max(0.02, dur - 0.03));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  const SONS = {
    alarme: (c, v) => { const t = c.currentTime; for (let i = 0; i < 6; i++) nota(c, i % 2 ? 784 : 988, t + i * 0.14, 0.1, 0.7 * v, 'square'); },
    sirene: (c, v) => { const t = c.currentTime; sweep(c, 600, 1200, t, 0.5, 0.85 * v); sweep(c, 600, 1200, t + 0.52, 0.5, 0.85 * v); },
    sino:   (c, v) => { const t = c.currentTime; nota(c, 880, t, 0.6, 0.35 * v); nota(c, 1174.66, t + 0.18, 0.6, 0.35 * v); },
  };

  window.alarme.aoTocar(function (d) {
    const c = audio();
    if (!c) return;
    const v = Math.max(0, Math.min(100, Number(d && d.volume) || 0)) / 100;
    if (v <= 0) return;
    (SONS[d && d.som] || SONS.alarme)(c, v);
  });

  window.alarme.aoPedidos(function (lista) {
    const l = Array.isArray(lista) ? lista : [];
    const tit = document.getElementById('tit');
    if (l.length === 1) tit.textContent = 'Pedido novo #' + l[0].numero;
    else if (l.length > 1) tit.textContent = l.length + ' pedidos novos';
    else tit.textContent = 'Pedido novo';
  });

  document.getElementById('vi').addEventListener('click', function () { window.alarme.vi(); });
  document.getElementById('abrir').addEventListener('click', function () { window.alarme.abrir(); });
})();
