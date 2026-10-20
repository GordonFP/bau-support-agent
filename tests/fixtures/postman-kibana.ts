import { postmanSimulation } from "./postman-simulation.js";

export function postmanKibana(cli: string) {
  return postmanSimulation(cli, "postman/simulations/kibana.sim.yaml", "/kibana");
}
