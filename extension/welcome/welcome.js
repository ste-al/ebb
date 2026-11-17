// Welcome page: pick a pace and open the side panel.

const send = (msg) => chrome.runtime.sendMessage(msg);

async function init() {
  // sidePanel.open needs the click's user gesture, so nothing may be awaited inside the handler.
  let windowId = null;
  chrome.windows.getCurrent().then((win) => {
    windowId = win.id;
  });

  document.getElementById('open').addEventListener('click', () => {
    if (windowId == null) return;
    chrome.sidePanel.open({ windowId }).catch(() => {
      document.querySelector('.hint').textContent = 'Click the Ebb icon in the toolbar to open it.';
    });
  });

  for (const input of document.querySelectorAll('input[name="pace"]')) {
    input.addEventListener('change', () => send({ type: 'panel:settings', patch: { pace: input.value } }).catch(() => {}));
  }

  try {
    const settings = await send({ type: 'panel:settings', patch: {} });
    const current = document.querySelector(`input[name="pace"][value="${settings?.pace}"]`);
    if (current) current.checked = true;
  } catch {
    // The service worker is still starting; the default stays selected.
  }
}

init();
