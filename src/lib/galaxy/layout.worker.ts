/** Lays out a big galaxy (layout.ts) off the main thread, so the window keeps moving. */
import { layoutGalaxy, type GalaxyInput } from './layout';

const scope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };

self.onmessage = (e: MessageEvent<GalaxyInput>) => {
  const layout = layoutGalaxy(e.data);
  scope.postMessage(layout, [layout.pos.buffer, layout.cluster.buffer, layout.degree.buffer, layout.children.buffer, layout.mag.buffer, layout.links.buffer]);
};
