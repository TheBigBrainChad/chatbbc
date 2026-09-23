import { describe, expect, it, vi } from 'vitest';
import {
  createGlassBackingHandshake,
  detectGlassSupport,
  windowGlassOptions,
  type GlassCommandRunner,
  type GlassSupport
} from '../src/main/window-glass.js';

const atmospheric: GlassSupport = {
  mode: 'atmospheric',
  transparent: false,
  diagnostic: null
};

const supported: GlassSupport = {
  mode: 'hyprland-blur',
  transparent: true,
  diagnostic: null
};

describe('window glass detection', () => {
  it('observes the one bounded Hyprland blur option and enables glass only after a positive result', async () => {
    const run = vi.fn<GlassCommandRunner>(async () => '{"option":"decoration:blur:enabled","int":1}');

    await expect(detectGlassSupport({
      platform: 'linux',
      env: { HYPRLAND_INSTANCE_SIGNATURE: 'owned' },
      run
    })).resolves.toEqual(supported);
    expect(run).toHaveBeenCalledWith(
      'hyprctl',
      ['getoption', 'decoration:blur:enabled', '-j'],
      expect.objectContaining({ timeout: 1_000, maxBuffer: 16 * 1_024 })
    );
  });

  it('accepts the boolean blur field emitted by current Hyprland', async () => {
    await expect(detectGlassSupport({
      platform: 'linux',
      env: { HYPRLAND_INSTANCE_SIGNATURE: 'owned' },
      run: async () => '{"option":"decoration:blur:enabled","bool":true,"set":true}'
    })).resolves.toEqual(supported);
  });

  it.each([
    ['disabled', '{"int":0}'],
    ['disabled boolean', '{"bool":false}'],
    ['malformed', 'not-json']
  ])('uses atmospheric fallback for a %s compositor result', async (_name, stdout) => {
    const result = await detectGlassSupport({
      platform: 'linux',
      env: { HYPRLAND_INSTANCE_SIGNATURE: 'owned' },
      run: async () => stdout
    });

    expect(result).toMatchObject({ mode: 'atmospheric', transparent: false });
    expect(result.diagnostic).toBeTruthy();
  });

  it('uses atmospheric fallback when the bounded compositor query times out', async () => {
    const result = await detectGlassSupport({
      platform: 'linux',
      env: { HYPRLAND_INSTANCE_SIGNATURE: 'owned' },
      run: async () => { throw Object.assign(new Error('timed out'), { killed: true }); }
    });

    expect(result).toMatchObject({ mode: 'atmospheric', transparent: false });
    expect(result.diagnostic).toContain('could not confirm');
  });

  it('does not invoke Hyprland outside an explicitly identified Linux session', async () => {
    const run = vi.fn<GlassCommandRunner>();

    for (const request of [
      { platform: 'darwin' as const, env: { HYPRLAND_INSTANCE_SIGNATURE: 'owned' } },
      { platform: 'win32' as const, env: { HYPRLAND_INSTANCE_SIGNATURE: 'owned' } },
      { platform: 'linux' as const, env: {} }
    ]) {
      await expect(detectGlassSupport({ ...request, run })).resolves.toMatchObject(atmospheric);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe('BrowserWindow glass projection', () => {
  it('uses transparent Linux constructor options only for explicit supported glass', () => {
    expect(windowGlassOptions('linux', { HYPRLAND_INSTANCE_SIGNATURE: 'owned' }, supported)).toEqual({
      transparent: true,
      backgroundColor: '#00000000'
    });
    expect(windowGlassOptions('linux', { HYPRLAND_INSTANCE_SIGNATURE: 'owned' }, atmospheric)).toEqual({});
  });

  it.each(['win32', 'darwin'] as const)('keeps legacy %s constructor behavior', platform => {
    const options = windowGlassOptions(platform, { HYPRLAND_INSTANCE_SIGNATURE: 'owned' }, supported);
    expect(options.transparent).toBeUndefined();
    expect(options.backgroundColor).toBeUndefined();
  });
});

describe('native backing handshake', () => {
  it('keeps a readable backing through first load and every reload until appearance paint completes', () => {
    const colors: string[] = [];
    const handshake = createGlassBackingHandshake({ setBackgroundColor: color => colors.push(color) }, supported, '#181818');

    const firstGeneration = handshake.generation();
    expect(colors).toEqual(['#181818']);
    expect(handshake.appearancePainted(firstGeneration)).toBe(true);
    expect(colors).toEqual(['#181818']);
    handshake.didFinishLoad();
    expect(colors).toEqual(['#181818', '#00000000']);

    const reloadGeneration = handshake.loading('#f4f4f5');
    expect(reloadGeneration).toBeGreaterThan(firstGeneration);
    expect(colors.at(-1)).toBe('#f4f4f5');
    handshake.didFinishLoad();
    expect(colors.at(-1)).toBe('#f4f4f5');
    expect(handshake.appearancePainted(reloadGeneration)).toBe(true);
    expect(colors.at(-1)).toBe('#00000000');
  });

  it('rejects a delayed old-document appearance acknowledgement after reload starts', () => {
    const colors: string[] = [];
    const handshake = createGlassBackingHandshake({ setBackgroundColor: color => colors.push(color) }, supported, '#181818');
    const oldGeneration = handshake.loading();
    handshake.didFinishLoad();

    const newGeneration = handshake.loading('#f4f4f5');
    expect(handshake.appearancePainted(oldGeneration)).toBe(false);
    handshake.didFinishLoad();
    expect(colors.at(-1)).toBe('#f4f4f5');
    expect(handshake.appearancePainted(oldGeneration)).toBe(false);
    expect(colors.at(-1)).toBe('#f4f4f5');

    expect(handshake.appearancePainted(newGeneration)).toBe(true);
    expect(colors.at(-1)).toBe('#00000000');
  });

  it('never clears the native backing in atmospheric mode', () => {
    const colors: string[] = [];
    const handshake = createGlassBackingHandshake({ setBackgroundColor: color => colors.push(color) }, atmospheric, '#181818');

    const generation = handshake.generation();
    handshake.didFinishLoad();
    handshake.appearancePainted(generation);
    handshake.loading('#f4f4f5');
    expect(colors).toEqual(['#181818', '#f4f4f5']);
  });
});
