import { postmanSimulation } from "./postman-simulation.js";

export function postmanTeams(cli: string) {
  return postmanSimulation(cli, "postman/simulations/teams.sim.yaml", "/teams");
}
