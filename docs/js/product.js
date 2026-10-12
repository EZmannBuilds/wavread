(() => {
  'use strict';
  document.querySelectorAll('[data-band-share]').forEach(el => el.style.setProperty('--value', `${Number(el.dataset.bandShare)}%`));
  document.querySelectorAll('[data-part-active]').forEach(el => el.style.width = `${Number(el.dataset.partActive)}%`);
  const audio = document.querySelector('#audio');
  const play = document.querySelector('#play');
  const seek = document.querySelector('#seek');
  const status = document.querySelector('#audio-status');
  const mini = document.querySelector('#mini-player');
  const miniToggle = document.querySelector('#mini-toggle');
  const heroPlay = document.querySelector('#hero-play');
  const tabs = [...document.querySelectorAll('[data-tab]')];
  let sample, roomVisible = true, pendingSeek = null;
  const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
  const duration = () => Number.isFinite(audio.duration) ? audio.duration : 200;
  function state() {
    const playing = !audio.paused && !audio.ended;
    play.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} What the Light Remembers`);
    play.querySelector('.play-icon').toggleAttribute('hidden', playing);
    play.querySelector('.pause-icon').toggleAttribute('hidden', !playing);
    miniToggle.textContent = playing ? 'Pause' : 'Play';
    heroPlay.innerHTML = `${playing ? 'Pause the example' : 'Play the example'} <span aria-hidden="true">${playing ? 'Ⅱ' : '▷'}</span>`;
    miniToggle.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} sample audio`);
    mini.hidden = roomVisible || audio.currentTime === 0;
  }
  async function start(at) {
    if (typeof at === 'number') {
      pendingSeek = Math.min(at, duration());
      if (audio.readyState >= 1) { audio.currentTime = pendingSeek; pendingSeek = null; }
    }
    status.textContent = 'Loading the song…';
    try { await audio.play(); status.textContent = 'Playing What the Light Remembers.'; }
    catch (_) { status.textContent = 'Audio could not play. Press play to try again.'; }
    state();
  }
  function toggle() { if (audio.paused) start(); else audio.pause(); }
  play.addEventListener('click', toggle); miniToggle.addEventListener('click', toggle); heroPlay.addEventListener('click', toggle);
  audio.addEventListener('loadedmetadata', () => {
    seek.max = duration();
    if (pendingSeek !== null) { audio.currentTime = pendingSeek; pendingSeek = null; }
    updatePosition();
  });
  function updatePosition() {
    const t = audio.currentTime;
    seek.value = t;
    seek.setAttribute('aria-valuetext', `${clock(t)} of ${clock(duration())}`);
    document.querySelector('#clock').innerHTML = `${clock(t)} <span>/ ${clock(duration())}</span>`;
    document.querySelector('.playhead').style.left = `${Math.min(100, t / duration() * 100)}%`;
    document.querySelectorAll('[data-chart-playhead]').forEach(line => {
      const x = 30 + t / duration() * 570;
      line.setAttribute('x1', x); line.setAttribute('x2', x);
    });
  }
  seek.addEventListener('input', () => {
    const t = Number(seek.value);
    if (audio.readyState >= 1) { audio.currentTime = t; updatePosition(); }
    else { pendingSeek = t; audio.load(); status.textContent = `Loading audio at ${clock(t)}…`; }
  });
  audio.addEventListener('timeupdate', updatePosition);
  audio.addEventListener('play', state);
  audio.addEventListener('pause', () => { state(); status.textContent = `Paused at ${clock(audio.currentTime)}.`; });
  audio.addEventListener('ended', () => { state(); status.textContent = 'Song finished. Press play to listen again.'; });
  audio.addEventListener('waiting', () => { status.textContent = 'Buffering the song…'; });
  audio.addEventListener('playing', () => { status.textContent = 'Playing What the Light Remembers.'; });
  audio.addEventListener('error', () => { status.textContent = 'The audio could not load. Check the connection and press play to retry.'; state(); });
  document.querySelectorAll('[data-listen]').forEach(button => button.addEventListener('click', () => start(Number(button.dataset.listen))));
  new IntersectionObserver(entries => { roomVisible = entries[0].isIntersecting; state(); }, {threshold:0}).observe(document.querySelector('#experience'));
  const readings = {
    loudness: ['Room for the music to breathe.', 'Peaks sit <strong>18.5 dB</strong> above the average level. The track keeps a wide space between quiet detail and strong transients.'],
    frequency: ['A balance with weight and warmth.', '<strong>34.9%</strong> of measured energy sits in the low mids. That describes the balance; your listening decides whether the warmth serves this arrangement.'],
    stereo: ['Follow the space around the sound.', 'The whole-track left/right correlation is <strong>0.875</strong>. The timeline reveals how that relationship changes. Listen in mono before making a judgement.'],
    stems: ['See the parts behind the picture.', '<strong>16 supplied stems</strong> reveal level and activity across the song. Memory Piano is active for <strong>95.6%</strong> of the track.']
  };
  function selectTab(key, focus = false) {
    tabs.forEach(button => { const on = button.dataset.tab === key; button.setAttribute('aria-selected', on); button.tabIndex = on ? 0 : -1; document.querySelector(`#panel-${button.dataset.tab}`).hidden = !on; if (on && focus) button.focus(); });
    const [heading, copy] = readings[key];
    document.querySelector('#reading-copy').innerHTML = `<h3>${heading}</h3><p>${copy}</p>`;
  }
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); selectTab(tabs[next].dataset.tab, true); }
    });
  });
  document.querySelector('[data-show-stems]').addEventListener('click', () => selectTab('stems'));
  function svg(content, label, height = 140, width = 600) { return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}">${content}</svg>`; }
  function lineChart(values, low, high, label, ticks, color) {
    const y = v => 6 + (high - Math.max(low, Math.min(high, v))) / (high - low) * 124;
    let path = '', drawing = false;
    values.forEach((v, i) => { if (!Number.isFinite(v)) { drawing = false; return; } const x = 30 + i / Math.max(1, values.length - 1) * 570; path += `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y(v).toFixed(1)} `; drawing = true; });
    const grid = ticks.map(v => `<line x1="30" x2="600" y1="${y(v)}" y2="${y(v)}" stroke="#3b4d66" stroke-dasharray="2 5"/><text x="0" y="${y(v) + 3}" fill="#b4c3d7" font-size="8" font-family="Inter,sans-serif">${v}</text>`).join('');
    return svg(`${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="1.7" vector-effect="non-scaling-stroke"/><line data-chart-playhead x1="30" x2="30" y1="2" y2="133" stroke="#eaf2ff" stroke-opacity=".6"/>`, label);
  }
  function draw() {
    document.querySelector('#loudness-chart').innerHTML = lineChart(sample.timeline.short_term_lufs, -45, -15, 'Short-term loudness from the original WAV across 200 seconds. The final fade drops toward silence.', [-15,-25,-35,-45], '#91d5d5');
    document.querySelector('#stereo-chart').innerHTML = lineChart(sample.timeline.correlation, -1, 1, 'Left/right correlation across 200 seconds, on a scale from minus one to one.', [-1,0,1], '#92b7ff');
    const waves = sample.timeline.waveform;
    let bars = '';
    for (let i = 0; i < 160; i++) { const slice = waves.slice(Math.floor(i * waves.length / 160), Math.floor((i + 1) * waves.length / 160)); const h = Math.max(2, Math.max(...slice) * 40); bars += `<rect x="${i * 4}" y="${22-h/2}" width="2" height="${h}" rx="1" fill="#789fbc"/>`; }
    document.querySelector('#waveform').innerHTML = svg(bars, 'Waveform of the sample mix', 44, 640);
    const sectionChart = document.querySelector('#section-chart');
    sample.sections.forEach(section => {
      const button = document.createElement('button');
      button.style.height = `${Math.max(8, (section.lufs + 45) / 30 * 100)}%`;
      button.setAttribute('aria-label', `Listen to section ${section.n} at ${section.start}, ${section.lufs} LUFS`);
      button.title = `${section.start}–${section.end}: ${section.lufs} LUFS`;
      const value = document.createElement('span'); value.textContent = section.lufs; button.append(value);
      button.addEventListener('click', () => start(section.start_sec)); sectionChart.append(button);
    });
    document.querySelectorAll('[data-stem]').forEach(el => {
      const values = sample.stems[Number(el.dataset.stem)].series;
      const bars = values.map((v,i) => { const h = v == null ? 0 : Math.max(0, Math.min(19,(v+70)/55*19)); return `<rect x="${i / values.length * 600}" y="${20-h}" width="${600 / values.length}" height="${h}" fill="#80aaaF"/>`; }).join('');
      el.innerHTML = svg(bars, 'Measured part level across the song', 20);
    });
  }
  fetch('assets/sample.json').then(response => { if (!response.ok) throw new Error('sample unavailable'); return response.json(); }).then(data => { sample = data; draw(); }).catch(() => {
    document.querySelectorAll('.chart').forEach(el => { el.textContent = 'The saved chart could not load. Reload the page or download the sample reading below.'; });
    status.textContent = 'Charts could not load. The audio and sample reading remain available.';
  });
})();
