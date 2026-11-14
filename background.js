// Enable CP - background service worker
// 1) shows the ON/OFF badge   2) runs "Snip to copy" for pictures (screenshot -> OCR)

// ---------- badge ----------
function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#16a34a' : '#6b7280' });
}
function init() {
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => updateBadge(enabled));
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) updateBadge(changes.enabled.newValue);
});
init();

// ---------- offscreen document (where the OCR engine runs) ----------
let creating = null;
async function ensureOffscreen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx && ctx.length) return;
  } catch (_) {}
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run text recognition (OCR) on a screenshot area, fully on this computer'
    }).catch((e) => { if (!/single offscreen/i.test(String(e))) throw e; })
      .finally(() => { creating = null; });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // the user started a snip: load the OCR engine now, while they drag the box
  if (msg && msg.type === 'ecp-warmup') {
    sendResponse({ ok: true });
    (async () => {
      try { await ensureOffscreen(); chrome.runtime.sendMessage({ type: 'ecp-warm' }).catch(() => {}); } catch (_) {}
    })();
    return;
  }
  // the box was drawn over a picture: take a screenshot and read it
  if (!msg || msg.type !== 'ecp-capture' || !sender.tab) return;
  (async () => {
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    } catch (e) {
      sendResponse({ ok: false, error: 'CAPTURE_FAILED: ' + ((e && e.message) || e) });
      return;
    }
    sendResponse({ ok: true });                 // the page can now show the typing dots

    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    let result;
    try {
      await ensureOffscreen();
      result = await chrome.runtime.sendMessage({ type: 'ecp-ocr', dataUrl, rect: msg.rect, vw: msg.vw });
    } catch (e) {
      result = { error: String((e && e.message) || e) };
    }
    clearInterval(keepAlive);
    try {
      await chrome.tabs.sendMessage(sender.tab.id, Object.assign({ type: 'ecp-snip-result' }, result || { error: 'No result' }), { frameId: 0 });
    } catch (_) {}
  })();
  return true;
});

// ---------- keyboard shortcut (Alt+Shift+S) ----------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'snip') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'ecp-start-snip' }, { frameId: 0 }).catch(() => {});
});
