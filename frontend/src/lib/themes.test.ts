import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME, THEME_STORAGE_KEY, loadTheme, persistTheme, resolveTheme } from './themes';

describe('theme helpers', () => {
  it('falls back to the default theme for unknown values', () => {
    expect(resolveTheme('unknown')).toBe(DEFAULT_THEME);
    expect(resolveTheme(null)).toBe(DEFAULT_THEME);
  });

  it('loads and persists theme values through storage', () => {
    const storage = {
      getItem: vi.fn().mockReturnValue('paper'),
      setItem: vi.fn(),
    };

    expect(loadTheme(storage)).toBe('paper');
    persistTheme('streaming', storage);
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'streaming');
  });
});
