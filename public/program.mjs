/** Broadcast-only composition. No controls or secrets enter the encoded scene. */
const token = new URLSearchParams(location.search).get('renderToken') || '';
const $ = id => document.getElementById(id);
const scene = $('broadcast');
let state = {}, lastSlide = '', lastAvatar = '', mouthValue = 0, targetMouth = 0, nextPoll = null, closed = false, frameRequest = null, mouthStartedAt = 0, lastStateAt = 0;
const supportedPoses = new Set(['greeting','listen','ponder','explain','happy','wink','rest','thinking','cool']);
// Keep each gesture readable; the director still selects the overall mood.
const poseSequences = {
  explain: [['explain',8000],['ponder',3000],['explain',7000],['listen',3000],['explain',7000],['wink',2000]],
  happy: [['happy',5000],['listen',3000],['explain',5000],['wink',2000]],
  greeting: [['greeting',7000],['rest',3000],['greeting',6000],['wink',2000]],
  thinking: [['thinking',6000],['ponder',4000],['thinking',6000],['listen',4000]],
  rest: [['rest',10000],['listen',4000],['rest',8000],['ponder',3000]],
};
let avatarMood = '', avatarSince = 0, desiredAvatar = '';
const poseImages = new Map();

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
function preparePose(pose) {
  if (poseImages.has(pose)) return poseImages.get(pose);
  const active = $('avatar-image'), existing = active.getAttribute('href') || '';
  // Reuse an already displayed pose during a hot update.
  if (existing.includes(`/internal/avatar/${pose}.png`)) {
    const entry = {element:active,ready:true}; poseImages.set(pose,entry); return entry;
  }
  const element = active.cloneNode(false);
  element.removeAttribute('id'); element.removeAttribute('href');
  element.style.visibility = 'hidden'; element.dataset.avatarPose = pose;
  const entry = {element,ready:false}; poseImages.set(pose,entry);
  element.addEventListener('load', () => { entry.ready = true; if (!closed) renderAvatar(performance.now()); }, {once:true});
  // Leave the previous pose visible if an asset fails to load.
  element.addEventListener('error', () => { entry.failed = true; }, {once:true});
  active.parentNode.insertBefore(element, $('avatar-mouth'));
  image(element, internal(`/internal/avatar/${pose}.png`));
  return entry;
}
function renderAvatar(now) {
  const sequence = poseSequences[avatarMood] || [[avatarMood || 'rest',10000]];
  let elapsed = Math.max(0,now-avatarSince) % sequence.reduce((sum,item) => sum + item[1],0);
  desiredAvatar = sequence.at(-1)[0];
  for (const [pose,duration] of sequence) { if (elapsed < duration) { desiredAvatar = pose; break; } elapsed -= duration; }
  if (desiredAvatar === lastAvatar) return;
  const entry = preparePose(desiredAvatar);
  if (!entry.ready) return;
  const active = $('avatar-image');
  if (active !== entry.element) { active.style.visibility = 'hidden'; active.removeAttribute('id'); entry.element.id = 'avatar-image'; }
  entry.element.style.visibility = 'visible'; entry.element.dataset.avatarPose = desiredAvatar;
  $('avatar-mouth').hidden = ['thinking','cool'].includes(desiredAvatar);
  lastAvatar = desiredAvatar;
}

function update(value) {
  state = value;
  const config = value.scene || value.config?.scene || {};
  const layout = config.layout || {};
  scene.className = `mode-${['avatar','slides','green'].includes(layout.mode) ? layout.mode : 'standard'}`;
  const campaign = layout.template === 'campaign' && !!config.backgroundUrl && scene.classList.contains('mode-standard');
  scene.classList.toggle('template-campaign', campaign);
  $('scene-background-image').hidden = !campaign;
  image($('scene-background-image'), campaign ? assetUrl(config.backgroundUrl) : '');
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
  const speaking = !!value.speaking;
  const base = supportedPoses.has(value.avatarState) ? value.avatarState : speaking ? 'explain' : 'rest';
  const mood = speaking || base === 'thinking' ? base : 'rest';
  if (mood !== avatarMood) {
    avatarMood = mood; avatarSince = performance.now();
    for (const [pose] of poseSequences[mood] || [[mood,10000]]) preparePose(pose);
  }
  renderAvatar(performance.now());
  if (speaking && !targetMouth) mouthStartedAt = performance.now();
  targetMouth = speaking ? 1 : 0;
  lastStateAt = performance.now();
  const caption = typeof value.caption === 'string' ? value.caption : value.caption?.text || '';
  $('captions').hidden = layout.showCaptions === false || !caption;
  $('caption-text').textContent = caption;
  const sale = value.sale || {};
  const remaining = sale.expiresAt ? Math.max(0, Math.ceil((sale.expiresAt - Date.now()) / 1000)) : Math.max(0, Number(sale.remainingSeconds || 0));
  $('sale-overlay').hidden = !(sale.active && remaining > 0 && sale.qrUrl);
  scene.classList.toggle('sale-active', !$('sale-overlay').hidden);
  if (!$('sale-overlay').hidden) {
    image($('sale-qr'), assetUrl(sale.qrUrl));
    $('sale-countdown').textContent = `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`;
  }
}
function animate(now) {
  renderAvatar(now);
  // Clear talking motion with a restrained opening, independent of audio volume.
  const talking = targetMouth && now - lastStateAt < 500;
  mouthValue = talking ? Math.pow((1 - Math.cos((now - mouthStartedAt) * Math.PI * 2 / 360)) / 2, 1.1) : 0;
  $('mouth-open').setAttribute('transform', `scale(${.88 + mouthValue * .08} ${mouthValue * .72})`);
  $('mouth-open').setAttribute('opacity', mouthValue > .045 ? '1' : '0');
  $('mouth-closed').setAttribute('opacity', mouthValue > .045 ? '0' : '1');
  const sale = state.sale || {};
  if (sale.active && sale.expiresAt) {
    const remaining = Math.max(0, Math.ceil((sale.expiresAt - Date.now()) / 1000));
    $('sale-countdown').textContent = `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`;
    if (!remaining) { $('sale-overlay').hidden = true; scene.classList.remove('sale-active'); }
  }
  if (!closed) frameRequest = requestAnimationFrame(animate);
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
function slideError() { $('slide-image').removeAttribute('src'); }
function communityError() { $('community-qr').removeAttribute('src'); }
$('slide-image').addEventListener('error', slideError);
$('community-qr').addEventListener('error', communityError);
addEventListener('resize', resize);
function dispose() {
  closed = true; clearTimeout(nextPoll); cancelAnimationFrame(frameRequest);
  removeEventListener('resize', resize); removeEventListener('pagehide', dispose);
  $('slide-image').removeEventListener('error', slideError);
  $('community-qr').removeEventListener('error', communityError);
  for (const {element} of poseImages.values()) if (element.id !== 'avatar-image') element.remove();
  poseImages.clear();
}
addEventListener('pagehide', dispose);
resize();frameRequest = requestAnimationFrame(animate);poll();
window.__studioProgram = {update,dispose,ready:true,version:'avatar-motion-1'};
