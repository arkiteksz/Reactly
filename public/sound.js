// Kodla üretilen ses efektleri (ses dosyası gerekmez).
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem('muted') === '1';

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, type = 'square', vol = 0.07, slideTo = null) {
    const t0 = ctx.currentTime + start;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  const sounds = {
    click:  () => tone(660, 0, 0.06, 'square', 0.05),
    select: () => { tone(520, 0, 0.05, 'triangle', 0.09); tone(780, 0.045, 0.07, 'triangle', 0.09); },
    play:   () => tone(320, 0, 0.16, 'sawtooth', 0.05, 110),
    reveal: () => { tone(300, 0, 0.25, 'triangle', 0.1, 900); tone(900, 0.25, 0.14, 'square', 0.06); },
    vote:   i => {
      const f = [523, 659, 784][i] || 523;
      tone(f, 0, 0.1, 'triangle', 0.11);
      tone(f * 1.5, 0.07, 0.12, 'triangle', 0.09);
    },
    round:  () => { tone(523, 0, 0.12, 'square', 0.06); tone(784, 0.12, 0.22, 'square', 0.06); },
    tick:   () => tone(1000, 0, 0.04, 'square', 0.05),
    score:  () => { tone(988, 0, 0.07, 'square', 0.06); tone(1319, 0.07, 0.2, 'square', 0.06); },
    start:  () => [392, 523, 659, 784].forEach((f, k) => tone(f, k * 0.09, 0.14, 'square', 0.06)),
    win:    () => {
      [523, 659, 784, 1047].forEach((f, k) => tone(f, k * 0.13, 0.18, 'square', 0.06));
      [523, 659, 784].forEach(f => tone(f, 0.55, 0.6, 'triangle', 0.07));
    },
    join:   () => { tone(440, 0, 0.08, 'triangle', 0.09); tone(660, 0.08, 0.12, 'triangle', 0.09); },
    error:  () => tone(190, 0, 0.2, 'sawtooth', 0.06, 120),
    chat:   () => tone(880, 0, 0.05, 'sine', 0.05)
  };

  function play(name, arg) {
    if (muted || !sounds[name]) return;
    if (!ensure()) return;
    try { sounds[name](arg); } catch (e) { /* ses çalınamadıysa oyun devam eder */ }
  }

  function toggle() {
    muted = !muted;
    localStorage.setItem('muted', muted ? '1' : '0');
    return muted;
  }

  // Butonlara tıklayınca ses çal (kart ve emoji butonlarının kendi sesi var)
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.id === 'muteBtn') return;
    if (b.classList.contains('card-btn')) play('select');
    else if (b.classList.contains('emoji-btn')) play('vote', Number(b.dataset.i) || 0);
    else play('click');
  });

  return { play, toggle, isMuted: () => muted };
})();
