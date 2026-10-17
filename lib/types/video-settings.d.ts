/** Timing overrides for supported video graphs. */
import type { ComfyVideoSettings } from './types.ts';
/** Apply scene timing without replacing model, sampling or reference connections.
 * @param graph - Converted ComfyUI graph.
 * @param settings - Validated at this request entry.
 * @param maxSeconds - Deployment ceiling for a single scene.
 */
export declare function applyVideoSettings(graph: Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
}>, settings: ComfyVideoSettings, maxSeconds: number): void;
//# sourceMappingURL=video-settings.d.ts.map