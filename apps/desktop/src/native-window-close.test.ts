/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installNativeCloseGuard } from './native-window-close.js';
const native = vi.hoisted(() => ({ isTauri: false, onCloseRequested: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: native.onCloseRequested }) }));
afterEach(() => { native.isTauri = false; vi.resetAllMocks(); });

describe('actual native close interception', () => {
  it('uses the current dirty getter for every native event and prevents rejected closes', async () => {
    native.isTauri = true;
    let handler!: (event: { preventDefault(): void }) => void;
    const unlisten = vi.fn();
    native.onCloseRequested.mockImplementation(async (next) => { handler = next; return unlisten; });
    let dirty = false; const confirm = vi.fn(() => false); const onError = vi.fn();
    const dispose = installNativeCloseGuard(() => dirty, confirm, onError);
    await Promise.resolve();
    const preventDefault = vi.fn(); handler({ preventDefault });
    expect(confirm).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
    dirty = true; handler({ preventDefault });
    expect(confirm).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce();
    confirm.mockReturnValue(true); handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    dispose(); expect(unlisten).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
  });
  it('unsubscribes a late native registration after unmount and surfaces registration failure', async () => {
    native.isTauri = true;
    let finish!: (unlisten: () => void) => void;
    native.onCloseRequested.mockReturnValue(new Promise<() => void>((resolve) => { finish = resolve; }));
    const dispose = installNativeCloseGuard(() => false, () => false, () => {});
    dispose(); const unlisten = vi.fn(); finish(unlisten); await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();
    const errors = vi.fn(); native.onCloseRequested.mockRejectedValue(new Error('ACL denied'));
    installNativeCloseGuard(() => true, () => false, errors);
    await Promise.resolve(); await Promise.resolve();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('ACL denied'));
  });
  it('does not invoke native window APIs in a browser preview', () => {
    installNativeCloseGuard(() => true, () => false, () => {})();
    expect(native.onCloseRequested).not.toHaveBeenCalled();
  });
});
