/**
 * Facts the harness measures and policy consumes.
 *
 * Declared here rather than in the orchestrator so the dependency runs one way:
 * policy never imports the layer it advises. The orchestrator computes these;
 * this package only reads them.
 */

/** What actually changed between two plans, measured rather than reported. */
export interface PlanDelta {
  routesAdded: string[];
  routesRemoved: string[];
  routesRevised: string[];
  brandChanged: boolean;
  acceptanceCriteriaChanged: boolean;
  strategyChanged: boolean;
  valuePropositionChanged: boolean;
}
