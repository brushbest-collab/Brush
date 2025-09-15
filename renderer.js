// renderer.js
(async () => {
  const $root = document.querySelector('#model-root');
  const $status = document.querySelector('#status');
  const $pickBtn = document.querySelector('#pickBtn');

  function render(state) {
    $root.textContent = state.modelRoot || '--';
    $status.textContent = state.bootstrap
      ? 'Python bootstrap found.'
      : 'Python bootstrap not found（請確認安裝包是否完整）';
  }

  render(await window.api.getState());

  window.api.onStateUpdate((s) => render(s));

  $pickBtn.addEventListener('click', async () => {
    const ret = await window.api.pickModelRoot();
    if (ret?.ok) {
      render(await window.api.getState());
    }
  });
})();
