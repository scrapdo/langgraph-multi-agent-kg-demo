export type AppearanceMode = 'light' | 'dark';
export type EffectLayer = 'none' | 'hud';

export interface Appearance {
  mode: AppearanceMode;
  effects: EffectLayer;
}

const MODE_STORAGE_KEY = 'kg-demo-appearance-mode';
const EFFECTS_STORAGE_KEY = 'kg-demo-appearance-effects';
const LEGACY_THEME_KEY = 'kg-demo-theme';

export const DEFAULT_APPEARANCE: Appearance = { mode: 'dark', effects: 'none' };

function isMode(value: string | null | undefined): value is AppearanceMode {
  return value === 'light' || value === 'dark';
}

function isEffect(value: string | null | undefined): value is EffectLayer {
  return value === 'none' || value === 'hud';
}

function migrateLegacy(storage: Pick<Storage, 'getItem'>): Partial<Appearance> | null {
  const legacy = storage.getItem(LEGACY_THEME_KEY);
  if (!legacy) return null;
  // Old theme ids -> new (mode, effects)
  switch (legacy) {
    case 'paper':
      return { mode: 'light', effects: 'none' };
    case 'osx':
      return { mode: 'light', effects: 'hud' };
    case 'streaming':
      return { mode: 'dark', effects: 'none' };
    case 'odyssey':
      return { mode: 'dark', effects: 'hud' };
    default:
      return null;
  }
}

export function loadAppearance(storage: Pick<Storage, 'getItem'> | null | undefined): Appearance {
  if (!storage) return DEFAULT_APPEARANCE;
  const legacy = migrateLegacy(storage);
  const rawMode = storage.getItem(MODE_STORAGE_KEY);
  const rawEffects = storage.getItem(EFFECTS_STORAGE_KEY);
  const mode = isMode(rawMode) ? rawMode : legacy?.mode ?? DEFAULT_APPEARANCE.mode;
  const effects = isEffect(rawEffects) ? rawEffects : legacy?.effects ?? DEFAULT_APPEARANCE.effects;
  return { mode, effects };
}

export function persistAppearance(
  appearance: Appearance,
  storage: Pick<Storage, 'setItem'>,
): void {
  storage.setItem(MODE_STORAGE_KEY, appearance.mode);
  storage.setItem(EFFECTS_STORAGE_KEY, appearance.effects);
}

export function applyAppearance(appearance: Appearance, root: HTMLElement): void {
  root.dataset.theme = appearance.mode;
  if (appearance.effects === 'none') {
    delete root.dataset.effects;
  } else {
    root.dataset.effects = appearance.effects;
  }
}
