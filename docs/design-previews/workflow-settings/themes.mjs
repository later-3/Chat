// Preview-only theme definitions; no Agent, Project or runtime configuration.
export const themes = [
  { id: 'paper', name: '纸白', caption: '温暖、安静的工作台', mode: 'light', material: 'paper', reference: 'CLASSIC' },
  { id: 'glacier', name: '冰川', caption: '光线穿过磨砂玻璃', mode: 'light', material: 'glass', reference: 'iOS INSPIRED' },
  { id: 'peach', name: '桃雾', caption: '柔和彩调，清晰层次', mode: 'light', material: 'tonal', reference: 'MATERIAL INSPIRED' },
  { id: 'instagram', name: 'Instagram', caption: '黑白之间，一抹色彩', mode: 'light', material: 'social', reference: 'INSTAGRAM INSPIRED' },
  { id: 'graphite', name: '石墨', caption: '沉静、精细的深灰', mode: 'dark', material: 'paper', reference: 'CLASSIC' },
  { id: 'obsidian', name: '黑曜', caption: '夜色里的通透层次', mode: 'dark', material: 'glass', reference: 'iOS INSPIRED' },
  { id: 'dracula', name: 'Dracula', caption: '熟悉的紫灰与霓彩', mode: 'dark', material: 'editor', reference: 'DRACULA INSPIRED' },
];
export const themeById = id => themes.find(theme => theme.id === id) ?? themes[0];
export const appearanceStorageKey = 'chat:workflow-design-preview:appearance:v2';
export function readAppearance() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(appearanceStorageKey) || localStorage.getItem('chat:workflow-design-preview:appearance:v1') || '{}') ?? {}; } catch { /* Preview stays usable without storage. */ }
  const requested = new URL(location.href).searchParams.get('skin');
  const legacy = saved.skin === 'glass' ? (saved.theme === 'dark' ? 'obsidian' : 'glacier') : (saved.theme === 'dark' ? 'graphite' : 'paper');
  const aliases = { glass: saved.theme === 'dark' ? 'obsidian' : 'glacier', classic: saved.theme === 'dark' ? 'graphite' : 'paper' };
  const preset = themes.some(theme => theme.id === requested) ? requested : (Object.hasOwn(aliases, requested) ? aliases[requested] : undefined) ?? (themes.some(theme => theme.id === saved.preset) ? saved.preset : legacy);
  return { preset, motion: saved.motion !== false, opaque: saved.opaque === true, background: saved.background !== false };
}
export function applyAppearance(value) {
  const theme = themeById(value.preset), root = document.documentElement;
  root.dataset.preset = theme.id;
  root.dataset.skin = theme.material;
  root.dataset.motion = value.motion ? 'on' : 'off';
  root.dataset.transparency = value.opaque ? 'reduced' : 'normal';
  root.dataset.background = value.background ? 'on' : 'off';
  root.classList.toggle('dark', theme.mode === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.mode === 'dark' ? '#24232b' : '#faf9f7');
}
