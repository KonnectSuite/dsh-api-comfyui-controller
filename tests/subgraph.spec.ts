/**
 * Subgraph expansion: the mapping from an instance's promoted slots to the interior links
 * they stand for, and the ways that mapping can silently lose a connection — a bypassed
 * instance entering the graph as active, and an externally supplied input whose interior
 * link starts at the definition's boundary.
 */
import { describe, expect, it } from 'vitest'
import { expandSubgraphs, type GraphNode, type SubgraphDefinition } from '../src/subgraph.ts'

/** A node with every field the parser would have filled. */
function node(overrides: Partial<GraphNode> & Pick<GraphNode, 'id' | 'type'>): GraphNode {
  return { mode: 0, inputs: [], outputs: [], widgets_values: [], ...overrides }
}

/** A definition with two promoted values, one promoted output, and a two-node chain. */
function definition(overrides: Partial<SubgraphDefinition> = {}): SubgraphDefinition {
  return {
    id: 'sub-1',
    inputs: [
      { name: 'text', type: 'STRING', linkIds: [11] },
      { name: 'seed', type: 'INT', linkIds: [12] },
    ],
    outputs: [{ name: 'OUT', type: 'LATENT', linkIds: [13] }],
    nodes: [
      node({ id: 1, type: 'PrimitiveString', inputs: [{ name: 'value', link: 11 }], outputs: [{ name: 'STRING', type: 'STRING' }] }),
      node({ id: 2, type: 'PrimitiveInt', inputs: [{ name: 'value', link: 12 }], outputs: [{ name: 'INT', type: 'INT' }], widgets_values: [0] }),
      node({ id: 3, type: 'CLIPTextEncode', inputs: [{ name: 'text', link: 14 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets_values: [''] }),
      node({ id: 4, type: 'KSampler', inputs: [{ name: 'positive', link: 15 }], outputs: [{ name: 'LATENT', type: 'LATENT' }] }),
    ],
    links: [
      { id: 11, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0 },
      { id: 12, origin_id: -10, origin_slot: 1, target_id: 2, target_slot: 0 },
      { id: 14, origin_id: 1, origin_slot: 0, target_id: 3, target_slot: 0 },
      { id: 15, origin_id: 3, origin_slot: 0, target_id: 4, target_slot: 0 },
      { id: 13, origin_id: 4, origin_slot: 0, target_id: -20, target_slot: 0 },
    ],
    ...overrides,
  }
}

/** An instance of that definition, optionally bypassed, fed by an outer node and writing out. */
function instance(mode = 0): GraphNode {
  return node({
    id: 50, type: 'sub-1', mode,
    inputs: [{ name: 'text', link: 100 }, { name: 'seed', link: null }],
    outputs: [{ name: 'OUT', type: 'LATENT' }],
    widgets_values: ['baked text', 7],
  })
}

const OUTER_NODES: GraphNode[] = [
  node({ id: 9, type: 'PrimitiveStringMultiline', outputs: [{ name: 'STRING', type: 'STRING' }], widgets_values: ['outer text'] }),
  node({ id: 60, type: 'SaveImage', inputs: [{ name: 'images', link: 101 }] }),
]
const OUTER_LINKS = [[100, 9, 0, 50, 0], [101, 50, 0, 60, 0]]

describe('expandSubgraphs', () => {
  it('replaces an instance with the nodes and links it contains', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance()], OUTER_LINKS, [definition()])

    expect(result.unresolved).toEqual([])
    expect(result.nodes.some(expanded => expanded.id === 50)).toBe(false)
    expect(result.nodes.map(expanded => expanded.type)).toEqual([
      'PrimitiveStringMultiline', 'SaveImage', 'PrimitiveString', 'PrimitiveInt', 'CLIPTextEncode', 'KSampler',
    ])
    // Interior ids continue past every id the document already used, 60 included.
    expect(result.nodes.filter(expanded => expanded.id > 60).map(expanded => expanded.id)).toEqual([61, 62, 63, 64])
  })

  it('applies a promoted value to the boundary primitive that carries it inward', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance()], OUTER_LINKS, [definition()])

    const primitive = result.nodes.find(expanded => expanded.type === 'PrimitiveInt')
    expect(primitive?.widgetsValues[0]).toBe(7)
    // Its inward link started at the boundary, so it is dropped rather than left dangling.
    expect(primitive?.inputs.find(input => input.name === 'value')?.link).toBe(null)
  })

  it('connects an externally supplied input to the node that consumes it', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance()], OUTER_LINKS, [definition()])

    // The outer primitive feeds the promoted text slot, so the interior consumer must be
    // wired to it: this is the path an outside image or prompt arrives through.
    const consumer = result.nodes.find(expanded => expanded.type === 'PrimitiveString')
    const link = result.links.find(candidate => candidate[0] === consumer?.inputs[0]?.link)
    expect(link?.[1]).toBe(9)
  })

  it('re-points a promoted input whose interior link already exists', () => {
    const existing: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [{ name: 'text', type: 'STRING', linkIds: [14] }],
      outputs: [],
      nodes: [
        node({ id: 1, type: 'PrimitiveString', outputs: [{ name: 'STRING', type: 'STRING' }] }),
        node({ id: 3, type: 'CLIPTextEncode', inputs: [{ name: 'text', link: 14 }] }),
      ],
      links: [{ id: 14, origin_id: 1, origin_slot: 0, target_id: 3, target_slot: 0 }],
    }
    const wired = node({
      id: 50, type: 'sub-1', inputs: [{ name: 'text', link: 100 }],
    })
    const result = expandSubgraphs([OUTER_NODES[0] as GraphNode, wired], [[100, 9, 0, 50, 0]], [existing])

    const consumer = result.nodes.find(expanded => expanded.type === 'CLIPTextEncode')
    const link = result.links.find(candidate => candidate[0] === consumer?.inputs[0]?.link)
    expect(link?.[1]).toBe(9)
    // The interior link is re-pointed rather than duplicated.
    expect(result.links).toHaveLength(1)
  })

  it('re-points a link leaving an instance at the interior node that produced it', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance()], OUTER_LINKS, [definition()])

    const outgoing = result.links.find(candidate => candidate[0] === 101)
    expect(result.nodes.find(expanded => expanded.id === outgoing?.[1])?.type).toBe('KSampler')
    expect(outgoing?.[3]).toBe(60)
  })

  it('carries a bypassed instance\'s mode into the interior it expands to', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance(4)], OUTER_LINKS, [definition()])

    // A bypassed branch that entered the graph as active would compete for the values a
    // caller assigns by position, which is how a prompt can land on the wrong encoder.
    const interior = result.nodes.filter(expanded => ['PrimitiveString', 'PrimitiveInt', 'CLIPTextEncode', 'KSampler'].includes(expanded.type))
    expect(interior.map(expanded => expanded.mode)).toEqual([4, 4, 4, 4])
  })

  it('reports a definition it cannot expand and leaves the instance in place', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance()], OUTER_LINKS, [definition({ nodes: [] })])

    expect(result.unresolved).toEqual(['sub-1'])
    expect(result.nodes.some(expanded => expanded.id === 50 && expanded.type === 'sub-1')).toBe(true)
  })

  it('keeps an instance whose class names no definition', () => {
    const unknown = node({ id: 70, type: 'NotASubgraph', inputs: [{ name: 'model', link: 102 }] })
    const result = expandSubgraphs([...OUTER_NODES, unknown], [[102, 9, 0, 70, 0]], [])

    expect(result.unresolved).toEqual([])
    expect(result.nodes.find(expanded => expanded.id === 70)?.type).toBe('NotASubgraph')
  })

  it('ignores a link that is not five numeric fields', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance()], [...OUTER_LINKS, [103, 'nine', 0, 60, 0]], [definition()])

    expect(result.links.some(link => link[0] === 103)).toBe(false)
  })

  it('passes over a slot that carries a connection rather than a value', () => {
    const mixed: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [{ name: 'image', type: 'IMAGE', linkIds: [] }, { name: 'seed', type: 'INT', linkIds: [12] }],
      outputs: [],
      nodes: [node({ id: 2, type: 'PrimitiveInt', inputs: [{ name: 'value', link: 12 }], widgets_values: [0] })],
      links: [{ id: 12, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0 }],
    }
    const wired = node({ id: 50, type: 'sub-1', widgets_values: [5] })

    // The connection slot consumes no value, so the single value belongs to the seed slot.
    const primitive = expandSubgraphs([wired], [], [mixed]).nodes.find(expanded => expanded.type === 'PrimitiveInt')
    expect(primitive?.widgetsValues[0]).toBe(5)
  })

  it('leaves a value slot alone when the instance supplies no value for it', () => {
    const wired = node({ id: 50, type: 'sub-1' })

    const primitive = expandSubgraphs([wired], [], [definition()]).nodes.find(expanded => expanded.type === 'PrimitiveInt')
    expect(primitive?.widgetsValues[0]).toBe(0)
  })

  it('leaves a value slot alone when it names no interior link', () => {
    const dangling: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [{ name: 'seed', type: 'INT', linkIds: [99] }],
      outputs: [],
      nodes: [node({ id: 2, type: 'PrimitiveInt', widgets_values: [0] })],
      links: [],
    }
    const wired = node({ id: 50, type: 'sub-1', widgets_values: [5] })

    const primitive = expandSubgraphs([wired], [], [dangling]).nodes.find(expanded => expanded.type === 'PrimitiveInt')
    expect(primitive?.widgetsValues[0]).toBe(0)
  })

  it('leaves an output slot alone when it names no interior link or no producer', () => {
    const undocumented: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [],
      outputs: [{ name: 'OUT', type: 'LATENT', linkIds: [] }, { name: 'ALSO', type: 'LATENT', linkIds: [99] }],
      nodes: [node({ id: 5, type: 'KSampler' })],
      links: [],
    }
    const wired = node({ id: 50, type: 'sub-1', outputs: [{ name: 'OUT', type: 'LATENT' }] })

    expect(expandSubgraphs([wired], [[101, 50, 0, 60, 0]], [undocumented]).links).toEqual([])
  })

  it('leaves an input alone when the outside link it names is absent', () => {
    const wired = node({ id: 50, type: 'sub-1', inputs: [{ name: 'text', link: 999 }] })

    // The instance names an outside link the document does not contain.
    const result = expandSubgraphs([wired], [], [definition()])
    expect(result.links.some(link => link[1] === 9)).toBe(false)
  })

  it('leaves an input alone when the definition does not promote its name', () => {
    const wired = node({ id: 50, type: 'sub-1', inputs: [{ name: 'width', link: 100 }] })

    const result = expandSubgraphs([OUTER_NODES[0] as GraphNode, wired], [[100, 9, 0, 50, 0]], [definition()])
    expect(result.links.some(link => link[1] === 9)).toBe(false)
  })

  it('leaves an externally supplied input alone when its slot names no existing link', () => {
    const stale: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [{ name: 'text', type: 'STRING', linkIds: [99] }],
      outputs: [],
      nodes: [node({ id: 1, type: 'PrimitiveString' })],
      links: [],
    }
    const wired = node({ id: 50, type: 'sub-1', inputs: [{ name: 'text', link: 100 }] })

    const result = expandSubgraphs([OUTER_NODES[0] as GraphNode, wired], [[100, 9, 0, 50, 0]], [stale])
    expect(result.links.some(link => link[1] === 9)).toBe(false)
  })

  it('leaves an externally supplied input alone when its slot feeds a boundary node', () => {
    const boundary: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [{ name: 'text', type: 'STRING', linkIds: [11] }],
      outputs: [],
      nodes: [node({ id: 1, type: 'PrimitiveString' })],
      links: [{ id: 11, origin_id: -10, origin_slot: 0, target_id: -20, target_slot: 0 }],
    }
    const wired = node({ id: 50, type: 'sub-1', inputs: [{ name: 'text', link: 100 }] })

    const result = expandSubgraphs([OUTER_NODES[0] as GraphNode, wired], [[100, 9, 0, 50, 0]], [boundary])
    expect(result.links.some(link => link[1] === 9)).toBe(false)
  })

  it('leaves an interior input unlinked when its link id is not in the definition', () => {
    const stray: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [],
      outputs: [],
      nodes: [node({ id: 1, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 404 }] })],
      links: [],
    }
    const wired = node({ id: 50, type: 'sub-1' })

    expect(expandSubgraphs([wired], [], [stray]).nodes[0]?.inputs[0]?.link).toBe(null)
  })

  it('connects an externally supplied input even when the node declares no such slot', () => {
    const shallow: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [{ name: 'text', type: 'STRING', linkIds: [11] }],
      outputs: [],
      nodes: [node({ id: 1, type: 'PrimitiveString' })],
      links: [{ id: 11, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 3 }],
    }
    const wired = node({ id: 50, type: 'sub-1', inputs: [{ name: 'text', link: 100 }] })

    const result = expandSubgraphs([OUTER_NODES[0] as GraphNode, wired], [[100, 9, 0, 50, 0]], [shallow])
    // The link is created, but the target declares no input at the slot it names.
    expect(result.links.some(link => link[1] === 9)).toBe(true)
    expect(result.nodes.find(expanded => expanded.type === 'PrimitiveString')?.inputs).toEqual([])
  })

  it('ignores an outer link whose id is not a number', () => {
    const result = expandSubgraphs([...OUTER_NODES, instance()], [...OUTER_LINKS, ['x', 9, 0, 60, 0]], [definition()])

    expect(result.links.every(link => typeof link[0] === 'number')).toBe(true)
  })

  it('leaves an unconnected interior input unlinked', () => {
    const sparse: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [],
      outputs: [],
      nodes: [node({ id: 1, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: null }] })],
      links: [],
    }
    const wired = node({ id: 50, type: 'sub-1' })

    expect(expandSubgraphs([wired], [], [sparse]).nodes[0]?.inputs[0]?.link).toBe(null)
  })

  it('unlinks an input whose interior link ends at a boundary with no node', () => {
    const toBoundary: SubgraphDefinition = {
      id: 'sub-1',
      inputs: [],
      outputs: [],
      nodes: [
        node({ id: 1, type: 'PrimitiveString', outputs: [{ name: 'STRING', type: 'STRING' }] }),
        node({ id: 3, type: 'CLIPTextEncode', inputs: [{ name: 'text', link: 40 }] }),
      ],
      links: [{ id: 40, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0 }],
    }
    const wired = node({ id: 50, type: 'sub-1' })

    const result = expandSubgraphs([wired], [], [toBoundary])
    // The link has nowhere to land, so the input that named it is unlinked, not left dangling.
    expect(result.links.every(link => link[0] !== 40)).toBe(true)
    expect(result.nodes.find(expanded => expanded.type === 'CLIPTextEncode')?.inputs[0]?.link).toBe(null)
  })

  it('drops a link from an instance on a slot the definition does not expose', () => {
    const wired = node({ id: 50, type: 'sub-1', outputs: [{ name: 'OUT', type: 'LATENT' }] })

    // Slot 3 is not one the definition exposes, so there is no interior node to re-point
    // the link at and the instance it starts from is not a node in the flat graph.
    const result = expandSubgraphs([wired], [[101, 50, 3, 60, 0]], [definition()])
    expect(result.links.some(link => link[0] === 101)).toBe(false)
  })
})
