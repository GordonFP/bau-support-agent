# Synthetic CPA POC contract

This is the owned local Responses subset for the 2026-10-22 output-observation
exception. It runs through `postman/simulations/cpa-poc.sim.yaml`. It neither
contacts CPA nor proves actual billing, cancellation or tokenizer behavior.

`POST /v1/responses` requires model `gpt-6.1-sol`, `stream:true`, `store:false`,
the complete input transcript and exactly the two empty-parameter function tools
`logs_read` and `code_search`. `max_output_tokens` is absent. Other endpoints
return 501. Responses select log/code tools from the transcript, then return the
current Simulator draft or PSP report selection. SSE completion contains fixed
synthetic token counts and **no fee**. There is no 4k generation guarantee in this
profile. The existing `responses` mock keeps its separate strict 4k contract.
