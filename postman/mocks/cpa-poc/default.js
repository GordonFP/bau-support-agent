// Local synthetic CPA wire profile; no real provider/account/billing is used.
process.env.BAU_MOCK_CPA_POC = "1";
require("../responses/server.cjs");
