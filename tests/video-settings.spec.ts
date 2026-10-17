import { expect, it } from 'vitest'
import { applyVideoSettings } from '../src/video-settings.ts'

it('applies Director scene timing without replacing reference tracks or sampling', () => {
  const graph = {
    '1': { class_type: 'LTXDirector', inputs: { timeline_data: 'existing references', local_prompts: 'saved' } as Record<string, unknown> },
    '2': { class_type: 'EmptyLTXVLatentVideo', inputs: { length: 121 } },
    '3': { class_type: 'LTXVEmptyLatentAudio', inputs: {} },
    '4': { class_type: 'CreateVideo', inputs: {} },
    '5': { class_type: 'ManualSigmas', inputs: { sigmas: 'saved schedule' } },
  }
  applyVideoSettings(graph, { durationSeconds: 4, frameRate: 24, segments: [{ seconds: 1, prompt: 'wide lake' }, { seconds: 3, prompt: 'camera approaches' }] }, 30)
  expect(graph['1'].inputs).toMatchObject({ timeline_data: 'existing references', local_prompts: 'wide lake|camera approaches', segment_lengths: '24,72', duration_frames: 96 })
  expect(graph['2'].inputs.length).toBe(97)
  expect(graph['3'].inputs).toEqual({ frames_number: 97, frame_rate: 24 })
  expect(graph['4'].inputs).toEqual({ fps: 24 })
  expect(graph['5'].inputs.sigmas).toBe('saved schedule')
  expect(() => { applyVideoSettings(graph, { durationSeconds: 31, frameRate: 24 }, 30) }).toThrow('at most 30')
  expect(() => {
    applyVideoSettings(graph, { durationSeconds: 4, frameRate: 24, segments: [{ seconds: 2, prompt: 'lake' }] }, 30)
  }).toThrow('total')
  expect(() => { applyVideoSettings({}, { durationSeconds: 4, frameRate: 24 }, 30) }).toThrow('does not expose')
})
