/** Apply scene timing without replacing model, sampling or reference connections.
 * @param graph - Converted ComfyUI graph.
 * @param settings - Validated at this request entry.
 * @param maxSeconds - Deployment ceiling for a single scene.
 */
export function applyVideoSettings(graph, settings, maxSeconds) {
    const { durationSeconds, frameRate, segments } = settings;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxSeconds)
        throw new Error(`Scene duration must be greater than zero and at most ${maxSeconds} seconds`);
    if (!Number.isSafeInteger(frameRate) || frameRate < 1 || frameRate > 60)
        throw new Error('Frame rate must be a whole number from 1 to 60');
    const nodes = Object.values(graph);
    const director = nodes.find(node => node.class_type === 'LTXDirector');
    const latents = nodes.filter(node => ['EmptyLTXVLatentVideo', 'LTXVImgToVideo', 'WanImageToVideo', 'Wan22ImageToVideoLatent'].includes(node.class_type));
    if (latents.length === 0)
        throw new Error('This workflow does not expose supported scene timing');
    if (segments !== undefined) {
        if (director === undefined)
            throw new Error('Timed prompt segments require an LTX Director workflow');
        if (segments.length < 1 || segments.length > 32 || segments.some(segment => !Number.isFinite(segment.seconds) || segment.seconds <= 0 || !segment.prompt.trim() || segment.prompt.length > 8000 || segment.prompt.includes('|')))
            throw new Error('Provide 1 to 32 positive-length segments with nonempty prompts without pipe characters');
        if (Math.abs(segments.reduce((sum, segment) => sum + segment.seconds, 0) - durationSeconds) > 0.001)
            throw new Error('Segment durations must total the scene duration');
    }
    const frames = Math.ceil(durationSeconds * frameRate / 8) * 8 + 1;
    for (const latent of latents)
        latent.inputs.length = frames;
    for (const node of nodes) {
        if (node.class_type === 'LTXVEmptyLatentAudio')
            Object.assign(node.inputs, { frames_number: frames, frame_rate: frameRate });
        if (node.class_type === 'LTXVConditioning')
            node.inputs.frame_rate = frameRate;
        if (node.class_type === 'CreateVideo')
            node.inputs.fps = frameRate;
    }
    if (director !== undefined) {
        Object.assign(director.inputs, {
            start_second: 0, end_second: durationSeconds, duration_seconds: durationSeconds,
            start_frame: 0, end_frame: frames - 1, duration_frames: frames - 1, frame_rate: frameRate,
        });
        if (segments !== undefined) {
            director.inputs.local_prompts = segments.map(segment => segment.prompt).join('|');
            const lengths = segments.map(segment => Math.round(segment.seconds * frameRate));
            const last = lengths.length - 1;
            lengths[last] = (lengths[last] ?? 0) + frames - 1 - lengths.reduce((sum, length) => sum + length, 0);
            if (lengths.some(length => length < 1))
                throw new Error('Every prompt segment must cover at least one frame');
            director.inputs.segment_lengths = lengths.join(',');
        }
    }
}
//# sourceMappingURL=video-settings.js.map