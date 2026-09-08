import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Tauri's onCloseRequested destroys the window only when we do not prevent it. */
export function installNativeCloseGuard(
  isDirty: () => boolean,
  confirmDiscard: () => boolean,
  onError: (message: string) => void,
): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void getCurrentWindow().onCloseRequested((event) => {
    if (isDirty() && !confirmDiscard()) event.preventDefault();
  }).then((stop) => {
    if (disposed) stop(); else unlisten = stop;
  }).catch((reason: unknown) => {
    if (!disposed) onError(`原生窗口关闭保护未能启用，请先保存修改再关闭。${reason instanceof Error ? reason.message : String(reason)}`);
  });
  return () => { disposed = true; unlisten?.(); };
}
