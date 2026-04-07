export type ThemeId = 'odyssey' | 'osx' | 'streaming' | 'paper';

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  note: string;
}

export const DEFAULT_THEME: ThemeId = 'odyssey';
export const THEME_STORAGE_KEY = 'kg-demo-theme';

export const THEMES: ThemeDefinition[] = [
  { id: 'odyssey', label: 'Odyssey', note: 'Stark sci-fi command deck' },
  { id: 'osx', label: 'OSX Glass', note: 'Soft translucent desktop panels' },
  { id: 'streaming', label: 'Streaming Ops', note: 'Cinematic dark mission wall' },
  { id: 'paper', label: 'Paper Ledger', note: 'Light editorial workspace' },
];

export function resolveTheme(value: string | null | undefined): ThemeId {
  return THEMES.some((theme) => theme.id === value) ? (value as ThemeId) : DEFAULT_THEME;
}

export function loadTheme(storage: Pick<Storage, 'getItem'> | null | undefined): ThemeId {
  return resolveTheme(storage?.getItem(THEME_STORAGE_KEY));
}

export function persistTheme(theme: ThemeId, storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
}
