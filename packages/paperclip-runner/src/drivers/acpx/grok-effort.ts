import { createAcpxConfigAdmission } from "./config-admission.js";

export type GrokEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export function resolveGrokEffort(agent: string, value: unknown): GrokEffort | undefined {
  if (value === undefined || value === "") return undefined;
  if (agent !== "grok") throw new Error("Grok effort is only supported by Grok");
  if (value !== "minimal" && value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh") throw new Error("Grok effort must be minimal, low, medium, high, or xhigh");
  return value;
}
export function createGrokEffortAdmission(expected: GrokEffort) {
  return createAcpxConfigAdmission(expected, { label: "Grok effort", configId: "reasoning_effort",
    supportedValues: ["default", "minimal", "low", "medium", "high", "xhigh"] });
}
export function admittedGrokEffort(agent: string, requested: unknown, descriptor: Record<string, unknown>, identity: Record<string, unknown>): GrokEffort | undefined {
  const expected = resolveGrokEffort(agent, requested);
  const effective = resolveGrokEffort(agent, identity.grokEffort);
  if (effective !== expected || descriptor.grokEffort !== expected) throw new Error("Grok effort differs from the admitted configuration");
  return effective;
}
