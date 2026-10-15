/**
 * The workflow — ofplang v0 (workflow spec).
 *
 * Only the subset this viewer reads: types, atomic and composite processes,
 * node invocations — plain and structured (§17-§20) — and their bindings.
 * `$import`, generics, inline scripts and unrecognised node kinds are
 * reported by the feature gate (design.md D10).
 */

export interface PortDecl {
  readonly type: string;
  readonly phase: string;
}

/** A binding source, e.g. `"Heat.out"` or `"inputs.sample"`. */
export interface Binding {
  readonly from: string;
}

/** workflow spec §14. */
export interface ObjectsSection {
  readonly map?: Readonly<Record<string, string>>;
  readonly consume?: readonly string[];
  readonly create?: readonly string[];
  readonly transform?: unknown;
}

export interface AtomicProcess {
  readonly kind: "atomic";
  readonly inputs: Readonly<Record<string, PortDecl>>;
  readonly outputs: Readonly<Record<string, PortDecl>>;
  readonly objects?: ObjectsSection;
  /**
   * workflow spec §15, as written. `object_identity_map` is the only marker
   * v0 defines; where `objects` is absent it implies a `map` (`objectsOf`).
   */
  readonly behavior?: readonly string[];
}

/** A node's `kind` (workflow spec 2.3); `invoke` is a plain, non-structured node. */
export type NodeKind = "invoke" | "map" | "fold" | "do_while" | "branch";

/** An output mode of a structured node (workflow spec §18.1, §19.1, §20.1). */
export type OutputMode = "carry" | "collect" | "drop" | "common";

export interface NodeInvocation {
  readonly id: string;
  readonly kind: NodeKind;
  /** The process invoked; for a `branch`, which names one per arm, the empty string. */
  readonly process: string;
  /** Object-bearing bindings. */
  readonly state: Readonly<Record<string, Binding>>;
  /** Pure Data bindings — the node's `bind` section (workflow spec §11). */
  readonly data: Readonly<Record<string, Binding>>;
  /**
   * Pure Data given as a literal rather than taken from somewhere — a `bind`
   * entry with `value` instead of `from` (workflow spec 2.6.6, 11.1.1). It has
   * no source, so no connection is drawn to it.
   */
  readonly literals: Readonly<Record<string, unknown>>;
  /** `map` / `fold`: each element to one invocation (workflow spec §17, §18). */
  readonly each: Readonly<Record<string, Binding>>;
  /** `fold` / `do_while`: threaded from one invocation to the next (§18, §19). */
  readonly carry: Readonly<Record<string, Binding>>;
  /** `branch`: given to the arm that runs (§20). */
  readonly args: Readonly<Record<string, Binding>>;
  /** `branch`: the process of each arm. An omitted `else` is the identity arm (§20). */
  readonly arms?: { readonly then: string; readonly else?: string };
  /**
   * `branch`: where its condition comes from, or the literal it is (§20);
   * `do_while`: the output of its target the loop goes on while true (§19).
   */
  readonly condition?: { readonly from?: string; readonly value?: unknown; readonly output?: string };
  /** `do_while`: `max_iterations`, as written — a literal or where it comes from (§19). */
  readonly maxIterations?: { readonly from?: string; readonly value?: unknown };
  /** `fold` / `do_while` / `branch`: the explicit `outputs` section, if written. */
  readonly outputs?: Readonly<Record<string, OutputMode>>;
}

export interface CompositeProcess {
  readonly kind: "composite";
  readonly inputs: Readonly<Record<string, PortDecl>>;
  readonly outputs: Readonly<Record<string, PortDecl>>;
  readonly body: {
    readonly nodes: readonly NodeInvocation[];
    readonly returns: Readonly<Record<string, Binding>>;
    /** Outputs returned as a literal (2.6.6): a constant, with nothing inside feeding it. */
    readonly returnLiterals: Readonly<Record<string, unknown>>;
  };
}

export type ProcessDef = AtomicProcess | CompositeProcess;

export interface Workflow {
  readonly specVersion: string;
  readonly types: Readonly<Record<string, { readonly domain: "object" | "data" }>>;
  readonly processes: Readonly<Record<string, ProcessDef>>;
  readonly entry: string;
}
