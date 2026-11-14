const $ = (id) => document.getElementById(id);
const shownAt = Date.now();

let state = { enabled: true };
function render() {
  const { enabled } = state;
  $('toggle').checked = enabled;
  $('status').textContent = enabled ? 'ON' : 'OFF';
  $('status').classList.toggle('off', !enabled);
  $('hint').textContent = enabled ? 'Copy, paste, shortcuts & right-click unlocked.' : 'Sites behave as normal. Reload the page for a full reset.';
}

// hide the spinner once the settings are loaded (kept for at least a moment so it is seen)
function ready() {
  const wait = Math.max(0, 350 - (Date.now() - shownAt));
  setTimeout(() => { $('loading').classList.add('done'); }, wait);
}

render();                                                  // show the defaults at once, then the saved settings
try {
  chrome.storage.local.get({ enabled: true }, (v) => { if (v) state = v; render(); ready(); });
} catch (e) { ready(); }
setTimeout(ready, 900);                                    // never leave the spinner on screen

$('toggle').addEventListener('change', () => {
  state.enabled = $('toggle').checked;
  chrome.storage.local.set({ enabled: state.enabled }, render);
});

// Snip to copy: start the drag-a-box tool on the current page
$('snipBtn').addEventListener('click', async () => {
  const note = $('snipNote');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'ecp-start-snip' }, { frameId: 0 });
    window.close();
  } catch (e) {
    note.textContent = 'Reload this page (Ctrl+R) first, then try again. It does not work on chrome:// pages.';
    note.classList.add('warn');
  }
});
