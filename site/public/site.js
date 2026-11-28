// thoughtdesk.org: the download buttons, the version and star count, and the
// header's hairline once the page scrolls.

// The system this computer runs, as the Worker's /download tells them apart
// (src/index.ts: systemOf). An iPad says it's a Mac, but has a touch screen.
const ua = navigator.userAgent;
const system = /iPhone|iPad|Android|CrOS/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  ? null
  : /Macintosh|Mac OS X/.test(ua) ? 'mac' : /Linux/.test(ua) ? 'linux' : 'windows';

// This system's button stands out, and the other two step back.
if (system) for (const el of document.querySelectorAll('[data-system]')) el.classList.toggle('secondary', el.dataset.system !== system);
// On Linux, the .deb is there for Ubuntu and Debian.
if (system === 'linux') for (const el of document.querySelectorAll('[data-deb]')) el.hidden = false;
// A phone or a tablet: there's no app for it.
if (!system) for (const el of document.querySelectorAll('[data-os-note]')) el.hidden = false;

// The latest version, from the Worker.
fetch('/api/release')
  .then((res) => (res.ok ? res.json() : null))
  .then((release) => {
    if (!release) return;
    for (const el of document.querySelectorAll('[data-version]')) el.textContent = `Version ${release.version} · free`;
  })
  .catch(() => {});

// The repository's stars on GitHub, from the Worker (it asks GitHub every 10
// minutes): beside the top bar's GitHub link, and under the download buttons.
fetch('/api/stars')
  .then((res) => (res.ok ? res.json() : null))
  .then((repo) => {
    if (typeof repo?.stars !== 'number') return;
    const count = repo.stars < 1000 ? String(repo.stars) : `${(repo.stars / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    for (const el of document.querySelectorAll('[data-star-count]')) el.textContent = count;
    for (const el of document.querySelectorAll('[data-stars], [data-stars-line]')) el.hidden = false;
  })
  .catch(() => {});

const nav = document.querySelector('.nav');
const onScroll = () => nav?.classList.toggle('scrolled', scrollY > 4);
addEventListener('scroll', onScroll, { passive: true });
onScroll();
