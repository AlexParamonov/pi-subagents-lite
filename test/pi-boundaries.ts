/**
 * pi-boundaries.ts — Test-only boundaries with the pi SDK type surface.
 *
 * 1. Fake assertion — test fakes are partial objects, but pi's classes
 *    (AgentSession) and pi's context interfaces (ExtensionCommandContext)
 *    carry private members and hundreds of required fields, so no structural
 *    fake can satisfy them. The `as*` helpers assert the real type at the
 *    single call boundary where a src function requires it, and intersect the
 *    result with the fake's own type so vi.fn() members stay callable at the
 *    call site. Each helper holds exactly one cast.
 *
 * 2. Private member view — pi-tui's SelectList keeps `items` and
 *    `selectedIndex` private. `selectListView` exposes exactly those two
 *    members so menu tests can assert selection state without reaching into
 *    the class.
 */

import type {
  AgentSession,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem, SelectList } from "@earendil-works/pi-tui";

/** Assert a fake session against the real AgentSession at a call boundary. */
export function asAgentSession<S extends object>(fake: S): AgentSession & S {
  return fake as AgentSession & S;
}

/** Assert a fake pi instance against the real ExtensionAPI at a call boundary. */
export function asExtensionAPI<S extends object>(fake: S): ExtensionAPI & S {
  return fake as ExtensionAPI & S;
}

/** Assert a fake context against the real ExtensionContext at a call boundary. */
export function asExtensionContext<S extends object>(fake: S): ExtensionContext & S {
  return fake as ExtensionContext & S;
}

/** Assert a partial command context against the real ExtensionCommandContext. */
export function asCommandContext<S extends object>(fake: S): ExtensionCommandContext & S {
  return fake as ExtensionCommandContext & S;
}

/** The two private SelectList members menu tests need to assert on. */
export interface SelectListView {
  readonly items: SelectItem[];
  readonly selectedIndex: number;
}
/**
 * Expose a real SelectList's private selection state for assertions.
 * SelectList keeps items/selectedIndex private and has no getter for them
 * (only getSelectedItem), so tests need a view: one structural assertion to
 * a named interface, kept in this single helper.
 */
export function selectListView(list: SelectList): SelectListView {
  return list as unknown as SelectListView;
}
