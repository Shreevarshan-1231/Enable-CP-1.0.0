// Runs in the extension's isolated world (can use chrome.storage).
// Passes the ON/OFF switch to the page script through an attribute on <html>.
const root = document.documentElement;
const apply = (on) => root.setAttribute('data-ecp', on ? 'on' : 'off');

apply(true);                                               // default until storage answers
chrome.storage.local.get({ enabled: true }, ({ enabled }) => apply(enabled));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) apply(changes.enabled.newValue);
});
