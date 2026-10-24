/** Broadcast-only composition. No controls or secrets enter the encoded scene. */
const token = new URLSearchParams(location.search).get('renderToken') || '';
const $ = id => document.getElementById(id);
const scene = $('broadcast');
let state = {}, lastSlide = '', lastAvatar = '', mouthValue = 0, targetMouth = 0, nextPoll = null, closed = false;
const supportedPoses = new Set(['greeting','listen','ponder','explain','happy','wink','rest','thinking','cool']);
const encode = encodeURIComponent;
const internal = path => `${path}${path.includes('?') ? '&' : '?'}renderToken=${encode(token)}`;
function assetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value.startsWith('/assets/')) return internal(value.replace('/assets/', '/internal/assets/'));
  if (value.startsWith('/internal/')) return value.includes('renderToken=') ? value : internal(value);
  try { const url = new URL(value, location.href); return ['http:','https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function image(element, url) {
  const attribute = element.localName === 'image' ? 'href' : 'src';
  if (!url) { element.removeAttribute(attribute); return; }
  if (element.getAttribute(attribute) !== url) element.setAttribute(attribute, url);
}
function resize() { scene.style.setProperty('--scene-scale', String(Math.min(innerWidth / 1600, innerHeight / 900))); }
function update(value) {
  state = value;
  const config = value.scene || value.config?.scene || {};
  const layout = config.layout || {};
  scene.className = `mode-${['avatar','slides','green'].includes(layout.mode) ? layout.mode : 'standard'}`;
  if (/^#[\da-f]{6}$/i.test(config.background || '')) scene.style.setProperty('--scene-background', config.background);
  $('channel-title').textContent = config.title || '云端 AI 直播间';
  $('channel-subtitle').textContent = config.subtitle || 'AI 干货分享 · 一起创造更多可能';
  $('banner-title').textContent = config.subtitle || config.title || '与 AI 一起，让想法发生。';
  $('presenter-name').textContent = `嘉宾 · ${config.avatarName || '小云'}`;
  $('slide-footer-name').textContent = `${config.avatarName || '小云'}正在陪你一起探索`;
  $('community-label').textContent = config.communityLabel || '扫码加入用户交流群';
  $('presenter-panel').hidden = layout.showAvatar === false && layout.showCommunity === false;
  $('presenter-panel').classList.toggle('hide-avatar', layout.showAvatar === false);
  $('community-card').hidden = layout.showCommunity === false;
  image($('community-qr'), assetUrl(config.communityQrUrl));
  const slide = value.slide || {};
  $('presentation-title').textContent = slide.title || value.slideTitle || '持续分享 · 实时互动';
  $('presentation-position').textContent = slide.pageNumber ? `${slide.pageNumber} / ${slide.pageCount || '—'}` : '';
  const revision = String(value.slideRevision ?? slide.revision ?? '');
  const slideUrl = value.slideUrl ? assetUrl(value.slideUrl) : internal(`/internal/slide.jpg?rev=${encode(revision)}`);
  if (revision !== lastSlide || !$('slide-image').hasAttribute('src')) { image($('slide-image'), slideUrl); lastSlide = revision; }
  const pose = supportedPoses.has(value.avatarState) ? value.avatarState : value.speaking ? 'explain' : 'rest';
  if (pose !== lastAvatar) { image($('avatar-image'), internal(`/internal/avatar/${pose}.png`)); lastAvatar = pose; }
  $('avatar-mouth').hidden = ['thinking','cool'].includes(pose);
  const rms = Math.max(0, Math.min(1, Number(value.audio?.voiceRms ?? value.voiceRms ?? 0)));
  targetMouth = value.speaking ? Math.min(1, rms * 6) : 0;
  const caption = typeof value.caption === 'string' ? value.caption : value.caption?.text || '';
  $('captions').hidden = layout.showCaptions === false || !caption;
  $('caption-text').textContent = caption;
  const sale = value.sale || {};
  const remaining = sale.expiresAt ? Math.max(0, Math.ceil((sale.expiresAt - Date.now()) / 1000)) : Math.max(0, Number(sale.remainingSeconds || 0));
  $('sale-overlay').hidden = !(sale.active && remaining > 0 && sale.qrUrl);
  if (!$('sale-overlay').hidden) {
    image($('sale-qr'), assetUrl(sale.qrUrl));
    $('sale-countdown').textContent = `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`;
  }
}
function animate() {
  mouthValue += (targetMouth - mouthValue) * .55;
  $('mouth-open').setAttribute('transform', `scale(${.82 + mouthValue * .18} ${mouthValue * 1.25})`);
  $('mouth-open').setAttribute('opacity', mouthValue > .045 ? '1' : '0');
  $('mouth-closed').setAttribute('opacity', mouthValue > .045 ? '0' : '1');
  const sale = state.sale || {};
  if (sale.active && sale.expiresAt) {
    const remaining = Math.max(0, Math.ceil((sale.expiresAt - Date.now()) / 1000));
    $('sale-countdown').textContent = `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`;
    if (!remaining) $('sale-overlay').hidden = true;
  }
  if (!closed) requestAnimationFrame(animate);
}
async function poll() {
  try {
    const response = await fetch(internal('/internal/program'), {cache:'no-store'});
    if (response.ok) {
      const value = await response.json();
      update(value.state || value);
    }
  } catch { /* The last complete scene remains visible while the local server reconnects. */ }
  if (!closed) nextPoll = setTimeout(poll, 100);
}
$('slide-image').addEventListener('error', () => $('slide-image').removeAttribute('src'));
$('community-qr').addEventListener('error', () => $('community-qr').removeAttribute('src'));
addEventListener('resize', resize);
addEventListener('pagehide', () => { closed = true; clearTimeout(nextPoll); });
resize();requestAnimationFrame(animate);poll();
window.__studioProgram = {update,ready:true};
