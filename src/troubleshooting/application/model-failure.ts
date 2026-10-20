export class ModelFailure extends Error {
  constructor(readonly kind: "transient_network" | "denied" | "contract_unverified" | "schema_mismatch" | "invalid_request") {
    super(kind === "transient_network" ? "unavailable" : kind);
  }
}
