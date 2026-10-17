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
    readonly id: number;
    readonly type: string;
    /** 0 active; any other value bypassed or muted. */
    readonly mode: number;
    /** Declared connections, each naming the link that feeds it or null when unconnected. */
    readonly inputs: readonly {
        readonly name: string;
        readonly link: number | null;
    }[];
    readonly outputs: readonly {
        readonly name: string;
        readonly type: string;
    }[];
    /** Widget values in the order the node type declares them. */
    readonly widgets_values: readonly unknown[];
}
/** One promoted input or output of a subgraph definition. */
export interface SubgraphSlot {
    readonly name: string;
    readonly type: string;
    /** Interior links this slot stands for; empty when the slot stands for none. */
    readonly linkIds: readonly number[];
}
/** One link inside a subgraph definition. */
export interface SubgraphLink {
    readonly id: number;
    readonly origin_id: number;
    readonly origin_slot: number;
    readonly target_id: number;
    readonly target_slot: number;
}
/** A subgraph definition as the frontend document stores it. */
export interface SubgraphDefinition {
    readonly id: string;
    readonly inputs: readonly SubgraphSlot[];
    readonly outputs: readonly SubgraphSlot[];
    readonly nodes: readonly GraphNode[];
    readonly links: readonly SubgraphLink[];
}
/** A flat node, in outer-document terms. */
export interface FlatNode {
    id: number;
    type: string;
    mode: number;
    inputs: {
        name: string;
        link: number | null;
    }[];
    outputs: {
        name: string;
        type: string;
    }[];
    widgetsValues: readonly unknown[];
}
/** A flat link: `[id, originId, originSlot, targetId, targetSlot]`. */
export type FlatLink = readonly [number, number, number, number, number];
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
export declare function expandSubgraphs(nodes: readonly GraphNode[], links: readonly (readonly unknown[])[], definitions: readonly SubgraphDefinition[]): {
    nodes: FlatNode[];
    links: FlatLink[];
    unresolved: string[];
};
//# sourceMappingURL=subgraph.d.ts.map