# Take-home brief: AI Engineer, Customer Support AI Agent

To be clear upfront: this is strictly an architectural evaluation exercise using a customer support scenario. You retain full ownership and intellectual property rights over your code and repository.

## Objective
Build and deploy a fullstack Customer Support AI Agent that handles customer inquiries across both streaming chat and live voice modes, executes multi-step tool chains, enforces confidence guardrails, and provides real-time observability.

We want to see how you architect modern, stateful AI applications from the ground up, balancing real-time audio/streaming latency, autonomous tool orchestration, and graceful failure recovery.

## Core Technical Requirements

### 1. Dual-Interface UI (Chat & Voice)
- Streaming Chat Interface: Clean web UI (React/Next.js) supporting SSE or WebSockets with real-time step status indicators (e.g., "Searching Knowledge Base...", "Verifying Account Tier...").
- Live Voice Mode: Real-time voice toggle using a multimodal streaming API (e.g., OpenAI Realtime API, Gemini Multimodal Live API, or a fast STT -> LLM -> TTS pipeline) with active audio waveform feedback, live transcripts, and interruption handling.
- Observability Drawer: A collapsible panel showing prompt traces, end-to-end latency metrics, token usage, and estimated API cost.

### 2. RAG & Grounding Engine
- Vector Retrieval: FastAPI or Node.js backend connected to a vector database (e.g., Pinecone, Qdrant, pgvector) with custom document chunking over sample support policies.
- Confidence Guardrails: Explicit similarity threshold or secondary verification checks to prevent hallucinations on out-of-scope queries, routing low-confidence cases to a human escalation state.

### 3. Autonomous Multi-Step Tool Orchestration
- Equip the agent with an autonomous reasoning loop (e.g., LangGraph, Mastra, or a custom state machine) capable of chaining at least 3 mock tool calls:
  - Verify mock user identity, subscription tier, and contract status.
  - Retrieve relevant policy docs or troubleshooting guides based on the user's tier.
  - Execute a simulated action (e.g., issue a mock refund within policy limits, update an account field, or generate a structured escalation ticket).
- Stream live status updates to the UI whenever a tool starts or completes.

### 4. Resilience & State Management
- Error Recovery: Graceful fallback UI states for upstream LLM timeouts, rate limits, or simulated tool failures mid-conversation.
- Session State: Consistent multi-turn memory across both text and voice modes.

## Submission Deliverables
- GitHub Repository: full source code, .env.example, and a concise README.md explaining your architecture, chunking choices, and key trade-offs.
- Live Demo Link: Deployed prototype URL (e.g., Vercel, Render, Railway, AWS).
- Loom Walkthrough (3–5 minutes): screen + webcam video demonstrating live chat and voice interaction (including interruption handling), multi-step tool execution, and a quick walkthrough of your RAG and guardrail logic.

## Evaluation Rubric
- Agentic Architecture & Tool Orchestration (35%): Multi-step reasoning loops, reliable tool chaining, hallucination prevention, and confidence-scoring logic.
- Voice & Real-Time Streaming UX (25%): Smooth bi-directional voice streaming, clean audio waveform/interruption handling, and responsive state indicators.
- Code Quality & System Design (25%): Modular separation between frontend UI, agent orchestrator, tools, and vector store; clean typing.
- Production Readiness (15%): Rate limiting, graceful error recovery, deployment stability, and clear communication in your video walkthrough.

## Time budget (mine)
12 hours total.
