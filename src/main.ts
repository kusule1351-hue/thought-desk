import { mount } from 'svelte';
import './app.css';
import './lib/prefs.svelte';
import './lib/zoom.svelte';
import './lib/updates.svelte';
import App from './App.svelte';
import { isMac, skipsOffscreen } from './lib/platform';

// macOS draws the window's buttons over the top-left corner (app.css: --traffic-lights).
if (isMac) document.documentElement.classList.add('mac');

// Long pages draw only what's on screen, where the engine can be trusted with it (app.css).
if (skipsOffscreen) document.documentElement.classList.add('skip-offscreen');

// In a plain browser (UI development without the Rust side), fake the backend.
if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  await import('./dev-mock');
}

export default mount(App, { target: document.getElementById('app')! });
