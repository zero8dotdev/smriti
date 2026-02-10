---
id: 7c130ccd
category: architecture
project: 
agent: 
author: zero8
shared_at: 2026-02-10T10:46:25.759Z
tags: ["architecture"]
---
# GPU for LLMs
**user**: What GPU should I use for running local LLMs?
**assistant**: For local LLMs, I recommend an NVIDIA GPU with at least 8GB VRAM. The RTX 3060 12GB or RTX 4060 Ti 16GB are great mid-range options. AMD GPUs work too but have less software support.
**user**: What about Apple Silicon?
**assistant**: Apple Silicon (M1/M2/M3/M4) is excellent for local LLMs. The unified memory architecture means you can run larger models than discrete GPUs with equivalent VRAM. An M2 Pro with 32GB can run 13B models comfortably.