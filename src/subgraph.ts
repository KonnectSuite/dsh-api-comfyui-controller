/**
 * Flatten ComfyUI subgraph instances into the nodes and links they contain.
 *
 * A frontend workflow may hold a node whose `type` is a subgraph UUID instead of a class
 * name, with the real graph in the document's `definitions.subgraphs`. Nothing that reads
 * a saved workflow by class name can use such a file, which is why a workflow that runs
 * perfectly well in ComfyUI can be unusable elsewhere.
 *
 * The definition states the mapping it needs: each promoted slot carries the ids of the
 * interior links it stands for, and the instance's slots are matched to those by name. A
 * slot the instance supplies a value for sets the interior primitive that feeds it; a slot
 * the instance receives a link for is wired to the outside source instead.
 *
 * Every field is required. The document parser validates the file and fills these before
 * calling, so a missing field here is a defect in that parser, not a case to absorb.
 */

/** One node of a workflow document, outer or interior. */
export interface GraphNode {
  readonly id: number
  readonly type: string
  /** 0 active; any other value bypassed or muted. */
  readonly mode: number
  /** Declared connections, each naming the link that feeds it or null when unconnected. */
  readonly inputs: readonly { readonly name: string; readonly link: number | null }[]
  readonly outputs: readonly { readonly name: string; readonly type: string }[]
  /** Widget values in the order the node type declares them. */
  readonly widgets_values: readonly unknown[]
}

/** One promoted input or output of a subgraph definition. */
export interface SubgraphSlot {
  readonly name: string
  readonly type: string
  /** Interior links this slot stands for; empty when the slot stands for none. */
  readonly linkIds: readonly number[]
}

/** One link inside a subgraph definition. */
export interface SubgraphLink {
  readonly id: number
  readonly origin_id: number
  readonly origin_slot: number
  readonly target_id: number
  readonly target_slot: number
}

/** A subgraph definition as the frontend document stores it. */
export interface SubgraphDefinition {
  readonly id: string
  readonly inputs: readonly SubgraphSlot[]
  readonly outputs: readonly SubgraphSlot[]
  readonly nodes: readonly GraphNode[]
  readonly links: readonly SubgraphLink[]
}

/** A flat node, in outer-document terms. */
export interface FlatNode {
  id: number
  type: string
  mode: number
  inputs: { name: string; link: number | null }[]
  outputs: { name: string; type: string }[]
  widgetsValues: readonly unknown[]
}

/** A flat link: `[id, originId, originSlot, targetId, targetSlot]`. */
export type FlatLink = readonly [number, number, number, number, number]

/** Slot types that hold a value on the node rather than a connection. */
const VALUE_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

/** Whether a slot type carries a widget value. */
function isValueType(type: string): boolean {
  return VALUE_TYPES.has(type.toUpperCase())
}

/**
 * Expand every subgraph instance into its definition's nodes and links.
 *
 * An instance whose definition declares no nodes is reported unresolved and left in place,
 * so a caller names the class it cannot expand rather than silently dropping part of a
 * graph. A link into an instance is consumed by the expansion; a link out of one is
 * re-pointed at the interior node that produces it.
 * @param nodes - Outer document nodes, in document order.
 * @param links - Outer document links, as `[id, originId, originSlot, targetId, targetSlot]`;
 * entries that are not five numbers are ignored.
 * @param definitions - The document's `definitions.subgraphs`.
 * @returns flat nodes and links, and the instance types that could not expand.
 */
