# SAIP vLLM engine image
#
# Pinned by tag, not `latest`: every measurement in
# docs/src/content/docs/reference/hardware-profiles.mdx was taken on vLLM 0.31.0, and the
# capability gates behind the 8-bit KV-cache corruption finding are code that has moved
# before. Re-run the profile measurements before bumping this pin.
#
# The engine arguments are NOT baked in. They are rendered per host by
# inference/scripts/generate-engine-args.ts and passed as ENGINE_ARGS, because
# --gpu-memory-utilization must be derived from the card that actually runs this image.
#
# VLLM_BASE is overridable so a host already holding these layers (or air-gapped) can build
# without a ~30 GB pull. The default remains the pinned release.
ARG VLLM_BASE=vllm/vllm-openai:v0.31.0
FROM ${VLLM_BASE}

# ENGINE_ARGS is interpolated by the shell at runtime. Keep ENTRYPOINT empty: the base
# image's `ENTRYPOINT ["vllm","serve"]` would swallow CMD argv, and exec-form JSON arrays
# are not interpolated by Docker — a literal "${ENGINE_ARGS}" string reaches argparse and
# kills every boot.
ENTRYPOINT []
CMD ["/bin/sh", "-c", "exec python3 -m vllm.entrypoints.openai.api_server ${ENGINE_ARGS} --trust-remote-code --enable-auto-tool-choice --tool-call-parser qwen3_coder"]
