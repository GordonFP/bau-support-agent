import { postmanSimulation } from "./postman-simulation.js";

export function postmanResponses(cli: string) {
  return postmanSimulation(cli, "postman/simulations/model.sim.yaml", "/responses/v1");
}
