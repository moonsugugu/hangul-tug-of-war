// 벡터 QR을 확대하므로 크기를 바꿀 때 서버에 다시 요청하지 않습니다.
let preferredSize = 360;
export function openQrDialog({ src, roomId, url, note = '경기 중에도 입장할 수 있어요. 같은 기기·브라우저에서 다시 열면 기존 참가자로 돌아와요.' }) {
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'qr-popup';
  dialog.setAttribute('aria-label', '학생 입장 · 다시 접속 QR');
  dialog.innerHTML = `<button type="button" class="qr-popup-close" aria-label="QR 닫기">×</button>
    <h2>📱 학생 입장 · 다시 접속</h2><img class="qr-popup-image" alt="학생 입장 QR 코드" />
    <div class="qr-popup-size"><button type="button" aria-label="QR 축소">−</button>
    <label>QR 크기 <output></output><input type="range" aria-label="QR 크기" min="180" max="720" step="20" /></label>
    <button type="button" aria-label="QR 확대">+</button></div>
    <p class="qr-popup-code"></p><p class="qr-popup-note"></p><button type="button" class="qr-popup-copy">입장 링크 복사</button>`;
  const image = dialog.querySelector('img');
  const range = dialog.querySelector('input');
  const output = dialog.querySelector('output');
  const [smaller, bigger] = dialog.querySelectorAll('.qr-popup-size button');
  image.src = src;
  dialog.querySelector('.qr-popup-code').textContent = `방 코드 ${roomId}`;
  dialog.querySelector('.qr-popup-note').textContent = note;
  const resize = (size) => {
    preferredSize = Math.max(180, Math.min(720, Number(size)));
    range.value = String(preferredSize);
    output.value = `${preferredSize}px`;
    image.style.width = `${preferredSize}px`;
    dialog.style.width = `${preferredSize + 80}px`;
    smaller.disabled = preferredSize === 180;
    bigger.disabled = preferredSize === 720;
  };
  range.addEventListener('input', () => resize(range.value));
  smaller.addEventListener('click', () => resize(preferredSize - 60));
  bigger.addEventListener('click', () => resize(preferredSize + 60));
  dialog.querySelector('.qr-popup-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('.qr-popup-copy').addEventListener('click', async (event) => {
    try { await navigator.clipboard.writeText(url); event.target.textContent = '복사했어요!'; }
    catch { window.prompt('학생에게 보낼 입장 링크', url); }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus(); }, { once: true });
  resize(preferredSize);
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