export function expandSubgraphs(
  nodes: readonly GraphNode[],
  links: readonly (readonly unknown[])[],
  definitions: readonly SubgraphDefinition[],
): { nodes: FlatNode[]; links: FlatLink[]; unresolved: string[] } {
  const byId = new Map(definitions.map(definition => [definition.id, definition]))
  const instances = new Set(nodes.filter(node => byId.has(node.type)).map(node => node.id))
  const unresolved: string[] = []
  const flat: FlatNode[] = []
  const flatLinks: FlatLink[] = []

  // Ids continue past both the document's own and every definition's, so an expanded graph
  // never collides with the nodes it was expanded beside. A definition link id is also an
  // id in the document it came from, so those are re-mapped rather than reused.
  let nextNodeId = Math.max(0, ...nodes.map(node => node.id),
    ...definitions.flatMap(definition => definition.nodes.map(node => node.id))) + 1
  let nextLinkId = Math.max(0,
    ...links.flatMap(link => (typeof link[0] === 'number' ? [link[0]] : [])),
    ...definitions.flatMap(definition => definition.links.map(link => link.id))) + 1

  const flatLinkOf = (link: readonly unknown[]): FlatLink | undefined => (
    link.length >= 5 && link.slice(0, 5).every(value => typeof value === 'number')
      ? [link[0] as number, link[1] as number, link[2] as number, link[3] as number, link[4] as number]
      : undefined
  )

  for (const link of links) {
    const flatLink = flatLinkOf(link)
    if (flatLink === undefined) continue
    // A link into an instance is consumed by the expansion; one out of it is re-pointed at
    // the interior producer, so it must already be present when that happens.
    if (instances.has(flatLink[3])) continue
    flatLinks.push(flatLink)
  }

  for (const node of nodes) {
    const definition = byId.get(node.type)
    if (definition === undefined) {
      flat.push({
        id: node.id, type: node.type, mode: node.mode,
        inputs: node.inputs.map(input => ({ name: input.name, link: input.link })),
        outputs: node.outputs.map(output => ({ name: output.name, type: output.type })),
        widgetsValues: node.widgets_values,
      })
      continue
    }
    if (definition.nodes.length === 0) {
      unresolved.push(node.type)
      flat.push({ id: node.id, type: node.type, mode: node.mode, inputs: [], outputs: [], widgetsValues: [] })
      continue
    }

    const nodeIds = new Map<number, number>()
    const pushed = new Map<number, FlatNode>()
    const mappedLinks = definition.links.map(link => ({ link, id: nextLinkId++ }))
    const idsOfLinks = new Map(mappedLinks.map(({ link, id }) => [link.id, id]))
    for (const inner of definition.nodes) {
      const id = nextNodeId++
      nodeIds.set(inner.id, id)
      const expanded: FlatNode = {
        // A bypassed or muted instance contributes nothing, so its interior carries the
        // instance's own mode. Expanding it as active would enter a whole second branch,
        // which then competes for the values a caller assigns by position, such as the
        // prompt: that is how a prompt lands on the wrong encoder.
        id, type: inner.type, mode: node.mode === 0 ? inner.mode : node.mode,
        inputs: inner.inputs.map(input => ({
          name: input.name,
          link: typeof input.link === 'number' ? idsOfLinks.get(input.link) ?? null : null,
        })),
        outputs: inner.outputs.map(output => ({ name: output.name, type: output.type })),
        widgetsValues: inner.widgets_values,
      }
      pushed.set(inner.id, expanded)
      flat.push(expanded)
    }
    for (const { link, id } of mappedLinks) {
      const origin = nodeIds.get(link.origin_id)
      const target = nodeIds.get(link.target_id)
      // A link from the definition's boundary node has no interior node to start at.
      if (origin === undefined || target === undefined) continue
      flatLinks.push([id, origin, link.origin_slot, target, link.target_slot])
    }

    // A slot the instance receives a link for is fed from outside: the interior links it
    // stands for start at the outside source instead of at a boundary primitive. The
    // instance names the outside link; the definition names the interior links.
    for (const input of node.inputs) {
      if (input.link === null) continue
      const outer = links.map(flatLinkOf).find(link => link !== undefined && link[0] === input.link)
      const declared = definition.inputs.find(slot => slot.name === input.name)
      if (outer === undefined || declared === undefined) continue
      for (const interiorId of declared.linkIds) {
        const mapped = idsOfLinks.get(interiorId)
        if (mapped === undefined) continue
        const index = flatLinks.findIndex(link => link[0] === mapped)
        const existing = flatLinks[index]
        if (existing !== undefined) {
          flatLinks[index] = [mapped, outer[1], outer[2], existing[3], existing[4]]
          continue
        }
        // Dropped as a boundary link, so the input it fed has to be connected here or an
        // externally supplied image or text would be lost. The slot's interior link exists,
        // because its id resolved above, and its target is the node the slot feeds. A link
        // that is absent leaves this input unconnected rather than failing the expansion.
        const interior = definition.links.find(link => link.id === interiorId)
        if (interior === undefined) continue
        const targetNode = pushed.get(interior.target_id)
        // A boundary target is not a node, so there is no input to connect to.
        if (targetNode === undefined) continue
        nextLinkId += 1
        flatLinks.push([nextLinkId, outer[1], outer[2], targetNode.id, interior.target_slot])
        const slot = targetNode.inputs[interior.target_slot]
        if (slot !== undefined) slot.link = nextLinkId
      }
    }

    // A slot the instance supplies a value for sets the boundary primitive that feeds it.
    // The instance's values are positional over the definition's value-bearing slots, and a
    // slot that is also linked from outside keeps that connection and ignores the value.
    let valueIndex = 0
    for (const declared of definition.inputs) {
      if (!isValueType(declared.type)) continue
      const value = node.widgets_values[valueIndex]
      valueIndex += 1
      if (value === undefined) continue
      if (node.inputs.some(input => input.name === declared.name && input.link !== null)) continue
      const interior = definition.links.find(link => declared.linkIds.includes(link.id))
      const targetNode = interior === undefined ? undefined : pushed.get(interior.target_id)
      if (targetNode === undefined) continue
      targetNode.widgetsValues = [value, ...targetNode.widgetsValues.slice(1)]
    }

    // An output the instance exposes is fed by the interior node that produced it.
    for (const [slot, declared] of definition.outputs.entries()) {
      const interior = definition.links.find(link => declared.linkIds.includes(link.id))
      const producer = interior === undefined ? undefined : nodeIds.get(interior.origin_id)
      if (interior === undefined || producer === undefined) continue
      for (const [index, link] of flatLinks.entries()) {
        if (link[1] !== node.id || link[2] !== slot) continue
        flatLinks[index] = [link[0], producer, interior.origin_slot, link[3], link[4]]
      }
    }
  }

  // A link out of an instance whose output slot could not be resolved has nothing to start
  // at, and the instance itself is no longer a node in the flat graph.
  const resolved = flatLinks.filter(link => !instances.has(link[1]) && !instances.has(link[3]))

  // An interior link from the definition's boundary node has no node to start at, so it is
  // dropped and the promoted value stands in its place. Any other dropped link would leave
  // a reference nothing resolves, so the input is unlinked rather than left dangling.
  const present = new Set(resolved.map(link => link[0]))
  for (const node of flat) {
    for (const input of node.inputs) {
      if (input.link !== null && !present.has(input.link)) input.link = null
    }
  }

  return { nodes: flat, links: resolved, unresolved }
}
