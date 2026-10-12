(() => {
  'use strict';
  const audio = document.querySelector('#case-audio');
  if (!audio) return;
  const status = document.querySelector('#case-status');
  const buttons = [...document.querySelectorAll('[data-case-version]')];
  const versions = {first: 'Unmeasured', v03: 'Measured to advice'};
  let selected = 'first', pendingTime = null, generation = 0;
  // Capturing play covers native controls and the full-song custom transport.
  document.addEventListener('play', event => {
    if (!event.target.matches('audio')) return;
    document.querySelectorAll('audio').forEach(other => {
      if (other !== event.target && !other.paused) other.pause();
    });
  }, true);
  audio.addEventListener('loadedmetadata', () => {
    if (pendingTime !== null) {
      audio.currentTime = Math.min(pendingTime, Number.isFinite(audio.duration) ? audio.duration : 32);
      pendingTime = null;
    }
  });
  audio.addEventListener('playing', () => { status.textContent = `Playing ${versions[selected]}. Switch versions to compare this moment.`; });
  audio.addEventListener('pause', () => { status.textContent = `${versions[selected]} paused. Press play to continue.`; });
  audio.addEventListener('ended', () => { status.textContent = `${versions[selected]} finished. Switch versions or play again.`; });
  audio.addEventListener('error', () => { status.textContent = 'The excerpt could not load. Check your connection and press play to retry.'; });
  buttons.forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.caseVersion;
    if (!(key in versions) || key === selected) return;
    const resume = !audio.paused && !audio.ended;
    pendingTime = audio.ended ? 0 : (pendingTime ?? audio.currentTime);
    const request = ++generation;
    selected = key;
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    audio.setAttribute('aria-label', `${versions[key]} mix comparison excerpt`);
    audio.src = `assets/case-study/${key}-matched.mp3`;
    audio.load();
    status.textContent = `${versions[key]} selected. ${resume ? 'Loading the same moment…' : 'Press play to compare.'}`;
    if (resume) audio.play().catch(() => {
      if (request === generation) status.textContent = `${versions[key]} is ready. Press play to continue.`;
    });
  }));
})();
