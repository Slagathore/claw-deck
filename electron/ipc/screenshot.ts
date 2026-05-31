import { ipcMain } from 'electron';
import type { DesktopCapturer, Screen } from 'electron';

export function registerScreenshotHandlers(desktopCapturer: DesktopCapturer, screen: Screen) {
  ipcMain.handle('screenshot:sources', async () => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 }
    });
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
      display_id: s.display_id
    }));
  });

  ipcMain.handle('screenshot:capture', async (_e, sourceId?: string) => {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
    });
    const src = sourceId ? sources.find(s => s.id === sourceId) : sources[0];
    if (!src) return { error: 'no source' };
    const png = src.thumbnail.toPNG();
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, name: src.name };
  });
  // Region capture is done in the renderer: full-screen capture (above) + the
  // RegionSelect overlay crops client-side. No separate main-process handler needed.
}
